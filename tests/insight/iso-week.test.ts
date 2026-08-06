import { describe, it, expect } from 'vitest';
import { isoWeek } from '@/lib/insight/review';

// ISO-8601 周号。它同时是 ReviewReport.period —— 既是用户看到的标签，也是「同一周只出一份」
// 的去重键，标错就等于去重错 + 归错年份。
//
// 此前实现是 ceil(当年第几天 / 7)：既不对齐周一，也不处理跨年周。
// 下面这些是权威边界用例（周一为一周之始，第 1 周 = 包含当年第一个周四的那一周）。
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);

describe('isoWeek · ISO-8601 边界', () => {
  it('跨年周归属上一年：2027-01-01（周五）属 2026-W53', () => {
    expect(isoWeek(at('2027-01-01'))).toBe('2026-W53');
    expect(isoWeek(at('2026-12-31'))).toBe('2026-W53');
  });

  it('跨年周归属上一年：2021-01-01（周五）属 2020-W53', () => {
    expect(isoWeek(at('2021-01-01'))).toBe('2020-W53');
    expect(isoWeek(at('2020-12-28'))).toBe('2020-W53');
  });

  it('跨年周归属下一年：2019-12-30（周一）属 2020-W01', () => {
    expect(isoWeek(at('2019-12-30'))).toBe('2020-W01');
    expect(isoWeek(at('2024-12-30'))).toBe('2025-W01');
  });

  it('年初为周四时属本年 W01：2026-01-01', () => {
    expect(isoWeek(at('2026-01-01'))).toBe('2026-W01');
  });

  it('年初为周日时属上一年末周：2023-01-01 属 2022-W52', () => {
    expect(isoWeek(at('2023-01-01'))).toBe('2022-W52');
  });

  it('年中普通周', () => {
    expect(isoWeek(at('2026-07-25'))).toBe('2026-W30');
  });

  it('同一周内每一天（周一→周日）得到同一个周号——否则一周会出多份周报', () => {
    // 2026-07-20 是周一
    const days = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26'];
    const weeks = new Set(days.map((d) => isoWeek(at(d))));
    expect([...weeks]).toEqual(['2026-W30']);
  });

  it('相邻周的周号必须不同（跨周一切换）', () => {
    expect(isoWeek(at('2026-07-26'))).toBe('2026-W30'); // 周日
    expect(isoWeek(at('2026-07-27'))).toBe('2026-W31'); // 下周一
  });

  it('周号始终两位补零', () => {
    expect(isoWeek(at('2026-01-05'))).toMatch(/^\d{4}-W\d{2}$/);
    expect(isoWeek(at('2026-01-05'))).toBe('2026-W02');
  });
});
