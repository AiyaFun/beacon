import { prisma } from '../db';
import { parseJson, type Metrics, hasViews, engagementRate } from '../json';

// 本周内容作战报告的数据装配层 —— /battle 页只负责渲染，取数与口径全在这里。
//
// 【为什么单独一层】这一页把四处已有数据（自有表现 / 选题引擎 / 竞对库 / 低表现作品）
// 拼成一份「今天该做什么」。逻辑放页面里没法测，而这里每一条口径都踩过项目的老坑
// （缺席不许当 0、率型拿不到播放返回 null），必须有守卫钉住 —— 见 tests/battle/report.test.ts。
//
// 【这一版故意只读不写】报告就是把现成数据摆出来；没有推荐时由页面引导用户去跑
// actGenerateRecommendations（那条链路已存在）。不在这里悄悄触发生成：那会让「打开报告」
// 变成一个会花钱、会采集的副作用操作。

const DAY = 86_400_000;

/** 一个指标：value 为 null = 「拿不到」，UI 显示「—」而不是 0（口径见 lib/json.ts）。 */
export type Metric = {
  label: string;
  value: number | null;
  /** 'count' 整数 | 'wan' 万为单位 | 'pct' 百分比 */
  kind: 'count' | 'wan' | 'pct';
  /** 环比变化（百分点或百分比），null = 没有可比的上一周 */
  delta: number | null;
  deltaUnit: 'pct' | 'pt';
  sub: string;
};

export type BattleIdea = {
  id: string;
  title: string;
  angle: string;
  personaFit: number | null;
  blueSeaPct: number | null;
  windowHint: string | null;
  reason: string | null;
  queue: string;
};

export type BattleFix = {
  id: string;
  title: string;
  platform: string;
  completion: number | null;
  engagement: number | null;
  diagnosis: string;
};

export type BattleRival = {
  name: string;
  platform: string;
  title: string;
  views: number | null;
  url: string | null;
};

export type BattleReport = {
  hasRecommendations: boolean;
  metrics: Metric[];
  ideas: BattleIdea[];
  fixes: BattleFix[];
  rivals: BattleRival[];
  recentWorks: { title: string; platform: string; views: number | null; at: Date }[];
  counts: { ownWorks7d: number; watchedRivals: number };
};

function sumViews(records: { metrics: string }[]): number | null {
  let total = 0;
  let any = false;
  for (const r of records) {
    const m = parseJson<Metrics>(r.metrics, {});
    if (hasViews(m)) {
      total += m.views as number;
      any = true;
    }
  }
  return any ? total : null; // 一条都没有播放量 = 拿不到，不是 0
}

