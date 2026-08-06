import { describe, it, expect } from 'vitest';
import { analyzePublishTiming, hourSlot, timingBeatsBaseline, type TimingRecord } from '@/lib/insight/timing';

// 发布时段分析：时区折算(UTC+8)、样本阈值(≥3才下结论)、最佳时段判定。

// 构造某 UTC+8 本地小时的 publishedAt（用固定 UTC 日期避免依赖 now）
const atCnHour = (h: number, day = 5): Date => new Date(Date.UTC(2026, 6, day, (h - 8 + 24) % 24, 0, 0));
const rec = (h: number, views: number, day = 5): TimingRecord => ({
  publishedAt: atCnHour(h, day),
  metrics: JSON.stringify({ views }),
});

describe('hourSlot 分桶', () => {
  it('落到正确时段', () => {
    expect(hourSlot(7).key).toBe('morning');
    expect(hourSlot(20).key).toBe('evening');
    expect(hourSlot(2).key).toBe('night');
    expect(hourSlot(23).key).toBe('night');
    expect(hourSlot(13).key).toBe('noon');
  });
});

describe('analyzePublishTiming', () => {
  it('时区按 UTC+8 折算：晚间发布归到 evening 桶', () => {
    const a = analyzePublishTiming([rec(20, 1000), rec(21, 2000), rec(19, 3000)]);
    expect(a.hourSlots[0].key).toBe('evening');
    expect(a.hourSlots[0].sample).toBe(3);
    expect(a.hourSlots[0].avgViews).toBe(2000);
  });

  it('样本<3 的时段不下结论（best=null）', () => {
    const a = analyzePublishTiming([rec(20, 5000), rec(21, 6000)]); // 晚间只有2条
    expect(a.conclusive).toBe(false);
    expect(a.best).toBeNull();
  });

  it('达阈值时取均播最高的时段为 best', () => {
    const a = analyzePublishTiming([
      rec(20, 5000), rec(21, 6000), rec(19, 7000), // 晚间3条，均6000
      rec(7, 1000), rec(8, 1200), rec(6, 800), // 清晨3条，均1000
    ]);
    expect(a.best?.key).toBe('evening');
    expect(a.best?.avgViews).toBe(6000);
  });

  it('无播放数据的记录不进统计', () => {
    const a = analyzePublishTiming([rec(20, 0), rec(20, 0), rec(20, 0)]);
    expect(a.sampleTotal).toBe(0);
    expect(a.best).toBeNull();
  });

  it('timingBeatsBaseline：最佳时段显著高于整体均值', () => {
    const a = analyzePublishTiming([
      rec(20, 9000), rec(21, 9000), rec(19, 9000), // 晚间均9000
      rec(7, 1000), rec(8, 1000), rec(6, 1000), // 清晨均1000
    ]);
    // 整体均值 5000，晚间 9000 > 5000×1.3
    expect(timingBeatsBaseline(a)).toBe(true);
  });
});
