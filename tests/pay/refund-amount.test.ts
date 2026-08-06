import { describe, it, expect } from 'vitest';
import { refundPolicyFor, type RefundableOrder } from '@/lib/pay/refund-amount';
import { DAY_MS } from '@/lib/pay/plan';
import { LIFETIME_MONTHS } from '@/lib/pay/pricing';

// 退款金额口径（纯函数）。now 注入，不读时钟。

const NOW = new Date('2026-07-17T12:00:00+08:00');
const day = (n: number) => new Date(NOW.getTime() + n * DAY_MS);

function order(over: Partial<RefundableOrder> = {}): RefundableOrder {
  return {
    amountFen: 12_900,
    periodMonths: 1,
    grantedDays: 30,
    paidAt: day(-10),
    newPlanExpiresAt: day(20), // 剩 20 天
    ...over,
  };
}

describe('pay/refund-amount · refundPolicyFor', () => {
  it('未消耗 → 全额退（consumedCount=0）', () => {
    const p = refundPolicyFor(order(), 0, NOW);
    expect(p.kind).toBe('full');
    expect(p.refundFen).toBe(12_900);
    expect(p.usedDays).toBe(0);
  });

  it('未消耗 → 买断也全额退', () => {
    const p = refundPolicyFor(order({ periodMonths: LIFETIME_MONTHS, amountFen: 299_900, grantedDays: 36_135, newPlanExpiresAt: day(36_135) }), 0, NOW);
    expect(p.kind).toBe('full');
    expect(p.refundFen).toBe(299_900);
  });

  it('已消耗 && 非买断 → 按剩余天数折算', () => {
    // 30 天里剩 20 天 → 12900 * 20/30 = 8600
    const p = refundPolicyFor(order(), 5, NOW);
    expect(p.kind).toBe('prorated');
    expect(p.totalDays).toBe(30);
    expect(p.remainingDays).toBe(20);
    expect(p.usedDays).toBe(10);
    expect(p.refundFen).toBe(8_600);
  });

  it('已消耗 && 已过期 → 折算为 0（剩余 0 天）', () => {
    const p = refundPolicyFor(order({ newPlanExpiresAt: day(-1) }), 3, NOW);
    expect(p.kind).toBe('prorated');
    expect(p.remainingDays).toBe(0);
    expect(p.refundFen).toBe(0);
  });

  it('🔒 已消耗 && 永久买断 → 转人工（防按天折算被薅）', () => {
    const p = refundPolicyFor(
      order({ periodMonths: LIFETIME_MONTHS, amountFen: 299_900, grantedDays: 36_135, newPlanExpiresAt: day(36_134) }),
      1,
      NOW,
    );
    expect(p.kind).toBe('manual');
    expect(p.refundFen).toBe(0);
    expect(p.reason).toMatch(/买断|客服/);
  });

  it('🔒 发放天数异常（grantedDays=0/null）&& 已消耗 → 转人工，绝不算错金额', () => {
    expect(refundPolicyFor(order({ grantedDays: 0 }), 2, NOW).kind).toBe('manual');
    expect(refundPolicyFor(order({ grantedDays: null }), 2, NOW).kind).toBe('manual');
  });

  it('折算金额恒在 [0, amountFen] 内，且为整数分', () => {
    for (const remaining of [-5, 0, 7, 15, 30, 40]) {
      const p = refundPolicyFor(order({ newPlanExpiresAt: day(remaining) }), 1, NOW);
      expect(Number.isInteger(p.refundFen)).toBe(true);
      expect(p.refundFen).toBeGreaterThanOrEqual(0);
      expect(p.refundFen).toBeLessThanOrEqual(12_900);
    }
  });
});
