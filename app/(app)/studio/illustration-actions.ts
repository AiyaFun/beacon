'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';
import { DemoReadonlyError } from '@/lib/demo/guard';
import { planScenes, runIllustration, MAX_ILLUSTRATIONS, type IllustrationScene } from '@/lib/illustration/run';
import { listDraftIllustrations } from '@/lib/media/store';

// 正文配图（组图）。与封面共用同一套配额/预算/打标闸，这里只做「拆画面 → 出图 → 落库」的编排。

export type SceneResult = { ok: boolean; scenes?: IllustrationScene[]; error?: string };

function designed(e: unknown): string | null {
  if (e instanceof QuotaExceededError || e instanceof RbacError || e instanceof DemoReadonlyError) return e.message;
  return null;
}

/** 让 AI 从正文拆一组画面。**不出图**——先让用户看清要画什么，再决定花不花这笔钱。 */
export async function actPlanIllustrationScenes(draftId: string, count: number): Promise<SceneResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const draft = await prisma.draft.findFirst({
      where: { id: draftId, accountId: s.accountId },
      include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
    });
    if (!draft) return { ok: false, error: '草稿不存在' };
    const content = draft.versions[0]?.content ?? '';
    if (!content.trim()) return { ok: false, error: '这篇稿子还没有正文，先写点内容再拆画面' };

    const scenes = await planScenes(s.tenantId, {
      title: draft.title,
      content,
      count: Math.min(Math.max(1, count), MAX_ILLUSTRATIONS),
      platform: draft.platform,
    });
    if (scenes.length === 0) {
      // planScenes 在 Mock 模型下会返回空——这里如实说，别让用户以为是正文的问题
      return { ok: false, error: '没能拆出画面清单。若还没接入真实模型，可以自己写几句画面描述再生成。' };
    }
    return { ok: true, scenes };
  } catch (e) {
    const msg = designed(e);
    return { ok: false, error: msg ?? (e as Error).message.slice(0, 200) };
  }
}

export type IllustrationRunResult = {
  ok: boolean;
  images?: { id?: string; url: string; scene: string; anchor?: string; aigcEmbedded: boolean }[];
  error?: string;
};

export async function actRunIllustration(input: {
  draftId: string;
  scenes: IllustrationScene[];
  styleKey?: string;
  specKey?: string;
  extra?: string;
  referenceAssetIds?: string[];
}): Promise<IllustrationRunResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const draft = await prisma.draft.findFirst({ where: { id: input.draftId, accountId: s.accountId } });
    if (!draft) return { ok: false, error: '草稿不存在' };

    const r = await runIllustration({
      tenantId: s.tenantId,
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      draftId: draft.id,
      platform: draft.platform,
      specKey: input.specKey,
      styleKey: input.styleKey,
      scenes: input.scenes,
      extra: input.extra,
      referenceAssetIds: input.referenceAssetIds,
    });
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath('/studio');
    return {
      ok: true,
      images: r.images.map((i) => ({ id: i.id, url: i.url, scene: i.scene, anchor: i.anchor, aigcEmbedded: i.aigcEmbedded })),
    };
  } catch (e) {
    const msg = designed(e);
    return { ok: false, error: msg ?? (e as Error).message.slice(0, 200) };
  }
}

export async function actListIllustrations(draftId: string) {
  const s = await getSession();
  const rows = await listDraftIllustrations(s.workspaceId, draftId);
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    scene: typeof r.meta.scene === 'string' ? r.meta.scene : '',
    anchor: typeof r.meta.anchor === 'string' ? r.meta.anchor : '',
  }));
}
