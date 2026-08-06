import { describe, it, expect } from 'vitest';
import { analyzeCurveShape, sameWindowBaseline, valueAtDay } from '@/lib/insight/review';
import { toDailySeries, type SnapshotInput } from '@/lib/insight/timeseries';

// 复盘纯函数：曲线形态分类 + 同窗基线。均确定性、可单测——LLM 只在这之上加文字。

const pub = new Date('2026-07-01T00:00:00Z');
const snap = (day: number, views: number): SnapshotInput => ({
  takenAt: new Date(pub.getTime() + day * 86_400_000),
  milestone: `D+${day}`,
  metrics: { views },
});
const seriesOf = (pts: [number, number][]) => toDailySeries(pts.map(([d, v]) => snap(d, v)), pub);

describe('analyzeCurveShape', () => {
  it('首日爆发型：大部分增量集中在第一天', () => {
    const s = seriesOf([[1, 80000], [2, 90000], [3, 95000]]); // 首日80k占总95k的84%
    const a = analyzeCurveShape(s);
    expect(a.shape).toBe('first_day_burst');
    expect(a.label).toBe('首日爆发型');
  });
  it('长尾发酵型：首日占比低，后续持续涨', () => {
    const s = seriesOf([[1, 10000], [3, 50000], [5, 120000]]); // 首日10k占总120k的8%
    expect(analyzeCurveShape(s).shape).toBe('long_tail');
  });
  it('平稳增长型：介于两者之间', () => {
    const s = seriesOf([[1, 45000], [2, 70000], [3, 100000]]); // 首日45k占45%
    expect(analyzeCurveShape(s).shape).toBe('steady');
  });
  it('不足2点 → insufficient', () => {
    expect(analyzeCurveShape(seriesOf([[1, 5000]])).shape).toBe('insufficient');
    expect(analyzeCurveShape([]).shape).toBe('insufficient');
  });
  it('零播放 → insufficient', () => {
    expect(analyzeCurveShape(seriesOf([[1, 0], [2, 0]])).shape).toBe('insufficient');
  });
});

describe('valueAtDay / sameWindowBaseline', () => {
  it('取逻辑日 ≤ dayN 的最后一个累计值', () => {
    const s = seriesOf([[1, 100], [3, 300], [5, 500]]);
    expect(valueAtDay(s, 4)).toBe(300); // ≤4 的最后是 D+3
    expect(valueAtDay(s, 5)).toBe(500);
    expect(valueAtDay(s, 0)).toBeNull();
  });
  it('同窗基线：多篇同平台在 dayN 的平均累计', () => {
    const peers = [seriesOf([[2, 100000]]), seriesOf([[2, 200000]]), seriesOf([[2, 300000]])];
    const bl = sameWindowBaseline(peers, 2);
    expect(bl.sample).toBe(3);
    expect(bl.avgAtDay).toBe(200000);
  });
  it('没有 ≤dayN 数据点的 peer 被跳过', () => {
    const peers = [seriesOf([[1, 100000]]), seriesOf([[5, 500000]])]; // 第2个在 dayN=2 无点
    const bl = sameWindowBaseline(peers, 2);
    expect(bl.sample).toBe(1);
    expect(bl.avgAtDay).toBe(100000);
  });
});
