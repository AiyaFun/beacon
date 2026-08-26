import { prisma } from '../db';
import { createLogger } from '../logger';
import type { ArtifactKind } from './tools';

const log = createLogger({ module: 'agent-artifact' });

// ── 这次执行做出了什么 ────────────────────────────────────────────────────────
//
// 【确认闸与产物清单是两道互补的闸，不能互相替代】
//   确认闸在**动作之前**：这一步要不要做。
//   产物清单在**动作之后**：做出来的东西对不对。
// 预授权跑完的那些没有前一道，更需要后一道——用户授权的是「你可以建草稿」，
// 不是「你建的每一篇草稿我都认」。

/** 产物点进去看哪一页。加新种类时**必须**在这里给它一个落点，否则就是一条死链。 */
const HREF: Record<ArtifactKind, (refId: string) => string> = {
  draft: (id) => `/studio?draft=${id}`,
  draft_version: (id) => `/studio?draft=${id}`,
  topic: () => '/topics',
  image: () => '/images',
  publish_plan: (id) => `/publish?plan=${id}`,
  schedule: () => '/workflows#schedules',
  browser_task: () => '/runs',
};

const KIND_LABEL: Record<ArtifactKind, string> = {
  draft: '草稿',
  draft_version: '新版本',
  topic: '选题',
  image: '图片',
  publish_plan: '发布计划',
  schedule: '定时计划',
  browser_task: '浏览器任务',
};

export function artifactHref(kind: string, refId: string): string {
  const f = HREF[kind as ArtifactKind];
  // 没登记过的种类不编一个地址出来：指到一个猜的页面比不给链接更糟
  return f ? f(refId) : '';
}

export function artifactKindLabel(kind: string): string {
  return KIND_LABEL[kind as ArtifactKind] ?? kind;
}

/**
 * 记下这一步的产物。**旁路增强**：记不下来只是清单少一条，绝不能影响执行本身。
 *
 * 与 appendStep 同一个理由吞掉外键错误：后台这条线可能比它的记录活得更久
 *（到期清理删了那次运行、工作区被删级联带走了它）。
 */
export async function recordArtifacts(
  runId: string,
  items: readonly { kind: ArtifactKind; refId: string; label: string }[],
): Promise<void> {
  if (items.length === 0) return;
  try {
    await prisma.agentArtifact.createMany({
      data: items.map((a) => ({ runId, kind: a.kind, refId: a.refId, label: a.label.slice(0, 200) })),
    });
  } catch (err) {
    const gone = await prisma.agentRun.count({ where: { id: runId } }).catch(() => 0);
    if (gone > 0) log.warn('产物没记下来', { runId, error: (err as Error).message });
  }
}

export type ArtifactView = { kind: string; kindLabel: string; refId: string; label: string; href: string };

export async function listArtifacts(runId: string): Promise<ArtifactView[]> {
  const rows = await prisma.agentArtifact.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
    select: { kind: true, refId: true, label: true },
  });
  return rows.map((r) => ({
    kind: r.kind,
    kindLabel: artifactKindLabel(r.kind),
    refId: r.refId,
    label: r.label,
    href: artifactHref(r.kind, r.refId),
  }));
}
