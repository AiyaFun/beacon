import type { Metrics } from '../json';

// 区间增长（「这段时间涨了多少」+「每个采集时点各是多少」）。
// 零 IO、零 prisma——纯函数，好单测。自有作品、竞对作品、竞对账号三处共用同一套口径。
//
// 【为什么不复用 timeseries.ts 的 toDailySeries】那套的坐标系是**发布后第几天**（逻辑日），
// 回答的是「这条作品的生命周期长什么样」。本模块的坐标系是**日历时间**，回答的是
// 「最近 7 天涨了多少」——同一批快照，两个问题，不能混。
//
// 三条纪律（与 lib/json.ts 的 hasViews/ratioOf 同源）：
//   ① **两端都观测到才算增长**。上次没采 collects、这次采到 8249，不是「收藏涨了 8249」，
//      而是「这一项算不出增长」。缺席的键进 unavailable，绝不产出数字。
//   ② **基准点取窗口开始之前最近的那次观测**（carry-forward），不是窗口内第一个点。
//      用窗口内第一个点会漏掉「窗口开始 → 第一次采集」之间的增长，系统性低估。
//   ③ **负增长如实呈现，不钳 0**。掉粉、播放被平台回收都是真实信号
//      （schema 里 AccountDailyStat.followerDelta 早就写着「可为负，不许钳 0」）。
//      日增量图为了柱子好看会钳 0，那是展示层的取舍，不该渗进这里。

const COUNT_KEYS = ['views', 'likes', 'comments', 'shares', 'collects', 'danmaku', 'coins', 'impressions', 'followers'] as const;
export type GrowthKey = (typeof COUNT_KEYS)[number];

/** 一次观测。metrics 里没有的键 = 那次没采到，不是 0。 */
export type Observation = {
  at: Date;
  metrics: Metrics & { followers?: number };
};

export type GrowthPoint = {
  at: Date;
  metrics: Metrics & { followers?: number };
  /** 相对上一个时点的增量。首点没有上一点 → null（不是 0：没有上一点就是「算不出来」）。 */
  delta: Partial<Record<GrowthKey, number>> | null;
};

