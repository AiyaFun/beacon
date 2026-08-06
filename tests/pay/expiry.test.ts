import { describe, it, expect } from 'vitest';
import { expiryNoticeFor, sentStagesFrom, EXPIRED_GRACE_DAYS } from '@/lib/pay/expiry';
import { DAY_MS } from '@/lib/pay/plan';

// 到期提醒的决策层。这块要守住的性质，每一条都对应一种「用户没收到 / 被骚扰」的真实后果。

const now = new Date('2026-08-01T02:00:00Z');
const inDays = (n: number) => new Date(now.getTime() + n * DAY_MS);

describe('expiryNoticeFor 档位判定', () => {
  it('剩 7 天 → d7', () => {
    const n = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(7), now });
    expect(n?.stage).toBe('d7');
    expect(n?.title).toContain('标准版');
    expect(n?.title).toContain('7 天');
  });

  it('剩 3 天且 d7 已发过 → d3（不重复发 d7）', () => {
    const n = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(3), now, sentStages: ['d7'] });
    expect(n?.stage).toBe('d3');
  });

  it('同一档已发过 → 不再发（幂等）', () => {
    const n = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(7), now, sentStages: ['d7'] });
    expect(n).toBeNull();
  });

  it('漏跑几天后剩 2 天 → 直接发 d3，不补发 d7', () => {
    // 用「≤ 阈值」而非「== N」的原因：worker 重启漏跑一天，在 == 判据下那一档永久跳过。
    const n = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(2), now });
    expect(n?.stage).toBe('d3');
  });

  it('已过期 → expired，且文案明说数据保留', () => {
    const n = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(-1), now, sentStages: ['d7', 'd3', 'd1'] });
    expect(n?.stage).toBe('expired');
    expect(n?.body).toContain('保留');
  });

  it('过期超过宽限期 → 不再骚扰', () => {
    const n = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(-(EXPIRED_GRACE_DAYS + 1)), now });
    expect(n).toBeNull();
  });
});

describe('哪些档位不该被提醒', () => {
  it('free 档没有「到期」这回事', () => {
    expect(expiryNoticeFor({ plan: 'free', planExpiresAt: inDays(1), now })).toBeNull();
  });

  it('planExpiresAt=null 语义是永不过期（运营手工开通），不提醒', () => {
    expect(expiryNoticeFor({ plan: 'enterprise', planExpiresAt: null, now })).toBeNull();
  });

  it('永久买断（99 年）自然落在窗口外，不需要特判', () => {
    expect(expiryNoticeFor({ plan: 'byok', planExpiresAt: inDays(1188 * 30), now })).toBeNull();
  });

  it('试用一并覆盖，且文案与付费档不同（到期转化是试用的意义）', () => {
    const n = expiryNoticeFor({ plan: 'trial', planExpiresAt: inDays(3), now });
    expect(n?.isTrial).toBe(true);
    expect(n?.title).toContain('试用');
    expect(n?.body).toContain('产出账本');
  });
});

describe('去重键', () => {
  it('refId 含到期时刻 —— 续费后开启新一轮提醒', () => {
    const first = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(1), now })!;
    // 用户续费 1 个月：到期日变了
    const renewed = expiryNoticeFor({ plan: 'personal', planExpiresAt: inDays(31), now, sentStages: sentStagesFrom([first.refId], inDays(31)) });
    // 新周期离到期还有 31 天，本轮无提醒；但关键是旧 refId 不该被算成新周期已发
    expect(sentStagesFrom([first.refId], inDays(31))).toEqual([]);
    expect(renewed).toBeNull();
  });

  it('sentStagesFrom 只认本周期的 refId', () => {
    const expiresAt = inDays(3);
    const mine = `plan-expiry:${expiresAt.toISOString()}:d7`;
    const other = `plan-expiry:${inDays(99).toISOString()}:d3`;
    expect(sentStagesFrom([mine, other, null, 'weekly:xx'], expiresAt)).toEqual(['d7']);
  });
});
