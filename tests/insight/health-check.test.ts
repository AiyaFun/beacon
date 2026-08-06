import { describe, it, expect } from 'vitest';
import { checkDataHealth, type HealthRecord } from '@/lib/insight/health-check';

// 数据体检：缺链接/疑似重复/异常快照/僵尸记录四类检测。检测→建议，绝不改数据。

const NOW = Date.UTC(2026, 6, 21, 0, 0, 0);
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

const rec = (over: Partial<HealthRecord> = {}): HealthRecord => ({
  id: Math.random().toString(36).slice(2),
  platform: 'douyin',
  title: '一条正常内容标题',
  publishedAt: daysAgo(3),
  needsBackfill: false,
  metrics: JSON.stringify({ views: 1000 }),
  snapshots: [],
  ...over,
});

describe('checkDataHealth', () => {
  it('缺链接记录 → missing_link', () => {
    const issues = checkDataHealth([rec({ needsBackfill: true }), rec({ needsBackfill: true }), rec()], NOW);
    const m = issues.find((i) => i.kind === 'missing_link');
    expect(m).toBeTruthy();
    expect(m!.refIds).toHaveLength(2);
  });

  it('同平台+同标题+发布日相近 → duplicate', () => {
    const issues = checkDataHealth(
      [
        rec({ id: 'a', title: '重复的选题标题', publishedAt: daysAgo(3) }),
        rec({ id: 'b', title: '重复的选题标题', publishedAt: daysAgo(3) }),
      ],
      NOW,
    );
    const d = issues.find((i) => i.kind === 'duplicate');
    expect(d).toBeTruthy();
    expect(new Set(d!.refIds)).toEqual(new Set(['a', 'b']));
  });

  it('不同平台同标题 → 不算重复', () => {
    const issues = checkDataHealth(
      [rec({ title: '同名标题', platform: 'douyin' }), rec({ title: '同名标题', platform: 'wechat' })],
      NOW,
    );
    expect(issues.some((i) => i.kind === 'duplicate')).toBe(false);
  });

  it('发布日相差超1天 → 不算重复', () => {
    const issues = checkDataHealth(
      [rec({ title: '同名标题内容', publishedAt: daysAgo(3) }), rec({ title: '同名标题内容', publishedAt: daysAgo(6) })],
      NOW,
    );
    expect(issues.some((i) => i.kind === 'duplicate')).toBe(false);
  });

  it('累计播放倒退 → anomaly', () => {
    const issues = checkDataHealth(
      [
        rec({
          snapshots: [
            { takenAt: daysAgo(2), metrics: JSON.stringify({ views: 5000 }) },
            { takenAt: daysAgo(1), metrics: JSON.stringify({ views: 3000 }) }, // 倒退
          ],
        }),
      ],
      NOW,
    );
    expect(issues.some((i) => i.kind === 'anomaly')).toBe(true);
  });

  it('正常增长 → 无 anomaly', () => {
    const issues = checkDataHealth(
      [
        rec({
          snapshots: [
            { takenAt: daysAgo(2), metrics: JSON.stringify({ views: 3000 }) },
            { takenAt: daysAgo(1), metrics: JSON.stringify({ views: 5000 }) },
          ],
        }),
      ],
      NOW,
    );
    expect(issues.some((i) => i.kind === 'anomaly')).toBe(false);
  });

  it('发布超30天且零数据 → stale', () => {
    const issues = checkDataHealth([rec({ publishedAt: daysAgo(40), metrics: JSON.stringify({ views: 0 }) })], NOW);
    expect(issues.some((i) => i.kind === 'stale')).toBe(true);
  });

  it('干净数据 → 无问题', () => {
    expect(checkDataHealth([rec(), rec({ id: 'x', title: '另一条不同的标题' })], NOW)).toHaveLength(0);
  });
});
