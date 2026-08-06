import { describe, it, expect } from 'vitest';
import { trialProgress } from '@/lib/pay/trial';
import { TRIAL_DAYS } from '@/lib/pay/pricing';
import { DAY_MS } from '@/lib/pay/plan';

// 试用进度纯函数。固定 now，用「到期日 = now + N 天」构造各阶段。
const NOW = new Date('2026-07-24T12:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

describe('trialProgress · 只有 trial 且未过期才算试用中', () => {
  it('免费档 → 非试用', () => {
    expect(trialProgress('free', null, NOW).isTrial).toBe(false);
  });

  it('付费档（personal）→ 非试用（即便有到期日）', () => {
    expect(trialProgress('personal', inDays(20), NOW).isTrial).toBe(false);
  });

  it('trial 但无到期日 → 非试用（防脏数据）', () => {
    expect(trialProgress('trial', null, NOW).isTrial).toBe(false);
  });

  it('trial 已过期 → 非试用（交给到期提示，不再显示进度）', () => {
    expect(trialProgress('trial', inDays(-1), NOW).isTrial).toBe(false);
  });

  it('trial 且未过期 → 试用中', () => {
    expect(trialProgress('trial', inDays(10), NOW).isTrial).toBe(true);
  });
});

describe('trialProgress · 天数与进度', () => {
  it('刚开始（剩 30 天）→ 第 1 天，进度 0%', () => {
    const r = trialProgress('trial', inDays(TRIAL_DAYS), NOW);
    expect(r.remaining).toBe(TRIAL_DAYS);
    expect(r.dayNumber).toBe(1);
    expect(r.pct).toBe(0);
  });

  it('过半（剩 15 天）→ 第 16 天，进度 50%', () => {
    const r = trialProgress('trial', inDays(15), NOW);
    expect(r.remaining).toBe(15);
    expect(r.dayNumber).toBe(16);
    expect(r.pct).toBe(50);
  });

  it('剩不到 1 天（还剩几小时）→ 向上取整算 1 天，仍是试用中', () => {
    const r = trialProgress('trial', new Date(NOW.getTime() + 3 * 3600_000), NOW);
    expect(r.isTrial).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it('dayNumber 不超过 TRIAL_DAYS，pct 不超过 100', () => {
    const r = trialProgress('trial', new Date(NOW.getTime() + 1000), NOW); // 剩 1 秒
    expect(r.dayNumber).toBeLessThanOrEqual(TRIAL_DAYS);
    expect(r.pct).toBeLessThanOrEqual(100);
  });
});

describe('trialProgress · 临期提醒', () => {
  it('剩 5 天 → nearingEnd=true', () => {
    expect(trialProgress('trial', inDays(5), NOW).nearingEnd).toBe(true);
  });
  it('剩 6 天 → nearingEnd=false', () => {
    expect(trialProgress('trial', inDays(6), NOW).nearingEnd).toBe(false);
  });
});

describe('trialProgress · 里程碑到达状态', () => {
  it('第 1 天：只到达 Day1', () => {
    const r = trialProgress('trial', inDays(TRIAL_DAYS), NOW);
    expect(r.milestones.map((m) => m.reached)).toEqual([true, false, false]);
  });

  it('第 16 天：到达 Day1 + Day7，未到 Day25', () => {
    const r = trialProgress('trial', inDays(15), NOW);
    expect(r.milestones.find((m) => m.day === 7)?.reached).toBe(true);
    expect(r.milestones.find((m) => m.day === 25)?.reached).toBe(false);
  });

  it('剩 3 天（第 28 天）：三个里程碑全到达', () => {
    const r = trialProgress('trial', inDays(3), NOW);
    expect(r.milestones.every((m) => m.reached)).toBe(true);
  });

  it('非试用时里程碑全 false（空壳）', () => {
    expect(trialProgress('free', null, NOW).milestones.every((m) => !m.reached)).toBe(true);
  });
});
