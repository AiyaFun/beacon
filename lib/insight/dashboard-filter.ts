// 数据看板筛选（纯函数）。时间段/平台筛选口径统一——页面渲染与 CSV 导出共用，保证「导出=所见即所得」。

export type RangeKey = '7d' | '30d' | 'all';

export const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: 'all', label: '全部', days: null },
];

export function parseRange(v: string | undefined | null): RangeKey {
  return v === '7d' || v === '30d' || v === 'all' ? v : '30d'; // 默认近 30 天
}

export function rangeStart(range: RangeKey, now: number): number | null {
  const r = RANGES.find((x) => x.key === range);
  return r && r.days != null ? now - r.days * 86_400_000 : null;
}

/**
 * 时间段筛选。
 *
 * 【没有发布时间的怎么办】不进任何有界窗口，只在「全部」里出现。
 * 「近 7 天」问的是「这 7 天里发的」，而这一条我们并不知道它是不是——
 * 把不知道的塞进去，等于替用户断言了一件没有依据的事。
 *
 * 【这是一个明写出来的取舍，不是算术的副产品】2026-08-30 之前 publishedAt 非空，
 * 采不到时被补成「回填那一刻」，于是这些作品**永远算在今天**，
 * 在「近 7 天」里显示、在时段分析里堆成一个假的最佳时段。
 * 与 app/(app)/competitors/top-posts-view.ts 的 inWindow 同一条口径。
 */
export function filterRecordsByRange<T extends { publishedAt: Date | null }>(records: T[], range: RangeKey, now: number): T[] {
  const start = rangeStart(range, now);
  return start == null ? records : records.filter((r) => r.publishedAt !== null && r.publishedAt.getTime() >= start);
}

/** 因为没有发布时间而进不了有界窗口的条数。界面要说破，否则用户只会觉得「怎么少了几条」。 */
export function undatedOutsideRange<T extends { publishedAt: Date | null }>(records: T[], range: RangeKey): number {
  return rangeStart(range, 0) === null ? 0 : records.filter((r) => r.publishedAt === null).length;
}

export function filterByPlatform<T extends { platform: string }>(records: T[], platform: string | null | undefined): T[] {
  return !platform || platform === 'all' ? records : records.filter((r) => r.platform === platform);
}

// 上一周期（用于环比）：range=7d → 前 7 天窗口 [now-14d, now-7d)
export function prevPeriodRecords<T extends { publishedAt: Date | null }>(records: T[], range: RangeKey, now: number): T[] {
  const r = RANGES.find((x) => x.key === range);
  if (!r || r.days == null) return [];
  const cur = now - r.days * 86_400_000;
  const prev = cur - r.days * 86_400_000;
  return records.filter((x) => x.publishedAt !== null && x.publishedAt.getTime() >= prev && x.publishedAt.getTime() < cur);
}
