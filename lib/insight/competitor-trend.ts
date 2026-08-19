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
  /** 这次是从哪种页面采的（见 PostMetricSnapshot.source）。老数据没有这个字段。 */
  source?: string | null;
};

/** 来源的中文说法。数据记录里必须写出来——不同页面能给的字段本来就不一样。 */
export const SOURCE_LABEL: Record<string, string> = {
  home: '账号主页',
  detail: '作品详情页',
  server: '服务端抓取',
  import: '文件导入',
};
export const sourceLabel = (s?: string | null): string => SOURCE_LABEL[s || 'home'] ?? '未知来源';

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


// ── 数据记录：把每一次采集摊成一行，让用户看得懂「这段时间涨了多少」 ──────────
//
// 与趋势图的分工：图回答「大致在涨还是在停」，记录回答「**哪一次**采到了什么、比上次多多少」。
// 用户问「数据对应时间段的增长」时，要的是后者——一个能逐行核对的账。
//
// 【为什么每行必须标来源】不同页面给的字段天差地别（抖音主页只有点赞，详情页才有评论/收藏/转发）。
// 不标来源的话，一条作品的记录会在「只有点赞」和「四项齐全」之间反复横跳，
// 用户会以为是平台改了或者数据丢了，其实只是这次换了种采法。
export type ObservationCell = {
  key: MetricCountKey;
  /** 这次采到的值；这次没采到这一项为 null */
  value: number | null;
  /** 相对上一次的净增；算不出来为 null，理由见 note */
  delta: number | null;
  /** delta 为 null 时的原因，直接显示给用户 */
  note: string | null;
};

export type ObservationRow = {
  takenAt: Date;
  source: string;
  sourceText: string;
  gapDays: number | null;
  cells: ObservationCell[];
};

/**
 * 逐次观测的记录表。**最新的排最前**（用户先看最近发生了什么）。
 *
 * 增量只在**两次都采到这一项**时才算。一边缺席就给 null 并写明为什么——
 * 拿 0 当上次的值会把「上次没采这项」算成「从 0 涨到现在」，那是个凭空造出来的暴涨。
 */
export function observationRecords(
  snapshots: CompetitorSnapshotInput[],
  keys: readonly MetricCountKey[],
): ObservationRow[] {
  const trend = competitorTrend(snapshots);
  const rows: ObservationRow[] = [];
  for (let i = trend.points.length - 1; i >= 0; i--) {
    const cur = trend.points[i];
    const prev = i > 0 ? trend.points[i - 1] : null;
    const curSrc = snapshots[cur.index]?.source ?? 'home';
    const prevSrc = prev ? (snapshots[prev.index]?.source ?? 'home') : null;
    const cells: ObservationCell[] = keys.map((k) => {
      const v = (cur.metrics as Record<string, number | undefined>)[k];
      const pv = prev ? (prev.metrics as Record<string, number | undefined>)[k] : undefined;
      const has = typeof v === 'number' && Number.isFinite(v);
      if (!prev) return { key: k, value: has ? v! : null, delta: null, note: '首次观测' };
      if (!has) return { key: k, value: null, delta: null, note: '这次没采到' };
      if (typeof pv !== 'number' || !Number.isFinite(pv)) {
        return { key: k, value: v!, delta: null, note: `上一次从${sourceLabel(prevSrc)}采，没有这一项` };
      }
      return { key: k, value: v!, delta: v! - pv, note: null };
    });
    rows.push({
      takenAt: cur.takenAt,
      source: curSrc,
      sourceText: sourceLabel(curSrc),
      gapDays: cur.gapDays,
      cells,
    });
  }
  return rows;
}
