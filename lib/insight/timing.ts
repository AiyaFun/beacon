import { parseJson, type Metrics } from '../json';

// 发布时段分析（纯函数）。把发布记录按「一天的时段」和「星期几」聚合，看哪个时段发的内容平均播放更高。
// 样本阈值沿用 learn.ts 的 MIN_PEERS=3：不足 3 条的桶只计数不下结论（小样本时段结论是噪声）。
// 时区按 UTC+8（中国）折算——publishedAt 存 UTC，用户问的「几点发」是本地时间。

const MIN_SAMPLE = 3;
const CN_OFFSET_H = 8;

/**
 * 【publishedAt 可空】插件从小红书笔记页/B站视频页/YouTube 播放页回填时采不到发布时间。
 * 2026-08-30 之前落库时被补成了「回填那一刻」，于是这些作品**全部落进用户点回填的那个时辰**——
 * 页面上就印出「你的最佳发布时段是 深夜/凌晨」，而那是他熬夜回填的时间，不是内容跑得好的时间。
 * 现在如实存 null，这里必须把它们**排除在时段统计之外**：
 * 「几点发的效果好」这个问题，对一条不知道几点发的作品无从回答。
 */
export type TimingRecord = { publishedAt: Date | null; metrics: string };
export type TimingSlot = { key: string; label: string; sample: number; avgViews: number };
export type TimingAnalysis = {
  hourSlots: TimingSlot[]; // 有样本的时段桶（按均播降序）
  weekdaySlots: TimingSlot[]; // 有样本的星期桶（按均播降序）
  best: TimingSlot | null; // 达样本阈值且均播最高的时段
  overallAvg: number;
  sampleTotal: number;
  /** 因为没有发布时间而没能参与统计的条数。界面要说破它，否则用户不知道少了几条。 */
  undated: number;
  conclusive: boolean; // 是否有达阈值的时段可下结论
};

function cnHour(d: Date): number {
  return (d.getUTCHours() + CN_OFFSET_H) % 24;
}
function cnWeekday(d: Date): number {
  // UTC+8 可能跨天，用毫秒偏移后取 UTC 星期
  return new Date(d.getTime() + CN_OFFSET_H * 3600_000).getUTCDay();
}

export function hourSlot(h: number): { key: string; label: string } {
  if (h >= 6 && h < 9) return { key: 'morning', label: '清晨 6-9点' };
  if (h >= 9 && h < 12) return { key: 'forenoon', label: '上午 9-12点' };
  if (h >= 12 && h < 14) return { key: 'noon', label: '午间 12-14点' };
  if (h >= 14 && h < 18) return { key: 'afternoon', label: '下午 14-18点' };
  if (h >= 18 && h < 23) return { key: 'evening', label: '晚间 18-23点' };
  return { key: 'night', label: '深夜/凌晨' };
}

const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function aggregate(
  records: TimingRecord[],
  keyOf: (d: Date) => { key: string; label: string },
): TimingSlot[] {
  const acc = new Map<string, { label: string; views: number; n: number }>();
  for (const r of records) {
    const views = parseJson<Metrics>(r.metrics, {}).views ?? 0;
    if (views <= 0) continue; // 无播放数据的记录不进时段统计
    if (!r.publishedAt) continue; // 不知道几点发的，回答不了「几点发效果好」
    const { key, label } = keyOf(r.publishedAt);
    const cur = acc.get(key) ?? { label, views: 0, n: 0 };
    cur.views += views;
    cur.n += 1;
    acc.set(key, cur);
  }
  return [...acc.entries()]
    .map(([key, v]) => ({ key, label: v.label, sample: v.n, avgViews: Math.round(v.views / v.n) }))
    .sort((a, b) => b.avgViews - a.avgViews);
}

export function analyzePublishTiming(records: TimingRecord[]): TimingAnalysis {
  const hourSlots = aggregate(records, (d) => hourSlot(cnHour(d)));
  const weekdaySlots = aggregate(records, (d) => {
    const w = cnWeekday(d);
    return { key: `w${w}`, label: WEEKDAY_LABEL[w] };
  });
  const withData = records
    .filter((r) => r.publishedAt)
    .map((r) => parseJson<Metrics>(r.metrics, {}).views ?? 0)
    .filter((v) => v > 0);
  // 有播放量、却没有发布时间的那些：它们本来该参与统计，只因不知道几点发而被挡在外面。
  // 这个数要交给界面说破——不说的话用户只会觉得「怎么少了几条」。
  const undated = records.filter(
    (r) => !r.publishedAt && (parseJson<Metrics>(r.metrics, {}).views ?? 0) > 0,
  ).length;
  const sampleTotal = withData.length;
  const overallAvg = sampleTotal > 0 ? Math.round(withData.reduce((a, b) => a + b, 0) / sampleTotal) : 0;
  // 达阈值的时段里均播最高者才算「最佳时段」，否则不下结论
  const qualified = hourSlots.filter((s) => s.sample >= MIN_SAMPLE);
  const best = qualified.length > 0 ? qualified[0] : null;
  return { hourSlots, weekdaySlots, best, overallAvg, sampleTotal, undated, conclusive: best !== null };
}

// 最佳时段是否显著优于账号整体均值（供写入 fact 记忆的判据，稳定措辞在调用侧拼）
export function timingBeatsBaseline(a: TimingAnalysis, ratio = 1.3): boolean {
  return a.best !== null && a.overallAvg > 0 && a.best.avgViews >= a.overallAvg * ratio;
}
