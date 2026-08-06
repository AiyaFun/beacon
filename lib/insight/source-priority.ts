import { parseJson, type Metrics } from '../json';
import { sourceRank } from './source-tier';
import { logicalDay } from './timeseries';

export { sourceRank };

// 数据来源优先级：官方(适配器/授权 API) > 插件(浏览器回传) > 手填。
//
// 为什么需要这条规则：同一篇内容的表现数据会从多条通道进来（backfill 适配器、插件回传、
// 用户手填），它们各自往 PerformanceSnapshot 追加一条并覆盖 PublishRecord.metrics。
// 于是「谁最后写谁说了算」——用户随手补的一个约数，会盖掉适配器拉回来的精确值，
// 而下结论的 learn.ts 读的就是这个被盖过的值。结论建立在最不可信的那个数上，是本末倒置。
//
// ⚠️ 规则不是「全局取最高可信来源」，而是**先按逻辑日分组，再在同一天里取最高可信来源**。
// 这个区别是刻意的，反例说明为什么：
//   官方 D+1 播放 1000  +  手填 D+30 播放 500000
// 若全局取最高可信来源，会拿 D+1 的 1000 去和基线比，把一篇长尾爆款判成跑输。
// 「官方优先」要解决的是**同一时点的多来源冲突**，不是让陈旧数据压过新数据。
// 同一天内没有更高可信来源时，仍按 takenAt 取最新（沿用 toDailySeries 的既有口径）。
//
// 纯函数、零 IO——好单测。

export type SnapshotLike = {
  takenAt: Date;
  metrics: string;
  source: string | null;
  milestone: string | null;
};

/**
 * 从一篇内容的全部快照里挑出「最该拿来下结论」的那条：
 * 最新逻辑日 → 该日内可信度最高 → 同可信度取 takenAt 最新。
 * 无快照返回 null（调用方回落到 PublishRecord.metrics）。
 */
export function pickAuthoritativeSnapshot<T extends SnapshotLike>(
  snapshots: T[],
  publishedAt: Date,
): T | null {
  // 没有任何可用指标的快照不参与竞选。它不是「一个更可信的 0」，而是「没有观测」——
  // 让它顶掉一条有值的记录等于凭空把数据抹成 0，比选错来源严重得多。
  const usable = snapshots.filter((s) => {
    const m = parseJson<Metrics>(s.metrics, {});
    // 有任一数值指标，或有非空的流量来源分布（后台有时只补得到来源占比）
    return Object.values(m).some((v) => typeof v === 'number') || Object.keys(m.sources ?? {}).length > 0;
  });
  if (usable.length === 0) return null;
  let best: T | null = null;
  let bestDay = -Infinity;
  for (const s of usable) {
    const day = logicalDay(publishedAt, s.takenAt, s.milestone);
    if (best === null || day > bestDay) {
      best = s;
      bestDay = day;
      continue;
    }
    if (day < bestDay) continue;
    // 同一逻辑日：先比可信度，再比新旧
    const cmp = sourceRank(s.source) - sourceRank(best.source);
    if (cmp > 0 || (cmp === 0 && s.takenAt.getTime() >= best.takenAt.getTime())) best = s;
  }
  return best;
}

/**
 * 下结论该用的指标值。有快照就按来源优先级挑，没有就回落到 PublishRecord.metrics
 * （历史记录可能在快照表建起来之前就存在，不能因此不下结论）。
 */
export function authoritativeMetrics(
  fallbackMetricsJson: string,
  snapshots: SnapshotLike[],
  publishedAt: Date,
): Metrics {
  const pick = pickAuthoritativeSnapshot(snapshots, publishedAt);
  return parseJson<Metrics>(pick ? pick.metrics : fallbackMetricsJson, {});
}
