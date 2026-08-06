import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';

// 稿件家族：同一篇内容的多平台兄弟稿，以及它们各自的真实表现。
//
// 【为什么需要这个概念】产品叫「跨平台内容作战室」，但在创作端此前不成立：
// Draft.platform 是单值，改写结果只是页面上的一个临时 state，落不了地。
// 用户想「一个选题三个平台各发一版」，只能手动开三份互不相干的草稿——
// 于是「同一篇内容在哪个平台跑赢了」这个最该被回答的问题，系统算不出来。
//
// 血缘用 Draft.parentDraftId 表示，不复用 topicId：用户自己粘进来的稿子根本没有选题，
// 而那恰恰是最常需要一稿多发的一类。

export type FamilyMember = {
  draftId: string;
  platform: string;
  title: string;
  status: string;
  isRoot: boolean;
  /** 该稿是否已登记发布 */
  published: boolean;
  metrics: Metrics | null;
  publishedAt: Date | null;
};

// 家族根：自己就是根（无 parent），或指向的那个 parent。
export async function familyRootId(accountId: string, draftId: string): Promise<string | null> {
  const d = await prisma.draft.findFirst({
    where: { id: draftId, accountId },
    select: { id: true, parentDraftId: true },
  });
  if (!d) return null;
  return d.parentDraftId ?? d.id;
}

// 一个家族的全部成员 + 各自的发布表现。
// 只在**至少两个成员**时才有意义，调用方据此决定要不要渲染对比卡
// （只有一份稿时展示「跨平台对比」是在假装有数据）。
export async function draftFamily(accountId: string, draftId: string): Promise<FamilyMember[]> {
  const rootId = await familyRootId(accountId, draftId);
  if (!rootId) return [];

  const drafts = await prisma.draft.findMany({
    where: { accountId, OR: [{ id: rootId }, { parentDraftId: rootId }] },
    select: { id: true, platform: true, title: true, status: true, parentDraftId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  if (drafts.length === 0) return [];

  const records = await prisma.publishRecord.findMany({
    where: { accountId, draftId: { in: drafts.map((d) => d.id) } },
    select: { draftId: true, metrics: true, publishedAt: true },
    orderBy: { publishedAt: 'desc' },
  });
  // 同一份草稿可能有多条发布记录（补链接/重发），取最近的一条
  const byDraft = new Map<string, (typeof records)[number]>();
  for (const r of records) if (r.draftId && !byDraft.has(r.draftId)) byDraft.set(r.draftId, r);

  return drafts.map((d) => {
    const rec = byDraft.get(d.id);
    const metrics = rec ? parseJson<Metrics>(rec.metrics, {}) : null;
    return {
      draftId: d.id,
      platform: d.platform,
      title: d.title,
      status: d.status,
      isRoot: d.id === rootId,
      published: !!rec,
      // 有记录但零播放 = 数据还没回流，不是「表现为 0」——两者必须能分开，
      // 否则对比卡会把「还没回流」画成「这个平台扑街了」。
      metrics: metrics && (metrics.views ?? 0) > 0 ? metrics : null,
      publishedAt: rec?.publishedAt ?? null,
    };
  });
}

// 已经派生过哪些平台（含自己）——防止重复派生同一平台
export async function familyPlatforms(accountId: string, draftId: string): Promise<string[]> {
  const members = await draftFamily(accountId, draftId);
  return [...new Set(members.map((m) => m.platform))];
}
