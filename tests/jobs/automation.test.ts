import { describe, it, expect } from 'vitest';
import { readAutomationConfig, automationAllows, sanitizeAutomationConfig, AUTOMATION_ITEMS } from '@/lib/jobs/automation';

// 自动化开关：缺省取默认（保持既有全自动行为）、只认已知 key 的布尔、合并清洗。

describe('readAutomationConfig', () => {
  it('缺省 → 取各自默认（多数开，预警默认关）', () => {
    const c = readAutomationConfig('{}');
    expect(c.dailyRecommend).toBe(true);
    expect(c.autoBackfill).toBe(true);
    expect(c.autoReview).toBe(true);
    expect(c.weeklyReview).toBe(true);
    expect(c.optimizeMemory).toBe(true);
    expect(c.alerts).toBe(false); // 打扰型 opt-in
  });
  it('null / 非法 JSON → 默认', () => {
    expect(readAutomationConfig(null).dailyRecommend).toBe(true);
    expect(readAutomationConfig('not json').autoReview).toBe(true);
  });
  it('显式 false 生效', () => {
    const c = readAutomationConfig(JSON.stringify({ dailyRecommend: false, autoReview: false }));
    expect(c.dailyRecommend).toBe(false);
    expect(c.autoReview).toBe(false);
    expect(c.autoBackfill).toBe(true); // 未提及仍默认开
  });
  it('未知 key / 非布尔值被忽略', () => {
    const c = readAutomationConfig(JSON.stringify({ evil: true, dailyRecommend: 'yes' }));
    expect((c as Record<string, unknown>).evil).toBeUndefined();
    expect(c.dailyRecommend).toBe(true); // 'yes' 非布尔 → 保持默认
  });
});

describe('automationAllows', () => {
  it('缺省允许', () => {
    expect(automationAllows('{}', 'autoReview')).toBe(true);
  });
  it('关闭后不允许', () => {
    expect(automationAllows(JSON.stringify({ autoReview: false }), 'autoReview')).toBe(false);
  });
});

describe('sanitizeAutomationConfig', () => {
  it('合并 patch，只认已知布尔 key', () => {
    const merged = sanitizeAutomationConfig(JSON.stringify({ dailyRecommend: false }), { autoReview: false, junk: 1 });
    expect(merged.dailyRecommend).toBe(false); // 保留原
    expect(merged.autoReview).toBe(false); // patch 生效
    expect((merged as Record<string, unknown>).junk).toBeUndefined();
  });
});

describe('AUTOMATION_ITEMS 契约', () => {
  it('每项都有默认值；job 为任务名或 null（事件驱动）', () => {
    for (const it of AUTOMATION_ITEMS) {
      expect(it.job === null || typeof it.job === 'string').toBe(true);
      expect(typeof it.default).toBe('boolean');
    }
    // 预警是事件驱动，无对应定时任务
    expect(AUTOMATION_ITEMS.find((i) => i.key === 'alerts')?.job).toBeNull();
  });
});
