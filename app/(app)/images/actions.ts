'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';
import { DemoReadonlyError } from '@/lib/demo/guard';
import { runIllustration, MAX_ILLUSTRATIONS } from '@/lib/illustration/run';
import { listGenerated, deleteMediaAsset, setMediaPinned } from '@/lib/media/store';

// 出图工位（不绑草稿）的 server action 层。
//
// 【与创作工坊那两处的分工】工坊里的「标题与封面」是**给这一篇**出封面（要上字），
// 「正文配图」是**按这一篇的正文**拆画面。这里是第三种需求：手头没有稿子，
// 就是想要几张图（选题配图、账号主页头图、素材备用）。
//
// 【一个字都不重写】出图仍走 runIllustration → llmImage：同一套配额、预算、
// 红线闸、AIGC 打标、落库回收。这里只负责把「用户手写的几句画面」变成 scenes。
// 在这儿另起一条出图路径，等于开一个不打 AIGC 标识的后门。

export type FreeImageResult = {
  ok: boolean;
  images?: { id?: string; url: string; scene: string; aigcEmbedded: boolean }[];
  error?: string;
};

function designed(e: unknown): string | null {
  if (e instanceof QuotaExceededError || e instanceof RbacError || e instanceof DemoReadonlyError) return e.message;
  return null;
}

export async function actRunFreeImages(input: {
  /** 一行一张：每行就是一张图的画面描述 */
  scenes: string[];
  styleKey?: string;
  specKey?: string;
  extra?: string;
  referenceAssetIds?: string[];
}): Promise<FreeImageResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create'); // 出图花钱，与创作动作同一道闸
    const scenes = input.scenes
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, MAX_ILLUSTRATIONS)
      .map((scene) => ({ scene: scene.slice(0, 300) }));
    if (scenes.length === 0) return { ok: false, error: '先写至少一句画面描述（一行一张）。' };

    const r = await runIllustration({
      tenantId: s.tenantId,
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      // 不挂草稿：这批图属于工作区素材，删草稿不该把它们带走
      draftId: null,
      // 比例由用户在界面上选；platform 只在没选比例时用来推默认值
      platform: '',
      specKey: input.specKey,
      styleKey: input.styleKey,
      scenes,
      extra: input.extra,
      referenceAssetIds: input.referenceAssetIds,
    });
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath('/images');
    return {
      ok: true,
      images: r.images.map((i) => ({ id: i.id, url: i.url, scene: i.scene, aigcEmbedded: i.aigcEmbedded })),
    };
  } catch (e) {
    const msg = designed(e);
    return { ok: false, error: msg ?? (e as Error).message.slice(0, 200) };
  }
}

export type GalleryItem = {
  id: string;
  url: string;
  kind: string;
  label: string | null;
  pinned: boolean;
  draftId: string | null;
  scene: string;
  createdAt: string;
};

export async function actListGenerated(): Promise<GalleryItem[]> {
  const s = await getSession();
  const rows = await listGenerated(s.workspaceId, { take: 24 });
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    kind: r.kind,
    label: r.label,
    pinned: r.pinned,
    draftId: r.draftId,
    scene: typeof r.meta.scene === 'string' ? r.meta.scene : '',
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function actPinGenerated(id: string, pinned: boolean): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const ok = await setMediaPinned(s.workspaceId, id, pinned);
  if (!ok) return { ok: false, error: '这张图不在当前工作区' };
  revalidatePath('/images');
  return { ok: true };
}

export async function actDeleteGenerated(id: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const ok = await deleteMediaAsset(s.workspaceId, id);
  if (!ok) return { ok: false, error: '这张图不在当前工作区' };
  revalidatePath('/images');
  return { ok: true };
}
