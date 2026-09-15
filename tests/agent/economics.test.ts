import { describe, it, expect } from 'vitest';
import { summarizeCalls, budgetUsedPct, fmtUsd, type CallRow } from '@/lib/agent/economics';

// 运行经济账（2026-09-11 P0-4）：把「跑完了」改成「花了多少、真花还是 Mock、预算用了几成」。
// 汇总写错不会红，只会让界面上的账与账本对不上——所以逐条钉住口径。

const row = (p: Partial<CallRow> = {}): CallRow => ({
  source: 'platform', mocked: false, degraded: false, promptTokens: 100, completionTokens: 50, costUsd: 0.001, ...p,
});

describe('summarizeCalls：账本行 → 一份账', () => {
  it('空账本是零，不是 undefined', () => {
    const s = summarizeCalls([]);
    expect(s.calls).toBe(0);
    expect(s.costUsd).toBe(0);
    expect(s.bySource).toEqual({ platform: 0, byok: 0, mock: 0, unknown: 0 });
  });

  it('Mock 行不算真实调用，也不算钱和 token；degraded 只在 Mock 行上计数', () => {
    const s = summarizeCalls([row(), row({ mocked: true, degraded: true, source: 'mock', costUsd: 0 }), row({ mocked: true, source: 'mock', costUsd: 0 })]);
    expect(s.calls).toBe(1);
    expect(s.mockedCalls).toBe(2);
    expect(s.degradedCalls).toBe(1);
    expect(s.tokens).toBe(150);
    expect(s.costUsd).toBe(0.001);
  });

  it('钱是谁出的按 source 分桶；历史 unknown 如实归 unknown 不冒充 platform', () => {
    const s = summarizeCalls([row({ source: 'platform' }), row({ source: 'byok' }), row({ source: 'byok' }), row({ source: 'unknown' }), row({ source: '' })]);
    expect(s.bySource).toEqual({ platform: 1, byok: 2, mock: 0, unknown: 2 });
    expect(s.calls).toBe(5);
  });

  it('浮点累加不长尾巴', () => {
    const s = summarizeCalls(Array.from({ length: 10 }, () => row({ costUsd: 0.1 })));
    expect(s.costUsd).toBe(1);
  });
});

describe('budgetUsedPct：预算数的是调用次数', () => {
  it('30 次预算用了 15 次是 50%', () => expect(budgetUsedPct(15, 30)).toBe(50));
  it('超限如实超过 100', () => expect(budgetUsedPct(45, 30)).toBe(150));
  it('没有预算不是 0%，是 null', () => {
    expect(budgetUsedPct(3, 0)).toBeNull();
    expect(budgetUsedPct(3, -1)).toBeNull();
  });
});

describe('fmtUsd', () => {
  it('0 就是 $0；极小值不印成 $0.0000', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(0.00001)).toBe('不到 $0.0001');
    expect(fmtUsd(0.0042)).toBe('$0.0042');
    expect(fmtUsd(1.5)).toBe('$1.50');
  });
});
