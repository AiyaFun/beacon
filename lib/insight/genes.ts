import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';
import { platformName, TOPIC_SOURCE_LABEL } from '../constants';
import { hourSlot } from './timing';

// 爆款基因画像：把「这个账号什么样的内容跑得好」从散落各处的隐性结论，变成一页可见的资产。
//
// 【为什么值得单独做一页】系统里其实一直在学（learn.ts 写指纹、写 angleProven 记忆、
// 复盘回写选题），但这些结论只在 LLM 的 prompt 里流动——**用户自己看不见**。
// 看不见就没有信任：他无法判断「越用越懂我」是真的还是话术。这一页把账本摊开。
//
// 【一条硬纪律：胜率只按真实数据算，样本不足就明说不下结论】
// 每个维度的「胜率」= 该桶里跑赢账号同平台均播的作品占比。这是个可验算的数，
// 不是评分、不是模型判断。样本 < MIN_SAMPLE 的桶照常展示条数，但**不给胜率**——
// 2 条里赢 1 条不是 50% 胜率，是没有结论。

// 与 learn.ts / timing.ts 同一条样本线：3 条以下不下结论。
const MIN_SAMPLE = 3;
// 只看近半年：更早的内容平台环境已经变了，把它算进「你现在的基因」会误导。
const WINDOW_DAYS = 180;

export type GeneBucket = {
  key: string;
  label: string;
  sample: number;
  wins: number;
  // 胜率（0-1）。样本不足时为 null——「没有结论」和「胜率 0」必须能分开。
  winRate: number | null;
  avgRatio: number; // 该桶平均「本条播放 ÷ 该平台账号均播」
};

export type GeneDimension = {
  key: string;
  name: string;
  hint: string;
  buckets: GeneBucket[];
  // 该维度是否有任何达样本线的桶（没有就整块显示「数据还不够」）
  conclusive: boolean;
};

export type GeneProfile = {
  sample: number; // 参与统计的作品总数
  windowDays: number;
  dimensions: GeneDimension[];
  // 达样本线的桶里表现最好的那个，用于页面顶部一句话结论；没有则 null
  headline: { dimension: string; label: string; winRate: number; sample: number } | null;
};

type Row = {
  platform: string;
  /** 只收有发布时间的：基因分析要回答「什么时候发、隔多久发」，缺了它无从谈起 */
  publishedAt: Date;
  views: number;
  sourceType: string | null;
  angle: string | null;
};

const CN_OFFSET_H = 8;

