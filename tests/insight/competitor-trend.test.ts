import { describe, it, expect } from 'vitest';
import { competitorTrend, growthSummary, type CompetitorSnapshotInput } from '@/lib/insight/competitor-trend';

// 竞对作品趋势（纯函数）。这个文件锁的核心是「不许拿采集节奏冒充增长速度」：
// 竞对快照的产生时机由用户什么时候点采集决定，今天采一次、下周采一次是常态。
// 所以坐标轴是观测序号、间隔要如实标出、且**不输出任何日均结论**。

const t = (iso: string) => new Date(iso);
const snap = (iso: string, m: Record<string, number>): CompetitorSnapshotInput => ({
  takenAt: t(iso),
  metrics: JSON.stringify(m),
});

describe('competitorTrend · 观测序列', () => {
  it('按 takenAt 升序编号，并算出与上一次观测的间隔天数', () => {
    const r = competitorTrend([
      snap('2026-07-10T00:00:00Z', { views: 300 }),
      snap('2026-07-01T00:00:00Z', { views: 100 }), // 乱序输入
      snap('2026-07-03T00:00:00Z', { views: 150 }),
    ]);
    expect(r.points.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(r.points.map((p) => p.metrics.views)).toEqual([100, 150, 300]);
    expect(r.points.map((p) => p.gapDays)).toEqual([null, 2, 7]);
  });

  it('同一时刻的重复观测取后者，不多出一个点', () => {
    const r = competitorTrend([
      snap('2026-07-01T00:00:00Z', { views: 100 }),
      snap('2026-07-01T00:00:00Z', { views: 120 }),
    ]);
    expect(r.sample).toBe(1);
    expect(r.points[0].metrics.views).toBe(120);
  });

  it('首末净增 + 跨天数', () => {
    const r = competitorTrend([
      snap('2026-07-01T00:00:00Z', { views: 100, likes: 10 }),
      snap('2026-07-08T00:00:00Z', { views: 900, likes: 60 }),
    ]);
    expect(r.growth?.views).toBe(800);
    expect(r.growth?.likes).toBe(50);
    expect(r.spanDays).toBe(7);
  });

  it('平台回收流量导致的负增长钳 0（不显示负增长）', () => {
    const r = competitorTrend([
      snap('2026-07-01T00:00:00Z', { views: 900 }),
      snap('2026-07-08T00:00:00Z', { views: 700 }),
    ]);
    expect(r.growth?.views).toBe(0);
  });

  it('损坏 JSON 不抛，当空指标处理', () => {
    const r = competitorTrend([
      { takenAt: t('2026-07-01T00:00:00Z'), metrics: 'not json' },
      snap('2026-07-02T00:00:00Z', { views: 50 }),
    ]);
    expect(r.sample).toBe(2);
    // 【2026-08-30 改了这条断言：它原来把缺陷当成了期望行为】
    // 原来断的是 `growth.views === 50`——而 50 是**第二次观测的累计播放**，
    // 不是这段时间涨了多少。首点没有 views（JSON 坏了），这段的净增**根本算不出来**。
    // 这条用例的本意是「坏 JSON 不抛异常」，那句 50 是顺手写上的，而它恰好写死了 bug。
    expect(r.growth?.views, '一端没有数据时不该给出净增').toBeUndefined();
  });
});

describe('competitorTrend · 退化形态（稀疏数据不许伪装成密集）', () => {
  it('零观测', () => {
    const r = competitorTrend([]);
    expect(r.sample).toBe(0);
    expect(r.growth).toBeNull();
    expect(r.spanDays).toBeNull();
  });

  it('单点观测 → 不给增长结论（一次观测推不出趋势）', () => {
    const r = competitorTrend([snap('2026-07-01T00:00:00Z', { views: 100 })]);
    expect(r.sample).toBe(1);
    expect(r.growth).toBeNull();
    expect(r.spanDays).toBeNull();
    expect(growthSummary(r)).toBeNull();
  });
});

describe('growthSummary · 只说净增，绝不折日均', () => {
  it('说「N 天内 +X」，不说「日均 +Y」', () => {
    const r = competitorTrend([
      snap('2026-07-01T00:00:00Z', { views: 100 }),
      snap('2026-07-11T00:00:00Z', { views: 1100 }),
    ]);
    const s = growthSummary(r);
    expect(s).toBe('10 天内 +1000');
    expect(s).not.toContain('日均');
    expect(s).not.toContain('/天');
  });

  it('没涨（或回收）→ 不给摘要，不显示 +0 这种废话', () => {
    const r = competitorTrend([
      snap('2026-07-01T00:00:00Z', { views: 100 }),
      snap('2026-07-05T00:00:00Z', { views: 100 }),
    ]);
    expect(growthSummary(r)).toBeNull();
  });

  it('同日两次观测（跨 0 天）→ 只报净增不报天数', () => {
    const r = competitorTrend([
      snap('2026-07-01T00:00:00Z', { views: 100 }),
      snap('2026-07-01T10:00:00Z', { views: 160 }),
    ]);
    expect(growthSummary(r)).toBe('+60');
  });
});
