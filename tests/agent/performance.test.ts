import { describe, it, expect } from 'vitest';
import { computeMetrics, groupFailureReasons, MIN_SAMPLES, METRIC_VERSION } from '@/lib/agent/performance';

// 可解释绩效 v1（2026-09-11 P2）：五项各自可下钻；样本不足显示不足不补分；不做总分。

const run = (status: string, minutes: number) => ({ status, createdAt: new Date(0), updatedAt: new Date(minutes * 60_000) });

describe('computeMetrics', () => {
  it('五项、带版本、没有总分', () => {
    const m = computeMetrics({ runs: [], accepted: 0, reviewed: 0, reworkTotalOfAccepted: 0, leadMinutes: [], costUsdOfAccepted: 0 }, '/x');
    expect(m.map((x) => x.key)).toEqual(['reliability', 'leadTime', 'acceptance', 'rework', 'unitCost']);
    expect(METRIC_VERSION).toBe('v1');
    expect(m.every((x) => x.value === null)).toBe(true);
  });
  it(`样本不足 ${MIN_SAMPLES} 就是 null，不补 0 也不补 100`, () => {
    const m = computeMetrics({ runs: [run('done', 5), run('done', 7)], accepted: 1, reviewed: 1, reworkTotalOfAccepted: 0, leadMinutes: [30], costUsdOfAccepted: 1 }, '/x');
    expect(m.find((x) => x.key === 'reliability')!.value).toBeNull();
    expect(m.find((x) => x.key === 'unitCost')!.value).toBeNull();
  });
  it('够样本时按定义算：可靠性不数取消；时效是工单建单→验收的中位数；单位成本 = 验收工单挂的运行成本 / 验收数', () => {
    const m = computeMetrics({ runs: [run('done', 5), run('done', 7), run('failed', 1), run('cancelled', 1), run('done', 100)], accepted: 4, reviewed: 5, reworkTotalOfAccepted: 2, leadMinutes: [5, 7, 100, 9], costUsdOfAccepted: 2 }, '/x');
    expect(m.find((x) => x.key === 'reliability')!.value).toBe(75);
    expect(m.find((x) => x.key === 'leadTime')!.value).toBe(8);
    expect(m.find((x) => x.key === 'acceptance')!.value).toBe(80);
    expect(m.find((x) => x.key === 'rework')!.value).toBe(0.5);
    expect(m.find((x) => x.key === 'unitCost')!.value).toBe(0.5);
  });
});

describe('groupFailureReasons', () => {
  it('按前缀聚合、按次数排序、空当未知', () => {
    const g = groupFailureReasons(['模板不存在', '模板不存在', null, '额度用完了']);
    expect(g[0]).toEqual({ reason: '模板不存在', count: 2 });
    expect(g.some((x) => x.reason === '未知原因')).toBe(true);
  });
});
