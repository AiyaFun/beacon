import { describe, it, expect } from 'vitest';
import { logicalDay, toDailySeries, dailyDeltas, coverage7d, type SnapshotInput } from '@/lib/insight/timeseries';

// 时序纯函数：把累计快照折算成逐日序列+日增量。锁三件事——
// 1) 逻辑日统一（milestone 标签点 与 null-milestone 折算点 落到同一坐标系）；
// 2) 差分对缺日/负增长/率型指标的正确处理（缺日折日均、负增长钳0、completion 不差分）；
// 3) 数据完整度统计（供退化形态与复盘完整度标注）。

const pub = new Date('2026-07-01T00:00:00Z');
const at = (days: number, hours = 0) => new Date(pub.getTime() + days * 86_400_000 + hours * 3600_000);
const snap = (milestone: string | null, takenAt: Date, metrics: SnapshotInput['metrics'], source?: string): SnapshotInput =>
  ({ milestone, takenAt, metrics, source });

describe('logicalDay', () => {
  it('milestone 标签 D+N 优先', () => {
    expect(logicalDay(pub, at(9), 'D+3')).toBe(3); // takenAt 是第9天也不影响，标签说了算
    expect(logicalDay(pub, at(0), 'D+7')).toBe(7);
    expect(logicalDay(pub, at(0), 'D+14')).toBe(14);
  });
  it('兼容历史遗留标签 T+48h/T+7d', () => {
    expect(logicalDay(pub, at(0), 'T+48h')).toBe(2);
    expect(logicalDay(pub, at(0), 'T+7d')).toBe(7);
  });
  it('无 milestone（插件/手动）按 takenAt-publishedAt 折算', () => {
    expect(logicalDay(pub, at(0, 5), null)).toBe(0); // 发布当天
    expect(logicalDay(pub, at(2, 10), null)).toBe(2); // 第2天多10小时仍是第2天
    expect(logicalDay(pub, at(3), null)).toBe(3);
  });
  it('takenAt 早于发布（异常）折算为 0 不为负', () => {
    expect(logicalDay(pub, new Date(pub.getTime() - 86_400_000), null)).toBe(0);
  });
});

describe('toDailySeries', () => {
  it('同一逻辑日、同来源多点取 takenAt 最新的一条', () => {
    const series = toDailySeries(
      [
        snap(null, at(1, 2), { views: 100 }),
        snap(null, at(1, 20), { views: 180 }), // 同为第1天，更晚 → 采这条
      ],
      pub,
    );
    expect(series).toHaveLength(1);
    expect(series[0].day).toBe(1);
    expect(series[0].metrics.views).toBe(180);
  });

  // 这条曲线是复盘 / 爆款预警 / 趋势图三处共同的取数口径，同一天里一个手填约数
  // 若因为「后写」压过适配器的精确值，能同时污染三处结论。
  describe('同一逻辑日多来源 · 官方 > 插件 > 手填', () => {
    it('官方压过后写的手填', () => {
      const series = toDailySeries(
        [
          snap('D+1', at(1, 1), { views: 1000 }, 'tikhub'),
          snap(null, at(1, 20), { views: 900 }, 'manual'), // 更晚，但只是手填
        ],
        pub,
      );
      expect(series[0].metrics.views).toBe(1000);
      expect(series[0].source).toBe('tikhub');
    });

    it('插件压过手填，官方压过插件', () => {
      const s1 = toDailySeries(
        [snap(null, at(1, 20), { views: 900 }, 'manual'), snap(null, at(1, 1), { views: 1000 }, 'plugin')],
        pub,
      );
      expect(s1[0].metrics.views).toBe(1000);
      const s2 = toDailySeries(
        [snap(null, at(1, 20), { views: 1000 }, 'plugin'), snap('D+1', at(1, 1), { views: 1100 }, 'tikhub')],
        pub,
      );
      expect(s2[0].metrics.views).toBe(1100);
    });

    it('同档仍按 takenAt 取新（不因为引入来源比较就丢了原口径）', () => {
      const series = toDailySeries(
        [snap('D+1', at(1, 1), { views: 1000 }, 'tikhub'), snap('D+1', at(1, 9), { views: 1200 }, 'newrank')],
        pub,
      );
      expect(series[0].metrics.views).toBe(1200);
    });

    // 跨天绝不比可信度：那是两个时点的观测，不是冲突
    it('跨天不比可信度：官方 D+1 不压过手填 D+30', () => {
      const series = toDailySeries(
        [snap('D+1', at(1), { views: 1000 }, 'tikhub'), snap(null, at(30), { views: 500000 }, 'manual')],
        pub,
      );
      expect(series.map((p) => p.day)).toEqual([1, 30]);
      expect(series[1].metrics.views).toBe(500000);
    });
  });
  it('官方标签点与 null 折算点混合，落到同一坐标系并按日升序', () => {
    const series = toDailySeries(
      [
        snap('D+3', at(3), { views: 500 }),
        snap(null, at(1, 6), { views: 120 }), // 插件第1天
        snap('D+2', at(2), { views: 300 }),
      ],
      pub,
    );
    expect(series.map((p) => p.day)).toEqual([1, 2, 3]);
    expect(series.map((p) => p.metrics.views)).toEqual([120, 300, 500]);
  });
});

