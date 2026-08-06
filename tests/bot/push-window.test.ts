import { describe, it, expect } from 'vitest';
import { parsePushSchedule, isPushDue, beijingMinuteOfDay, PUSH_TICK_MINUTES } from '@/lib/bot/push-window';

// 机器人「每日定时推送时间」的到点判定。
// 【为什么单独钉】2026-07-28 用户反馈：设置页设的是 9 点，实际北京 13:00 才收到晨报。
// 真因有两层——(1) 容器跑 UTC，cron 全体偏 8 小时；(2) pushSchedule 这个设置根本没人读，
// 推送时刻实际等于 daily_recommend 的 cron。这里锁第二层：时刻必须来自用户的设置，且按北京时间算。

// 北京时间 → UTC Date（容器时区任意，测试结果必须一致）
const bj = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 28, h - 8, m));

describe('parsePushSchedule', () => {
  it('单个时刻 → 当日分钟数', () => {
    expect(parsePushSchedule('09:00')).toEqual([540]);
  });

  it('多个时刻（半角/全角逗号都认）', () => {
    expect(parsePushSchedule('09:00,18:00')).toEqual([540, 1080]);
    expect(parsePushSchedule('08:30，21:00')).toEqual([510, 1260]);
  });

  it('容错：空格、个位数、重复项', () => {
    expect(parsePushSchedule(' 9:5 ')).toEqual([545]);
    expect(parsePushSchedule('09:00,09:00')).toEqual([540]);
  });

  it('非法值丢弃而不是当 0 点：空/乱填/越界都不该变成半夜推送', () => {
    expect(parsePushSchedule('')).toEqual([]);
    expect(parsePushSchedule(null)).toEqual([]);
    expect(parsePushSchedule('每天早上')).toEqual([]);
    expect(parsePushSchedule('25:00')).toEqual([]);
    expect(parsePushSchedule('09:70')).toEqual([]);
  });
});

describe('beijingMinuteOfDay · 不受容器时区影响', () => {
  it('UTC 01:00 = 北京 09:00', () => {
    expect(beijingMinuteOfDay(new Date('2026-07-28T01:00:00Z'))).toBe(9 * 60);
  });

  it('UTC 20:00 = 次日北京 04:00（跨日取模）', () => {
    expect(beijingMinuteOfDay(new Date('2026-07-28T20:00:00Z'))).toBe(4 * 60);
  });
});

describe('isPushDue', () => {
  it('设 09:00 → 北京 09:00 那一跳推', () => {
    expect(isPushDue('09:00', bj(9, 0))).toBe(true);
  });

  it('【回归】设 09:00 → 北京 13:00 绝不推（用户实际遇到的错时）', () => {
    expect(isPushDue('09:00', bj(13, 0))).toBe(false);
  });

  it('绝不早推：08:50 那一跳不算到点', () => {
    expect(isPushDue('09:00', bj(8, 50))).toBe(false);
  });

  it('非整跳的时刻在下一跳补上（09:05 → 09:10 那一跳），最多晚一个跳', () => {
    expect(isPushDue('09:05', bj(9, 0))).toBe(false);
    expect(isPushDue('09:05', bj(9, 10))).toBe(true);
  });

  it('一天只命中一次：09:00 之后的每一跳都不再推', () => {
    const hits = Array.from({ length: 1440 / PUSH_TICK_MINUTES }, (_, i) =>
      isPushDue('09:00', new Date(bj(0, 0).getTime() + i * PUSH_TICK_MINUTES * 60_000)),
    ).filter(Boolean);
    expect(hits).toHaveLength(1);
  });

  it('多时刻各自命中', () => {
    expect(isPushDue('09:00,18:00', bj(9, 0))).toBe(true);
    expect(isPushDue('09:00,18:00', bj(18, 0))).toBe(true);
    expect(isPushDue('09:00,18:00', bj(12, 0))).toBe(false);
  });

  it('跨零点不漏：设 00:00 在北京 00:00 那一跳推，23:50 不推', () => {
    expect(isPushDue('00:00', bj(0, 0))).toBe(true);
    expect(isPushDue('00:00', bj(23, 50))).toBe(false);
  });

  it('没配（空串）就不推，而不是每跳都推', () => {
    expect(isPushDue('', bj(9, 0))).toBe(false);
  });
});
