import { describe, it, expect } from 'vitest';
import { computeLifecycle, timeDecayFactor, platformWindowHours } from '@/lib/hot/lifecycle';

const NOW = new Date('2026-07-19T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('热点生命周期 (F1-3)', () => {
  describe('computeLifecycle', () => {
    it('新出现高热 → rising', () => {
      expect(computeLifecycle({
        heat: 100, peakHeat: 100, firstSeenAt: hoursAgo(2), lastSeenAt: NOW, source: 'douyin',
      }, NOW)).toBe('rising');
    });

    it('持续高热超过窗口 30% → peak', () => {
      expect(computeLifecycle({
        heat: 90, peakHeat: 100, firstSeenAt: hoursAgo(20), lastSeenAt: NOW, source: 'douyin',
      }, NOW)).toBe('peak');
    });

    it('热度衰退到峰值 60% → cooling', () => {
      expect(computeLifecycle({
        heat: 50, peakHeat: 100, firstSeenAt: hoursAgo(20), lastSeenAt: NOW, source: 'douyin',
      }, NOW)).toBe('cooling');
    });

    it('超过平台窗口未更新 → faded', () => {
      expect(computeLifecycle({
        heat: 80, peakHeat: 100, firstSeenAt: hoursAgo(72), lastSeenAt: hoursAgo(48), source: 'douyin',
      }, NOW)).toBe('faded');
    });

    it('小红书长窗口下同样年龄仍是 peak', () => {
      expect(computeLifecycle({
        heat: 80, peakHeat: 100, firstSeenAt: hoursAgo(48), lastSeenAt: NOW, source: 'xiaohongshu',
      }, NOW)).toBe('peak');
    });
  });

  describe('timeDecayFactor', () => {
    it('rising 话题 → 高衰减因子', () => {
      const f = timeDecayFactor({ lifecycle: 'rising', firstSeenAt: hoursAgo(2), source: 'douyin' }, NOW);
      expect(f).toBeGreaterThan(0.9);
    });

    it('cooling → 固定 0.4', () => {
      expect(timeDecayFactor({ lifecycle: 'cooling', firstSeenAt: hoursAgo(24), source: 'douyin' }, NOW)).toBe(0.4);
    });

    it('faded → 固定 0.1', () => {
      expect(timeDecayFactor({ lifecycle: 'faded', firstSeenAt: hoursAgo(72), source: 'douyin' }, NOW)).toBe(0.1);
    });

    it('peak 随年龄衰减但不低于 0.3', () => {
      const f = timeDecayFactor({ lifecycle: 'peak', firstSeenAt: hoursAgo(100), source: 'douyin' }, NOW);
      expect(f).toBeGreaterThanOrEqual(0.3);
    });
  });

  describe('platformWindowHours', () => {
    it('抖音/微博 36h', () => {
      expect(platformWindowHours('douyin')).toBe(36);
      expect(platformWindowHours('weibo')).toBe(36);
    });

    it('B站/YouTube 240h', () => {
      expect(platformWindowHours('bilibili')).toBe(240);
      expect(platformWindowHours('youtube')).toBe(240);
    });

    it('未知平台 → 48h 默认', () => {
      expect(platformWindowHours('unknown')).toBe(48);
    });
  });
});
