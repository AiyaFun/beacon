export type LifecycleStage = 'rising' | 'peak' | 'cooling' | 'faded';

const PLATFORM_WINDOW_HOURS: Record<string, number> = {
  douyin: 36,
  weibo: 36,
  xiaohongshu: 96,
  wechat: 120,
  // 视频号靠社交裂变推开，衰减比抖音慢、比公众号快：一条内容的社交传播链通常 2-3 天走完
  shipinhao: 72,
  bilibili: 240,
  youtube: 240,
  x: 36,
  // TikTok 的推荐池会把老内容反复捞起来（比抖音更常见的「几周后二次起飞」），
  // 衰减窗口给得比抖音宽一档，但仍远短于长视频平台。
  tiktok: 72,
  zhihu: 72,
  baidu: 48,
  toutiao: 48,
};

export function platformWindowHours(source: string): number {
  return PLATFORM_WINDOW_HOURS[source] ?? 48;
}

export function computeLifecycle(item: {
  heat: number;
  peakHeat: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  source: string;
}, now: Date = new Date()): LifecycleStage {
  const ageHours = (now.getTime() - item.firstSeenAt.getTime()) / 3_600_000;
  const staleness = (now.getTime() - item.lastSeenAt.getTime()) / 3_600_000;
  const window = platformWindowHours(item.source);
  const peak = item.peakHeat ?? item.heat;
  const heatRatio = peak > 0 ? item.heat / peak : 0;

  if (staleness > window) return 'faded';
  if (ageHours < window * 0.3 && heatRatio >= 0.8) return 'rising';
  if (heatRatio >= 0.7) return 'peak';
  return 'cooling';
}

export function timeDecayFactor(item: {
  lifecycle: string;
  firstSeenAt: Date;
  source: string;
}, now: Date = new Date()): number {
  const ageHours = (now.getTime() - item.firstSeenAt.getTime()) / 3_600_000;
  const window = platformWindowHours(item.source);
  if (item.lifecycle === 'faded') return 0.1;
  if (item.lifecycle === 'cooling') return 0.4;
  const freshness = Math.max(0, 1 - ageHours / (window * 1.5));
  return 0.3 + 0.7 * freshness;
}
