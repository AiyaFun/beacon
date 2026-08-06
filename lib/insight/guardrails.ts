import { prisma } from '../db';
import { textShingles } from '../topic/scoring';

// 数据看板「不能踩的安全线」里两条长期占位的指标，2026-07-30 落地为**真算**。
//
// 为什么之前是占位：PRD F4-6 的原口径是「同赛道推荐重合率」——**跨租户**的平台级指标
// （所有做同一赛道的用户是不是被推了雷同选题）。单租户视角算不出那个数，
// 当时的决定是宁可写「暂无数据」也不硬造，那个决定是对的。
//
// 现在换成两条**在本工作区内真实可算、且对用户真有用**的线，并在文案里说清它量的是什么：
//   · 撞题率：推给你的选题里，有多少条在你监控的竞对那边已经有近似作品了（越低越差异化）。
//     它不是平台级同质化的替身，但它回答了用户真正关心的那个问题：「我这条会不会撞车」。
//   · 合规误报率：合规拦下来的命中里，有多少被你标成了误报（越低说明词库越准）。
//     数据来自 ComplianceFeedback（F6-8 的误报反馈），一条反馈都没有时如实说「还没有反馈」。

/** 两个 shingle 集合的 Jaccard 相似度。空集视为 0（不是 1——两条都没内容不叫「像」）。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 判定「撞题」的相似度阈值。0.34 是 2-gram Jaccard 上「同一件事的两种说法」的经验分界。 */
export const CLASH_THRESHOLD = 0.34;

export type GuardrailValue =
  | { state: 'ok'; pct: number; sample: number; note: string }
  | { state: 'insufficient'; note: string };

/**
 * 撞题率：近 `days` 天推给本账号的选题中，与**已监控竞对**近 30 天作品高度相似的比例。
 * 样本 < 5 条选题时不出数（小样本下的百分比是噪声，出了反而误导）。
 */
export async function topicClashRate(
  workspaceId: string,
  accountId: string | null | undefined,
  days = 14,
): Promise<GuardrailValue> {
  const since = new Date(Date.now() - days * 86400_000);
  const topics = await prisma.topicIdea.findMany({
    where: { ...(accountId ? { accountId } : { account: { workspaceId } }), createdAt: { gte: since } },
    select: { title: true },
    take: 200,
  });
  if (topics.length < 5) {
    return { state: 'insufficient', note: `近 ${days} 天推荐不足 5 条，样本太小不出数` };
  }

  // 只跟**本工作区订阅的**竞对比（WatchlistItem 就是订阅关系表）。CompetitorAccount 是全局共享表，
  // 拿没订阅的号来算，等于用别人的监控范围评判你的差异化。
  const subs = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    select: { competitorId: true },
  });
  if (subs.length === 0) {
    return { state: 'insufficient', note: '还没订阅竞对，无从比较（去竞对监控加几个号）' };
  }
  const rivalPosts = await prisma.crawledPost.findMany({
    where: {
      competitorId: { in: subs.map((s) => s.competitorId) },
      publishedAt: { gte: new Date(Date.now() - 30 * 86400_000) },
    },
    select: { title: true },
    take: 800,
  });
  if (rivalPosts.length < 10) {
    return { state: 'insufficient', note: '竞对近 30 天作品不足 10 条，先多采一些再看' };
  }

  const rivalShingles = rivalPosts.map((p) => textShingles(p.title ?? ''));
  let clashed = 0;
  for (const t of topics) {
    const ts = textShingles(t.title ?? '');
    if (rivalShingles.some((rs) => jaccard(ts, rs) >= CLASH_THRESHOLD)) clashed++;
  }
  const pct = Math.round((clashed / topics.length) * 100);
  return {
    state: 'ok',
    pct,
    sample: topics.length,
    note: `${clashed}/${topics.length} 条与竞对近作高度相似 · 目标 <30%`,
  };
}

/**
 * 合规误报率：近 `days` 天里被标为误报（且已采纳）的反馈数 ÷ 同期合规命中数。
 * 一条命中都没有时不出数——0/0 显示成 0% 会让人以为「词库很准」。
 */
export async function complianceFalsePositiveRate(tenantId: string, days = 30): Promise<GuardrailValue> {
  const since = new Date(Date.now() - days * 86400_000);
  const [checks, feedback] = await Promise.all([
    prisma.complianceCheck.findMany({
      where: { checkedAt: { gte: since }, draft: { account: { workspace: { tenantId } } } },
      select: { hits: true },
      take: 1000,
    }),
    prisma.complianceFeedback.count({ where: { tenantId, createdAt: { gte: since }, status: 'accepted' } }),
  ]);
  // 命中数按「每次检测命中的词条数」累加：误报是针对某个词的，分母也该是词次
  let hitCount = 0;
  for (const c of checks) {
    try {
      const arr = JSON.parse(c.hits || '[]');
      if (Array.isArray(arr)) hitCount += arr.length;
    } catch {
      /* 脏 JSON 不该让整块指标崩掉，跳过这条 */
    }
  }
  if (hitCount === 0) {
    return { state: 'insufficient', note: `近 ${days} 天没有合规命中记录，暂无从统计` };
  }
  const pct = Math.round((Math.min(feedback, hitCount) / hitCount) * 100);
  return {
    state: 'ok',
    pct,
    sample: hitCount,
    note: `${feedback} 条被判定为误报 / ${hitCount} 次命中 · 越低越好`,
  };
}