export type GrowthSummary = {
  from: Date;
  to: Date;
  /** 窗口起点的基准观测；null = 窗口开始前没有任何观测 */
  baseline: Observation | null;
  /** 窗口内最后一次观测 */
  latest: Observation | null;
  /** 两端都观测到的键的净增（可为负） */
  delta: Partial<Record<GrowthKey, number>>;
  /** 因某一端没采到而**算不出**增长的键——UI 上要显示「—」并说明原因，不许当 0 */
  unavailable: GrowthKey[];
  /** 每次采集一个点，按时间升序 */
  points: GrowthPoint[];
  status: 'ok' | 'single-point' | 'no-data';
  /**
   * true = 基准点落在窗口之内（窗口开始前没有观测），此时得到的增长是**下界**：
   * 「窗口开始 → 第一次采集」那段没人看见。UI 必须标出来，否则用户会把它当完整区间增长。
   */
  baselineInsideWindow: boolean;
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * 两次观测之间的净增。**只对两端都有的键产出数字**，任一端缺席则该键进 unavailable。
 * 不钳 0：负增长是真实信号。
 */
export function diffObservations(
  prev: Observation['metrics'],
  cur: Observation['metrics'],
): { delta: Partial<Record<GrowthKey, number>>; unavailable: GrowthKey[] } {
  const delta: Partial<Record<GrowthKey, number>> = {};
  const unavailable: GrowthKey[] = [];
  for (const k of COUNT_KEYS) {
    const a = num(prev[k]);
    const b = num(cur[k]);
    if (a === null || b === null) {
      // 只有「其中一端有」才值得提示；两端都没有说明这个平台压根没这项，不必刷屏
      if (a !== null || b !== null) unavailable.push(k);
      continue;
    }
    delta[k] = b - a;
  }
  return { delta, unavailable };
}

/**
 * 把一串观测折算成区间增长 + 时点序列。
 * observations 不要求有序，内部按 at 升序处理；at 相同的两条按传入顺序保留后者。
 */
export function growthOverWindow(
  observations: Observation[],
  from: Date,
  to: Date,
): GrowthSummary {
  const sorted = [...observations]
    .filter((o) => o.at instanceof Date && !Number.isNaN(o.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const inWindow = sorted.filter((o) => o.at >= from && o.at <= to);
  // 基准 = 窗口开始前最近的一次观测（carry-forward）。它可能远早于 from，那没关系：
  // 累计量在两次观测之间不会凭空变化，用它当起点比用窗口内第一个点更接近真实区间增长。
  const before = sorted.filter((o) => o.at < from);
  const carried = before.length > 0 ? before[before.length - 1] : null;

  const baseline = carried ?? (inWindow.length > 0 ? inWindow[0] : null);
  const baselineInsideWindow = carried === null && inWindow.length > 0;
  const latest = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null;

  // 时点序列：窗口内每次采集一个点。首点的 delta 相对基准（有基准时），否则为 null。
  const points: GrowthPoint[] = [];
  let prev: Observation | null = carried;
  for (const o of inWindow) {
    points.push({
      at: o.at,
      metrics: o.metrics,
      delta: prev ? diffObservations(prev.metrics, o.metrics).delta : null,
    });
    prev = o;
  }

  if (!baseline || !latest) {
    return { from, to, baseline, latest, delta: {}, unavailable: [], points, status: 'no-data', baselineInsideWindow };
  }
  if (baseline === latest) {
    // 窗口里只有一个观测且没有更早的基准 → 只有一个时点，算不出增长（不是「增长为 0」）
    return { from, to, baseline, latest, delta: {}, unavailable: [], points, status: 'single-point', baselineInsideWindow };
  }

  const { delta, unavailable } = diffObservations(baseline.metrics, latest.metrics);
  return { from, to, baseline, latest, delta, unavailable, points, status: 'ok', baselineInsideWindow };
}

// ── 展示精度 ──────────────────────────────────────────────
//
// 有些平台的公开页面只印**四舍五入后的展示值**（「1.0亿」「12.3万」），我们采到的就是它。
// 真机 2026-08-10 实测：B站 页面「1.0亿」，真值 102,372,046 —— 差 237 万。
//
// 【为什么必须在增长页标出来】展示值**不会动**：要涨到 1.1亿 才会变。于是增长页会稳定地
// 显示「播放 +0」，而这和「真的没涨」长得一模一样，用户会得出「这号不涨了」的错误结论。
// 不能改数据（B站 的精确值只在页面 JS 变量里，内容脚本读不到），那就把话说清楚。
//
// X / YouTube 不在此列：它们的精确值分别在 aria-label 和内联脚本里，我们取的就是精确值。
const DISPLAY_ROUNDED_PLATFORMS = new Set(['bilibili', 'douyin', 'xiaohongshu', 'wechat', 'shipinhao', 'tiktok']);

/** 中文平台从「1万」开始用缩写；低于这个量级的数字是精确的。 */
const ROUNDING_FLOOR = 10_000;

/**
 * 这一行的数字是不是「约数」——平台只给展示值，且量级已经进入缩写区间。
 * 量级不够（几千）时返回 false：那时页面上印的就是精确数字，不该无谓地打折扣。
 */
export function isApproximate(platform: string, sampleValues: (number | undefined | null)[]): boolean {
  if (!DISPLAY_ROUNDED_PLATFORMS.has(platform)) return false;
  return sampleValues.some((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) >= ROUNDING_FLOOR);
}

/** 常用时间窗。自定义区间直接调 growthOverWindow。 */
export const WINDOW_PRESETS = [
  { key: '24h', label: '24 小时', hours: 24 },
  { key: '7d', label: '7 天', hours: 24 * 7 },
  { key: '30d', label: '30 天', hours: 24 * 30 },
] as const;
export type WindowKey = (typeof WINDOW_PRESETS)[number]['key'];

/** key → 中文标签。榜上「近 7 天 +1.2万」这类文案要用，避免各处各写一份对照表。 */
export const WINDOW_LABEL: Record<WindowKey, string> = {
  '24h': '24 小时',
  '7d': '7 天',
  '30d': '30 天',
};

export function windowRange(key: WindowKey, now: Date): { from: Date; to: Date } {
  const preset = WINDOW_PRESETS.find((w) => w.key === key) ?? WINDOW_PRESETS[1];
  return { from: new Date(now.getTime() - preset.hours * 3_600_000), to: now };
}

/**
 * 增长率 = 净增 / 起点值。**起点为 0 时返回 null**——从 0 涨到 100 的「增长率」是无穷大，
 * 写成 100% 或 0% 都是假的；这种情况直接给净增就好。
 */
export function growthRate(baselineValue: number | undefined, delta: number | undefined): number | null {
  const b = num(baselineValue);
  const d = num(delta);
  if (b === null || d === null || b <= 0) return null;
  return d / b;
}