// 纯函数核心：作品行 + 各平台均播 → 画像。抽出来是为了让「胜率怎么算、样本线怎么卡」
// 能被单测钉死，不必造一堆库数据。
export function buildGeneProfile(rows: Row[], avgByPlatform: Map<string, number>): GeneProfile {
  // 只统计「有播放数 且 该平台有均播基线」的作品——没有基线就没有「赢没赢」可言
  const usable = rows.filter((r) => r.views > 0 && (avgByPlatform.get(r.platform) ?? 0) > 0);

  const dim = (
    key: string,
    name: string,
    hint: string,
    keyOf: (r: Row) => { key: string; label: string } | null,
  ): GeneDimension => {
    const acc = new Map<string, { label: string; ratios: number[] }>();
    for (const r of usable) {
      const k = keyOf(r);
      if (!k) continue;
      const base = avgByPlatform.get(r.platform)!;
      const cur = acc.get(k.key) ?? { label: k.label, ratios: [] };
      cur.ratios.push(r.views / base);
      acc.set(k.key, cur);
    }
    const buckets: GeneBucket[] = [...acc.entries()]
      .map(([k, v]) => {
        const wins = v.ratios.filter((x) => x >= 1).length;
        return {
          key: k,
          label: v.label,
          sample: v.ratios.length,
          wins,
          winRate: v.ratios.length >= MIN_SAMPLE ? wins / v.ratios.length : null,
          avgRatio: v.ratios.reduce((a, b) => a + b, 0) / v.ratios.length,
        };
      })
      // 有结论的排前面，其次按胜率、再按样本量
      .sort(
        (a, b) =>
          Number(b.winRate !== null) - Number(a.winRate !== null) ||
          (b.winRate ?? 0) - (a.winRate ?? 0) ||
          b.sample - a.sample,
      );
    return { key, name, hint, buckets, conclusive: buckets.some((b) => b.winRate !== null) };
  };

  const dimensions = [
    dim('source', '选题来源', '八种候选源里，哪一类在你账号上真的跑得动', (r) =>
      r.sourceType
        ? { key: r.sourceType, label: TOPIC_SOURCE_LABEL[r.sourceType]?.name ?? r.sourceType }
        : null,
    ),
    dim('platform', '平台', '同样的内容，在哪个平台更容易起来', (r) => ({
      key: r.platform,
      label: platformName(r.platform),
    })),
    dim('slot', '发布时段', '按北京时间折算的发布时段', (r) => {
      const h = (r.publishedAt.getUTCHours() + CN_OFFSET_H) % 24;
      return hourSlot(h);
    }),
    dim('angle', '切入角', '被数据验证过的表达角度（同一角度 3 条起才下结论）', (r) => {
      const a = r.angle?.trim();
      if (!a) return null;
      const key = a.slice(0, 30);
      return { key, label: key };
    }),
  ];

  // 头条结论：所有维度里达样本线且胜率最高的那个桶
  let headline: GeneProfile['headline'] = null;
  for (const d of dimensions) {
    for (const b of d.buckets) {
      if (b.winRate === null) continue;
      if (!headline || b.winRate > headline.winRate || (b.winRate === headline.winRate && b.sample > headline.sample)) {
        headline = { dimension: d.name, label: b.label, winRate: b.winRate, sample: b.sample };
      }
    }
  }

  return { sample: usable.length, windowDays: WINDOW_DAYS, dimensions, headline };
}

// 取数入口。发布记录带选题归因时才拿得到来源与切入角（topicId 是松引用，可能已被删）。
export async function loadGeneProfile(accountId: string): Promise<GeneProfile> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const records = await prisma.publishRecord.findMany({
    where: { accountId, publishedAt: { gte: since } },
    orderBy: { publishedAt: 'desc' },
    take: 200,
    select: { platform: true, publishedAt: true, metrics: true, topicId: true },
  });
  if (records.length === 0) {
    return buildGeneProfile([], new Map());
  }

  const topicIds = [...new Set(records.map((r) => r.topicId).filter((x): x is string => !!x))];
  const topics = topicIds.length
    ? await prisma.topicIdea.findMany({
        where: { id: { in: topicIds } },
        select: { id: true, sourceType: true, angle: true },
      })
    : [];
  const byTopic = new Map(topics.map((t) => [t.id, t]));

  // 【没有发布时间的不进基因分析】这里算的是「什么时候发、隔多久发、什么角度跑得好」，
  // 三个问题里两个直接依赖发布时间。把它们按回填当天算进去，等于用一批假时间训练结论。
  const rows: Row[] = records
    .filter((r): r is typeof r & { publishedAt: Date } => r.publishedAt !== null)
    .map((r) => {
    const t = r.topicId ? byTopic.get(r.topicId) : undefined;
    return {
      platform: r.platform,
      publishedAt: r.publishedAt,
      views: parseJson<Metrics>(r.metrics, {}).views ?? 0,
      sourceType: t?.sourceType ?? null,
      angle: t?.angle ?? null,
    };
  });

  // 各平台均播基线：用**同一批作品**自己算，而不是另取一份。
  // 「跑赢自己」的分母必须和分子来自同一个窗口，否则拿半年前的高基线去比最近的作品，
  // 会把一个正常账号系统性地判成「一直在输」。
  const byPlatform = new Map<string, number[]>();
  for (const r of rows) {
    if (r.views <= 0) continue;
    const list = byPlatform.get(r.platform);
    if (list) list.push(r.views);
    else byPlatform.set(r.platform, [r.views]);
  }
  const avgByPlatform = new Map<string, number>();
  for (const [p, views] of byPlatform) {
    avgByPlatform.set(p, views.reduce((a, b) => a + b, 0) / views.length);
  }

  return buildGeneProfile(rows, avgByPlatform);
}
