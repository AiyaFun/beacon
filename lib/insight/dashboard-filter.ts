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

export function filterRecordsByRange<T extends { publishedAt: Date }>(records: T[], range: RangeKey, now: number): T[] {
  const start = rangeStart(range, now);
  return start == null ? records : records.filter((r) => r.publishedAt.getTime() >= start);
}

export function filterByPlatform<T extends { platform: string }>(records: T[], platform: string | null | undefined): T[] {
  return !platform || platform === 'all' ? records : records.filter((r) => r.platform === platform);
}

// 上一周期（用于环比）：range=7d → 前 7 天窗口 [now-14d, now-7d)
export function prevPeriodRecords<T extends { publishedAt: Date }>(records: T[], range: RangeKey, now: number): T[] {
  const r = RANGES.find((x) => x.key === range);
  if (!r || r.days == null) return [];
  const cur = now - r.days * 86_400_000;
  const prev = cur - r.days * 86_400_000;
  return records.filter((x) => x.publishedAt.getTime() >= prev && x.publishedAt.getTime() < cur);
}