function avgCompletion(records: { metrics: string }[]): number | null {
  const vals: number[] = [];
  for (const r of records) {
    const c = parseJson<Metrics>(r.metrics, {}).completion;
    if (typeof c === 'number' && Number.isFinite(c)) vals.push(c);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** 聚合互动率 = Σ互动 / Σ播放，只算有播放量的那些；一条都没有 → null。 */
function aggEngagement(records: { metrics: string }[]): number | null {
  let inter = 0;
  let views = 0;
  let any = false;
  for (const r of records) {
    const m = parseJson<Metrics>(r.metrics, {});
    if (hasViews(m)) {
      inter += (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.collects ?? 0);
      views += m.views as number;
      any = true;
    }
  }
  return any && views > 0 ? inter / views : null;
}

function pctDelta(now: number | null, prev: number | null): number | null {
  if (now === null || prev === null || prev <= 0) return null;
  return ((now - prev) / prev) * 100;
}

/**
 * 给周一推送用的**极轻量**摘要：本周有几条高潜选题待起稿、最靠前那条是什么。
 *
 * 不复用 buildBattleReport —— 那个要查表现/趋势/竞对四处，推送只需要「有没有事做 + 头一条」。
 * 返回 null = 没有待起稿的选题，这时推送里**不追加**作战一行（没事硬推是打扰）。
 */
export async function buildBattleDigest(accountId: string): Promise<{ count: number; topTitle: string } | null> {
  const ideas = await prisma.topicIdea.findMany({
    where: { accountId, state: 'recommended' },
    orderBy: { totalScore: 'desc' },
    take: 1,
    select: { title: true },
  });
  if (ideas.length === 0) return null;
  const count = await prisma.topicIdea.count({ where: { accountId, state: 'recommended' } });
  return { count, topTitle: ideas[0].title };
}

export async function buildBattleReport(workspaceId: string, accountId: string): Promise<BattleReport> {
  const now = Date.now();
  const since7 = new Date(now - 7 * DAY);
  const since14 = new Date(now - 14 * DAY);

  const [recs7, recsPrev, ideas, watch] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId, publishedAt: { gte: since7 } },
      orderBy: { publishedAt: 'desc' },
      select: { id: true, title: true, platform: true, metrics: true, publishedAt: true, draftId: true },
    }),
    prisma.publishRecord.findMany({
      where: { accountId, publishedAt: { gte: since14, lt: since7 } },
      select: { metrics: true },
    }),
    prisma.topicIdea.findMany({
      where: { accountId, state: 'recommended' },
      orderBy: { totalScore: 'desc' },
      take: 3,
      select: {
        id: true, title: true, angle: true, scores: true, blueSea: true,
        windowHint: true, evidence: true, rationale: true, queue: true,
      },
    }),
    prisma.watchlistItem.findMany({
      where: { workspaceId },
      select: { competitor: { select: { id: true, name: true, platform: true } } },
    }),
  ]);

  // ── 指标行（诚实：拿不到给 null）──
  const views7 = sumViews(recs7);
  const viewsPrev = sumViews(recsPrev);
  const comp7 = avgCompletion(recs7);
  const eng7 = aggEngagement(recs7);
  const metrics: Metric[] = [
    { label: '近7天播放', value: views7, kind: 'wan', delta: pctDelta(views7, viewsPrev), deltaUnit: 'pct', sub: '仅统计能拿到播放量的作品' },
    { label: '更新条数', value: recs7.length, kind: 'count', delta: null, deltaUnit: 'pct', sub: '近 7 天已发布' },
    {
      label: '平均完播率', value: comp7 === null ? null : comp7 * 100, kind: 'pct',
      delta: comp7 === null ? null : (comp7 * 100 - 40), deltaUnit: 'pt', sub: '健康线约 40%',
    },
    { label: '互动率', value: eng7 === null ? null : eng7 * 100, kind: 'pct', delta: null, deltaUnit: 'pt', sub: '赞藏评转/播放' },
  ];

  // ── 高潜选题 ──
  const battleIdeas: BattleIdea[] = ideas.map((t) => {
    const sc = parseJson<{ personaFit?: number }>(t.scores, {});
    // 「为什么给你」优先用 evidence（候选源产出的事实，非编造），退到 rationale
    const reason = (t.evidence && t.evidence.trim()) || (t.rationale && t.rationale.trim()) || null;
    return {
      id: t.id,
      title: t.title,
      angle: t.angle,
      personaFit: typeof sc.personaFit === 'number' ? sc.personaFit : null,
      blueSeaPct: typeof t.blueSea === 'number' ? Math.round(t.blueSea * 100) : null,
      windowHint: t.windowHint,
      reason,
      queue: t.queue,
    };
  });

  // ── 低表现作品（有完播率且低于健康线；缺完播率的用低互动兜底）──
  const fixes: BattleFix[] = recs7
    .map((r) => {
      const m = parseJson<Metrics>(r.metrics, {});
      const completion = typeof m.completion === 'number' ? m.completion : null;
      const eng = engagementRate(m);
      return { r, m, completion, eng };
    })
    .filter(({ completion, eng }) => (completion !== null && completion < 0.4) || (completion === null && eng !== null && eng < 0.02))
    .slice(0, 2)
    .map(({ r, completion, eng }) => ({
      id: r.id,
      title: r.title ?? '（未命名作品）',
      platform: r.platform,
      completion,
      engagement: eng,
      diagnosis:
        completion !== null && completion < 0.4
          ? `完播率 ${(completion * 100).toFixed(0)}%，低于健康线——多半卡在开头。换个「先给结论」的前 3 秒钩子，同题材高完播的都这么开。`
          : `互动率偏低——标题/封面没勾住人。改标题或重做封面，成本最低、见效最快。`,
    }));

  // ── 对标本周动向 Top5 ──
  const compIds = watch.map((w) => w.competitor.id);
  const nameOf = new Map(watch.map((w) => [w.competitor.id, w.competitor.name]));
  let rivals: BattleRival[] = [];
  if (compIds.length) {
    const posts = await prisma.crawledPost.findMany({
      where: { competitorId: { in: compIds }, publishedAt: { gte: since14 } },
      orderBy: { publishedAt: 'desc' },
      take: 60,
      select: { competitorId: true, platform: true, title: true, url: true, metrics: true },
    });
    rivals = posts
      .map((p) => {
        const m = parseJson<Metrics>(p.metrics, {});
        return {
          name: nameOf.get(p.competitorId) ?? '对标账号',
          platform: p.platform,
          title: p.title,
          views: hasViews(m) ? (m.views as number) : null,
          url: p.url,
          _v: hasViews(m) ? (m.views as number) : -1,
        };
      })
      .sort((a, b) => b._v - a._v)
      .slice(0, 5)
      .map(({ _v, ...rest }) => rest);
  }

  const recentWorks = recs7.slice(0, 7).map((r) => {
    const m = parseJson<Metrics>(r.metrics, {});
    return { title: r.title ?? '（未命名）', platform: r.platform, views: hasViews(m) ? (m.views as number) : null, at: r.publishedAt };
  });

  return {
    hasRecommendations: battleIdeas.length > 0,
    metrics,
    ideas: battleIdeas,
    fixes,
    rivals,
    recentWorks,
    counts: { ownWorks7d: recs7.length, watchedRivals: compIds.length },
  };
}
