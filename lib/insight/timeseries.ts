import type { Metrics } from '../json';
import { sourceRank } from './source-tier';

// 时序纯函数（可复盘数据模式的读取层）。把 append-only 累计快照折算成「逐日序列 + 日增量」，
// 供数据看板的单篇趋势卡、AI 复盘、爆款预警共用。零 IO、零 prisma——好单测。
//
// 核心难点是「逻辑日」的统一：官方/适配器回流的快照带 milestone 标签（D+1..D+7/D+14/D+30，
// 表达发布后第几天的逻辑日），而插件/手动快照 milestone 恒 null、takenAt 只是写库时间。
// 两类点必须落到同一坐标系才能画进一条曲线——规则见 logicalDay。

const DAY_MS = 86_400_000;

// 累计计数型指标（可做日增量差分）。completion 是率不是量，不参与差分（见 dailyDeltas）。
const COUNT_KEYS = ['views', 'likes', 'comments', 'shares', 'collects', 'danmaku', 'coins', 'impressions'] as const;
type CountKey = (typeof COUNT_KEYS)[number];

export type SnapshotInput = {
  takenAt: Date;
  milestone: string | null;
  metrics: Metrics;
  source?: string | null;
};

export type DaySeriesPoint = {
  day: number; // 发布后逻辑日（0=发布当天）
  metrics: Metrics; // 该逻辑日的累计值
  source: string | null;
  takenAt: Date;
};

export type DeltaPoint = {
  day: number;
  spanDays: number; // 距上一个数据点跨了几天（>1 = 中间缺日，增量是跨日累计）
  delta: Metrics; // 相对上一点的非负增量（缺日则为跨日总增量）
  perDay: Metrics; // 折算日均（delta / spanDays），供柱状图按日画
};

// 逻辑日：milestone 标签优先（官方/适配器逐日点），否则按 takenAt-publishedAt 折算（插件/手动点）。
// 兼容历史遗留标签 T+48h→2、T+7d→7。
export function logicalDay(publishedAt: Date, takenAt: Date, milestone: string | null): number {
  if (milestone) {
    const m = /^D\+(\d+)$/.exec(milestone);
    if (m) return Number(m[1]);
    if (milestone === 'T+48h') return 2;
    if (milestone === 'T+7d') return 7;
  }
  const diff = takenAt.getTime() - publishedAt.getTime();
  return Math.max(0, Math.floor(diff / DAY_MS));
}

// 折算成逐日序列：同一逻辑日多点时，**先比来源可信度（官方>插件>手填），同档再取 takenAt 最新**，
// 按日升序。
//
// 为什么要比来源而不是单纯「谁后写谁作数」：同一天里三条通道都可能写入（适配器回流、插件回传、
// 用户手填）。用户随手补的一个约数若晚于适配器写入，就会盖掉精确值——而这条曲线是复盘、
// 爆款预警、趋势图三处共同的取数口径，一个约数能同时污染三处结论。
//
// ⚠️ 比较只在**同一逻辑日内**发生。跨天绝不比可信度：官方 D+1 的 1000 不该压过手填 D+30 的 50 万，
// 那是两个时点的观测，不是冲突。跨天的取舍由 day 分组天然完成。
export function toDailySeries(snapshots: SnapshotInput[], publishedAt: Date): DaySeriesPoint[] {
  const byDay = new Map<number, DaySeriesPoint>();
  for (const s of snapshots) {
    const day = logicalDay(publishedAt, s.takenAt, s.milestone);
    const prev = byDay.get(day);
    if (prev) {
      const cmp = sourceRank(s.source) - sourceRank(prev.source);
      // 可信度更低 → 丢弃；同档 → 比新旧；更高 → 直接顶替
      if (cmp < 0) continue;
      if (cmp === 0 && s.takenAt.getTime() < prev.takenAt.getTime()) continue;
    }
    byDay.set(day, { day, metrics: s.metrics, source: s.source ?? null, takenAt: s.takenAt });
  }
  return [...byDay.values()].sort((a, b) => a.day - b.day);
}

function clampDiff(cur: Metrics, prev: Metrics): Metrics {
  const out: Metrics = {};
  for (const k of COUNT_KEYS) {
    const c = cur[k] ?? 0;
    const p = prev[k] ?? 0;
    // 平台回收流量导致的负增长钳 0（曲线上标注存疑由展示层处理）
    out[k] = Math.max(0, c - p);
  }
  // completion 是率，carry 最新值不做差分
  if (typeof cur.completion === 'number') out.completion = cur.completion;
  return stripZeros(out);
}

function divMetrics(m: Metrics, span: number): Metrics {
  if (span <= 1) return { ...m };
  const out: Metrics = {};
  for (const k of COUNT_KEYS) {
    if (m[k] != null) out[k] = Math.round((m[k] as number) / span);
  }
  if (typeof m.completion === 'number') out.completion = m.completion;
  return out;
}

// 只保留有值的计数键，避免 delta 里塞一堆 0（completion 保留）
function stripZeros(m: Metrics): Metrics {
  const out: Metrics = {};
  for (const k of COUNT_KEYS) {
    if ((m[k] ?? 0) !== 0) out[k] = m[k];
  }
  if (typeof m.completion === 'number') out.completion = m.completion;
  return out;
}

// 日增量：相邻累计值差分。发布当天视为累计 0 的隐式基线，故首个数据点也有增量。
// 缺日时 spanDays>1，delta 是跨日总增量、perDay 折算日均——绝不把跨 3 天的增量当单日柱画。
export function dailyDeltas(series: DaySeriesPoint[]): DeltaPoint[] {
  const out: DeltaPoint[] = [];
  let prevDay = 0;
  let prevMetrics: Metrics = {};
  let first = true;
  for (const p of series) {
    if (first && p.day === 0) {
      // 首点就在发布当天：增量即其自身累计值，按 1 天计
      const delta = clampDiff(p.metrics, {});
      out.push({ day: 0, spanDays: 1, delta, perDay: delta });
      prevDay = 0;
      prevMetrics = p.metrics;
      first = false;
      continue;
    }
    const spanDays = Math.max(1, p.day - prevDay);
    const delta = clampDiff(p.metrics, prevMetrics);
    out.push({ day: p.day, spanDays, delta, perDay: divMetrics(delta, spanDays) });
    prevDay = p.day;
    prevMetrics = p.metrics;
    first = false;
  }
  return out;
}

// 数据完整度：前 7 天逻辑日里实际拿到几天（供复盘报告标注「D1-D7 齐/缺」与曲线退化判断）
export function coverage7d(series: DaySeriesPoint[]): { have: number; missing: number[] } {
  const days = new Set(series.map((p) => p.day));
  const missing: number[] = [];
  let have = 0;
  for (let d = 1; d <= 7; d++) {
    if (days.has(d)) have++;
    else missing.push(d);
  }
  return { have, missing };
}
