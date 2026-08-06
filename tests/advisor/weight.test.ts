import { describe, it, expect } from 'vitest';
import { advisorWeight, dataDeltaFromNotes, type LearnedNote } from '@/lib/advisor/weight';

// W-5 权重层：人工采纳/否决之外，多了一条「发布数据说了算」的增量。
// 锁的是取舍本身——数据的话语权刻意小于人工判定，且封顶，防单一信号把人物顶到天花板。

const note = (verdict: LearnedNote['verdict']): LearnedNote => ({ verdict, text: 't', at: '2026-01-01T00:00:00.000Z' });

describe('智囊团人物权重 · 数据校准增量', () => {
  it('无数据结论时增量为 0，权重与旧公式完全一致（既有行为不变）', () => {
    const notes = [note('adopted'), note('rejected')];
    expect(dataDeltaFromNotes(notes)).toBe(0);
    expect(advisorWeight(3, 1, 'expert_data_analyst')).toBe(advisorWeight(3, 1, 'expert_data_analyst', 0));
    expect(advisorWeight(3, 1, 'expert_data_analyst')).toBeCloseTo(1.28, 2);
  });

  it('跑赢加权、跑输减权，且单次幅度小于一次人工采纳（0.12）', () => {
    expect(dataDeltaFromNotes([note('data_proven')])).toBeCloseTo(0.06, 2);
    expect(dataDeltaFromNotes([note('data_failed')])).toBeCloseTo(-0.05, 2);
    expect(Math.abs(dataDeltaFromNotes([note('data_proven')]))).toBeLessThan(0.12);
  });

  it('正反相抵，且总增量封顶 ±0.3（一串爆款也顶不穿）', () => {
    expect(dataDeltaFromNotes([note('data_proven'), note('data_failed')])).toBeCloseTo(0.01, 2);
    expect(dataDeltaFromNotes(Array.from({ length: 20 }, () => note('data_proven')))).toBe(0.3);
    expect(dataDeltaFromNotes(Array.from({ length: 20 }, () => note('data_failed')))).toBe(-0.3);
  });

  it('数据增量进入权重公式，但不突破人物的上下限', () => {
    expect(advisorWeight(0, 0, 'expert_data_analyst', 0.3)).toBeCloseTo(1.3, 2);
    // 唱反调者豁免降权：一路跑输也压不到 1 以下
    expect(advisorWeight(0, 5, 'expert_contrarian', -0.3)).toBe(1);
    // 普通人物下限 0.3、上限 2
    expect(advisorWeight(0, 20, 'expert_data_analyst', -0.3)).toBe(0.3);
    expect(advisorWeight(20, 0, 'expert_data_analyst', 0.3)).toBe(2);
  });
});