describe('dailyDeltas', () => {
  it('首个数据点以发布日累计0为隐式基线 → 首日也有增量', () => {
    const series = toDailySeries([snap('D+1', at(1), { views: 100, likes: 10 })], pub);
    const deltas = dailyDeltas(series);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ day: 1, spanDays: 1 });
    expect(deltas[0].delta.views).toBe(100);
    expect(deltas[0].delta.likes).toBe(10);
  });
  it('相邻累计值差分得日增量', () => {
    const series = toDailySeries(
      [snap('D+1', at(1), { views: 100 }), snap('D+2', at(2), { views: 260 }), snap('D+3', at(3), { views: 300 })],
      pub,
    );
    const d = dailyDeltas(series);
    expect(d.map((x) => x.delta.views)).toEqual([100, 160, 40]);
    expect(d.every((x) => x.spanDays === 1)).toBe(true);
  });
  it('缺日：spanDays>1，delta 为跨日总增量，perDay 折算日均', () => {
    // D+1 有点，D+2/D+3 缺，D+4 才有下一点
    const series = toDailySeries([snap('D+1', at(1), { views: 100 }), snap('D+4', at(4), { views: 400 })], pub);
    const d = dailyDeltas(series);
    expect(d[1]).toMatchObject({ day: 4, spanDays: 3 });
    expect(d[1].delta.views).toBe(300); // 跨3天总增量
    expect(d[1].perDay.views).toBe(100); // 折算日均 300/3
  });
  it('平台回收流量导致负增长 → 钳 0', () => {
    const series = toDailySeries([snap('D+1', at(1), { views: 500 }), snap('D+2', at(2), { views: 480 })], pub);
    const d = dailyDeltas(series);
    expect(d[1].delta.views ?? 0).toBe(0); // 不出现负增量
  });
  it('completion 是率不做差分，carry 最新值', () => {
    const series = toDailySeries(
      [snap('D+1', at(1), { views: 100, completion: 0.4 }), snap('D+2', at(2), { views: 200, completion: 0.55 })],
      pub,
    );
    const d = dailyDeltas(series);
    expect(d[1].delta.views).toBe(100); // 计数差分
    expect(d[1].delta.completion).toBe(0.55); // 率 carry 而非 0.55-0.4
  });
  it('首点就在发布当天(day0)不除零', () => {
    const series = toDailySeries([snap(null, at(0, 3), { views: 50 }), snap('D+1', at(1), { views: 120 })], pub);
    const d = dailyDeltas(series);
    expect(d[0]).toMatchObject({ day: 0, spanDays: 1 });
    expect(d[0].delta.views).toBe(50);
    expect(d[1].delta.views).toBe(70);
  });
});

describe('coverage7d', () => {
  it('统计前7天实际拿到几天与缺哪几天', () => {
    const series = toDailySeries(
      [snap('D+1', at(1), { views: 1 }), snap('D+2', at(2), { views: 2 }), snap('D+5', at(5), { views: 5 })],
      pub,
    );
    const c = coverage7d(series);
    expect(c.have).toBe(3);
    expect(c.missing).toEqual([3, 4, 6, 7]);
  });
  it('全空序列 → have 0，缺 1-7', () => {
    expect(coverage7d([])).toEqual({ have: 0, missing: [1, 2, 3, 4, 5, 6, 7] });
  });
});
