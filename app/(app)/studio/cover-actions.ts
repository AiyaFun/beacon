'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import {
  saveMediaAsset,
  listLibrary,
  listDraftCovers,
  deleteMediaAsset,
  setMediaPinned,
  type MediaAssetSummary,
  type MediaKind,
  LIBRARY_KINDS,
} from '@/lib/media/store';
import { MAX_REFERENCE_BYTES } from '@/lib/cover/rules';

// 「我的风格库」每个工作区最多存几档。跟形象库一个量级：再多用户自己也挑不过来。
const MAX_STYLE_PRESETS = 20;

// 封面工位的「记住」这一半：形象库（存进来的人像/背景/品牌元素）、本稿封面历史、设为本稿封面。
//
// 为什么这些走 server action 而生成走 Route Handler：生成要传参考图（几百 KB × 3）+ 要 SSE 进度，
// 两样 server action 都做不好（1MB 请求体上限 + 60s 墙钟）。而这里传的是 id 与一张已经在浏览器里
// 压好的小图，走 action 更省事，也自动带上了 revalidate。

export type CoverLibraryResult = { ok: true; assets: MediaAssetSummary[] } | { ok: false; error: string };

/** 存一张参考图进「我的形象」。dataUrl 是浏览器压缩后的（≤1MB，见 lib/cover/client-image.ts）。 */
export async function actSaveLibraryAsset(
  dataUrl: string,
  kind: MediaKind,
  opts?: { label?: string; consented?: boolean },
): Promise<CoverLibraryResult> {
  const s = await getSession();
  requireRole(s, 'content.create');
  if (!LIBRARY_KINDS.includes(kind)) return { ok: false, error: '不支持的素材类型' };

  const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i.exec(dataUrl ?? '');
  if (!m) return { ok: false, error: '只支持 PNG / JPEG / WebP 图片' };
  const bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
  if (bytes.length > MAX_REFERENCE_BYTES) {
    return { ok: false, error: `单张不能超过 ${MAX_REFERENCE_BYTES / 1024 / 1024}MB（页面会自动压缩，换张小点的试试）` };
  }

  const r = await saveMediaAsset({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    kind,
    mime: m[1].toLowerCase(),
    bytes,
    label: opts?.label,
    // 服务端重算：前端显示过勾选框不等于用户勾了（saveMediaAsset 对 portrait 会再拦一次）
    consented: opts?.consented === true,
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath('/studio');
  return { ok: true, assets: await listLibrary(s.workspaceId, s.accountId) };
}

export async function actListLibrary(): Promise<CoverLibraryResult> {
  const s = await getSession();
  return { ok: true, assets: await listLibrary(s.workspaceId, s.accountId) };
}

export async function actDeleteAsset(id: string): Promise<CoverLibraryResult> {
  const s = await getSession();
  requireRole(s, 'content.create');
  await deleteMediaAsset(s.workspaceId, id);
  revalidatePath('/studio');
  return { ok: true, assets: await listLibrary(s.workspaceId, s.accountId) };
}

export type CoverHistoryResult = { ok: true; covers: MediaAssetSummary[]; coverAssetId: string | null } | { ok: false; error: string };

/** 本稿封面历史（最近 12 张）。 */
export async function actDraftCovers(draftId: string): Promise<CoverHistoryResult> {
  const s = await getSession();
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    select: { id: true, coverAssetId: true },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };
  return { ok: true, covers: await listDraftCovers(s.workspaceId, draft.id), coverAssetId: draft.coverAssetId };
}

/**
 * 把某张封面设为这篇稿子的封面。同时钉住它——「选定的封面」不该被保留期清理悄悄删掉，
 * 那会让用户下次回来发现这篇稿子的封面没了，而他什么都没做。
 */
export async function actSetDraftCover(draftId: string, assetId: string | null): Promise<CoverHistoryResult> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const draft = await prisma.draft.findFirst({ where: { id: draftId, accountId: s.accountId }, select: { id: true } });
  if (!draft) return { ok: false, error: '草稿不存在' };
  if (assetId) {
    const owned = await prisma.mediaAsset.findFirst({
      where: { id: assetId, workspaceId: s.workspaceId, kind: 'cover' },
      select: { id: true },
    });
    if (!owned) return { ok: false, error: '这张封面不存在' };
    await setMediaPinned(s.workspaceId, assetId, true);
  }
  await prisma.draft.update({ where: { id: draft.id }, data: { coverAssetId: assetId } });
  revalidatePath('/studio');
  return { ok: true, covers: await listDraftCovers(s.workspaceId, draft.id), coverAssetId: assetId };
}

/** 把生成出来的某张封面存进形象库（当以后可复用的素材：比如做成系列封面的底）。 */
export async function actPinAsset(id: string, pinned: boolean): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const done = await setMediaPinned(s.workspaceId, id, pinned);
  if (!done) return { ok: false, error: '这张图不存在' };
  revalidatePath('/studio');
  return { ok: true };
}

// ── 我的风格库（自定义封面风格）──
//
// 内置 16 档覆盖不了每个人心里那个具体的样子。这里存的是**用户自己写的一句话描述**，
// 原样进提示词（见 lib/cover/prompt.ts 的 customStyle）——不替他"AI 扩写"：扩写要花钱、会走样，
// 而且他明明已经说清楚要什么了。风格 key 的约定：`custom:<id>`。

export type StylePreset = { id: string; name: string; description: string };
export type StylePresetResult = { ok: true; presets: StylePreset[] } | { ok: false; error: string };

export async function actListStylePresets(): Promise<StylePresetResult> {
  const s = await getSession();
  const rows = await prisma.coverStylePreset.findMany({
    where: { workspaceId: s.workspaceId },
    orderBy: { createdAt: 'desc' },
    take: MAX_STYLE_PRESETS,
    select: { id: true, name: true, description: true },
  });
  return { ok: true, presets: rows };
}

export async function actSaveStylePreset(name: string, description: string): Promise<StylePresetResult> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const n = (name ?? '').trim().slice(0, 20);
  const d = (description ?? '').trim().slice(0, 600);
  if (!n) return { ok: false, error: '给这个风格起个名字' };
  if (d.length < 8) return { ok: false, error: '描述写具体一点：配色、背景、文字怎么排、什么氛围' };
  const used = await prisma.coverStylePreset.count({ where: { workspaceId: s.workspaceId } });
  if (used >= MAX_STYLE_PRESETS) return { ok: false, error: `最多存 ${MAX_STYLE_PRESETS} 档，先删掉几个不用的` };
  await prisma.coverStylePreset.create({ data: { workspaceId: s.workspaceId, name: n, description: d } });
  revalidatePath('/studio');
  return actListStylePresets();
}

export async function actDeleteStylePreset(id: string): Promise<StylePresetResult> {
  const s = await getSession();
  requireRole(s, 'content.create');
  await prisma.coverStylePreset.deleteMany({ where: { id, workspaceId: s.workspaceId } });
  revalidatePath('/studio');
  return actListStylePresets();
}
