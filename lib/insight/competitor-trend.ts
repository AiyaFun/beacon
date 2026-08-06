import { parseJson, type Metrics, type MetricCountKey } from '../json';

// 竞对作品趋势（纯函数）。数据源是 PostMetricSnapshot——两条通道都写：
//   · 定时采集   lib/pipeline.ts crawlOneCompetitor
//   · 插件回传   lib/ingest/competitor.ts
// 两边都只在「指标真的变了」时落一条，所以快照序列天然是去重后的观测点。
//
// ⚠️ 与自有作品趋势（timeseries.ts）**刻意不共用**一套坐标系，原因是两者的诚实度不同：
//   自有作品有 milestone 标签（D+1..D+30），逐日密度由回流机制保证，可以画「发布后第 N 天」；
//   竞对作品只有采集时间，采集节奏由用户什么时候点采集决定——今天采一次、下周采一次很常见。
//   把这种散点按「发布后第 N 天」画成曲线，等于拿采集节奏冒充内容的增长曲线。
// 所以这里的 X 轴是**观测序号**（第几次采到），并如实标注每个点的日期与间隔天数。
//
// 另一个现实约束：CrawledPost.publishedAt 可空（多数通道拿不到发布时间），
// 不能作为坐标原点。origin 字段把「有没有发布时间」这件事显式暴露给 UI，别在 UI 里猜。

export type CompetitorSnapshotInput = {
  takenAt: Date;
  metrics: string; // JSON
};

export type CompetitorTrendPoint = {
  index: number; // 观测序号，0 起
  takenAt: Date;
  metrics: Metrics;
  /** 距上一次观测隔了几天（首点为 null）。间隔越大，两点之间的「增长」越不该被当成日增。 */
  gapDays: number | null;
};

export type CompetitorTrend = {
  points: CompetitorTrendPoint[];
  /** 观测点数量。<2 时 UI 必须走退化形态，不许画线。 */
  sample: number;
  /** 首末观测之间的净增（按指标键）。sample<2 时为 null。 */
  growth: Metrics | null;
  /** 首末观测跨了几天。sample<2 时为 null。 */
  spanDays: number | null;
};

const DAY_MS = 86_400_000;
// 竞对拿不到 impressions（那是后台数据），故不含它
const COUNT_KEYS = ['views', 'likes', 'comments', 'shares', 'collects', 'danmaku', 'coins'] as const;

const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY_MS);

/**
 * 折算竞对作品的观测序列。按 takenAt 升序；同一时刻重复观测取后者。
 * 不做逐日插值、不折日均——采集节奏不规律，插出来的值是编的。
 */
export function competitorTrend(snapshots: CompetitorSnapshotInput[]): CompetitorTrend {
  const sorted = [...snapshots].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  const points: CompetitorTrendPoint[] = [];
  for (const s of sorted) {
    const prev = points[points.length - 1];
    const metrics = parseJson<Metrics>(s.metrics, {});
    if (prev && prev.takenAt.getTime() === s.takenAt.getTime()) {
      // 同一时刻的重复观测：后者覆盖，不新增点
      points[points.length - 1] = { ...prev, metrics };
      continue;
    }
    points.push({
      index: points.length,
      takenAt: s.takenAt,
      metrics,
      gapDays: prev ? dayDiff(s.takenAt, prev.takenAt) : null,
    });
  }

  const sample = points.length;
  if (sample < 2) return { points, sample, growth: null, spanDays: null };

  const first = points[0].metrics;
  const last = points[sample - 1].metrics;
  const growth: Metrics = {};
  for (const k of COUNT_KEYS) {
    const a = last[k];
    const b = first[k];
    if (a == null && b == null) continue;
    // 平台回收流量导致的负增长钳 0（与自有作品的 clampDiff 同口径）
    growth[k] = Math.max(0, (a ?? 0) - (b ?? 0));
  }
  return {
    points,
    sample,
    growth,
    spanDays: dayDiff(points[sample - 1].takenAt, points[0].takenAt),
  };
}

/**
 * 一句话增长摘要，供表格行内展示。
 * **不下「日均」结论**：采集间隔不规律，除出来的日均是伪精度。只说「N 天内涨了多少」。
 */
export function growthSummary(trend: CompetitorTrend, key: MetricCountKey = 'views'): string | null {
  if (trend.sample < 2 || !trend.growth) return null;
  const delta = trend.growth[key] ?? 0;
  if (delta <= 0) return null;
  const span = trend.spanDays ?? 0;
  return span > 0 ? `${span} 天内 +${delta}` : `+${delta}`;
}
