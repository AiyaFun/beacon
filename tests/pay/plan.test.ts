import { describe, it, expect } from 'vitest';
import { effectivePlan, isPlanExpired, addMonths, computeGrant, assertCanPurchase, DAY_MS } from '@/lib/pay/plan';
import { amountFenFor, dailyFenOf, descriptionFor, isPaidPlan, isPeriodMonths, LIFETIME_MONTHS, PRICING, TRIAL_DAYS } from '@/lib/pay/pricing';

const T0 = new Date('2026-07-17T12:00:00+08:00');
const day = (n: number) => new Date(T0.getTime() + n * DAY_MS);

describe('pay/pricing · 金额只能服务端算', () => {
  it('按 plan × 时长出价', () => {
    expect(amountFenFor('personal', 1)).toBe(12_900);
    expect(amountFenFor('personal', 12)).toBe(129_000);
    expect(amountFenFor('byok', 1)).toBe(6_900);
    expect(amountFenFor('byok', 12)).toBe(69_000);
  });

  it('🔒 非法档位/时长直接抛，不给「回退默认价」留缝', () => {
    expect(() => amountFenFor('free', 1)).toThrow(/不可下单/);
    expect(() => amountFenFor('trial', 1)).toThrow(/不可下单/); // 试用是白送的，不是商品
    expect(() => amountFenFor('enterprise', 1)).toThrow(/不可下单/); // 企业版不自助售卖
    expect(() => amountFenFor('team', 1)).toThrow(/不可下单/); // 团队版已下线（2026-07）
    expect(() => amountFenFor('bogus', 1)).toThrow(/不可下单/);
    expect(() => amountFenFor('personal', 3)).toThrow(/购买时长/);
    expect(() => amountFenFor('personal', 0)).toThrow(/购买时长/);
    expect(() => amountFenFor('personal', -1)).toThrow(/购买时长/);
    expect(() => amountFenFor('personal', 1.5)).toThrow(/购买时长/);
  });

  it('全部是正整数分（微信 amount.total 必须是整数分且 > 0）', () => {
    for (const p of ['personal', 'byok'] as const) {
      for (const m of [1, 12] as const) {
        const fen = amountFenFor(p, m);
        expect(Number.isInteger(fen)).toBe(true);
        expect(fen).toBeGreaterThan(0);
      }
    }
  });

  it('标准版定价落在 PRD 给的 ¥99-199/月区间内；自带 Key 版低于标准版（让利≈平台垫的 token 钱）', () => {
    expect(PRICING.personal.monthFen).toBeGreaterThanOrEqual(9_900);
    expect(PRICING.personal.monthFen).toBeLessThanOrEqual(19_900);
    expect(PRICING.byok.monthFen).toBe(6_900);
    expect(PRICING.byok.monthFen).toBeLessThan(PRICING.personal.monthFen);
  });

  it('注册送的试用天数 = 30', () => {
    expect(TRIAL_DAYS).toBe(30);
  });

  it('年付比月付×12 便宜（付 10 个月）', () => {
    for (const p of ['personal', 'byok'] as const) {
      expect(PRICING[p].yearFen).toBe(PRICING[p].monthFen * 10);
      expect(PRICING[p].yearFen).toBeLessThan(PRICING[p].monthFen * 12);
    }
  });

  it('档位单调：标准版日单价高于自带 Key 版', () => {
    expect(dailyFenOf('personal')).toBeGreaterThan(dailyFenOf('byok'));
    expect(dailyFenOf('free')).toBe(0); // free 没有残值
    expect(dailyFenOf('trial')).toBe(0); // 白送的试用没有残值 —— 否则试用期升档会折算出白送的天数
    expect(dailyFenOf('bogus')).toBe(0);
  });

  it('枚举守卫', () => {
    expect(isPaidPlan('personal')).toBe(true);
    expect(isPaidPlan('byok')).toBe(true);
    expect(isPaidPlan('free')).toBe(false);
    expect(isPaidPlan('trial')).toBe(false); // 关键不变式：trial 非付费档，购买闸门按 free 对待
    expect(isPaidPlan('team')).toBe(false); // 已下线
    expect(isPaidPlan('enterprise')).toBe(false);
    expect(isPeriodMonths(1)).toBe(true);
    expect(isPeriodMonths(12)).toBe(true);
    expect(isPeriodMonths('1')).toBe(false);
    expect(isPeriodMonths(6)).toBe(false);
  });

  it('商品描述不含 emoji（APIv3 只收 1-3 字节 UTF-8）', () => {
    for (const p of ['personal', 'byok'] as const) {
      const d = descriptionFor(p, 12);
      for (const ch of d) expect(Buffer.from(ch, 'utf8').length).toBeLessThanOrEqual(3);
      expect(d.length).toBeLessThanOrEqual(127);
    }
  });
});

describe('pay/plan · 到期判断（懒判断，不依赖 cron）', () => {
  it('未到期 → 原档', () => {
    expect(effectivePlan('personal', day(10), T0)).toBe('personal');
    expect(effectivePlan('byok', day(10), T0)).toBe('byok');
  });

  it('🔒 已到期 → 按 free 算（这就是「到期降档」的实现，没有 job 也一定生效）', () => {
    expect(effectivePlan('personal', day(-1), T0)).toBe('free');
    expect(effectivePlan('byok', day(-1), T0)).toBe('free');
  });

  it('🔒 试用期同样走懒判定：试用中 → trial，试用到期 → free', () => {
    expect(effectivePlan('trial', day(10), T0)).toBe('trial');
    expect(effectivePlan('trial', day(-1), T0)).toBe('free');
    expect(isPlanExpired('trial', day(-1), T0)).toBe(true);
  });

  it('🔒 恰好到期的那一刻 → 已过期（边界不该放行）', () => {
    expect(effectivePlan('personal', T0, T0)).toBe('free');
    expect(isPlanExpired('personal', T0, T0)).toBe(true);
  });

  it('到期前 1 毫秒 → 仍有效（边界不该早降）', () => {
    expect(effectivePlan('personal', new Date(T0.getTime() + 1), T0)).toBe('personal');
  });

  it('free 档忽略到期时间', () => {
    expect(effectivePlan('free', day(-100), T0)).toBe('free');
    expect(isPlanExpired('free', day(-100), T0)).toBe(false);
  });

  it('planExpiresAt=null → 永不过期（运营手工开通的租户不该被静默降档）', () => {
    expect(effectivePlan('enterprise', null, T0)).toBe('enterprise');
    expect(isPlanExpired('enterprise', null, T0)).toBe(false);
  });

  it('null / undefined plan → free', () => {
    expect(effectivePlan(null, null, T0)).toBe('free');
    expect(effectivePlan(undefined, undefined, T0)).toBe('free');
  });
});

describe('pay/plan · addMonths 月末钳位', () => {
  it('1月31日 + 1月 = 2月28日（不是 JS 默认的 3月3日）', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00'), 1).getDate()).toBe(28);
    expect(addMonths(new Date('2026-01-31T10:00:00'), 1).getMonth()).toBe(1); // 2月
  });

  it('闰年 2 月', () => {
    expect(addMonths(new Date('2024-01-31T10:00:00'), 1).getDate()).toBe(29);
  });

  it('跨年', () => {
    const r = addMonths(new Date('2026-12-15T10:00:00'), 1);
    expect(r.getFullYear()).toBe(2027);
    expect(r.getMonth()).toBe(0);
  });

  it('加 12 个月 = 同月同日次年', () => {
    const r = addMonths(new Date('2026-07-17T10:00:00'), 12);
    expect(r.getFullYear()).toBe(2027);
    expect(r.getMonth()).toBe(6);
    expect(r.getDate()).toBe(17);
  });

  it('保留时分秒（到期时刻不该被抹成 0 点）', () => {
    const r = addMonths(new Date('2026-07-17T13:45:30'), 1);
    expect(r.getHours()).toBe(13);
    expect(r.getMinutes()).toBe(45);
  });
});

describe('pay/plan · computeGrant 三种情形', () => {
  it('fresh：free 用户首次购买 → 从 now 起算', () => {
    const g = computeGrant({ currentPlan: 'free', currentExpiresAt: null, newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.mode).toBe('fresh');
    expect(g.newExpiresAt).toEqual(addMonths(T0, 1));
    expect(g.bonusDays).toBe(0);
    expect(g.grantedDays).toBe(31); // 7/17 → 8/17
  });

  it('fresh：已过期的用户续费 → 从 now 起算，不叠加已过期的时长', () => {
    const g = computeGrant({ currentPlan: 'personal', currentExpiresAt: day(-30), newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.mode).toBe('fresh');
    expect(g.newExpiresAt).toEqual(addMonths(T0, 1));
  });

  it('🔒 试用期内购买 → fresh 从付款日起算，白送的试用**不做残值折算**（否则 30 天试用能折出免费天数）', () => {
    const g = computeGrant({ currentPlan: 'trial', currentExpiresAt: day(20), newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.mode).toBe('fresh');
    expect(g.bonusDays).toBe(0);
    expect(g.newExpiresAt).toEqual(addMonths(T0, 1));
    const gb = computeGrant({ currentPlan: 'trial', currentExpiresAt: day(20), newPlan: 'byok', periodMonths: 12, now: T0 });
    expect(gb.mode).toBe('fresh');
    expect(gb.bonusDays).toBe(0);
  });

  it('renew：同档未过期 → **叠加**（提前续费不被惩罚）', () => {
    const end = day(10);
    const g = computeGrant({ currentPlan: 'personal', currentExpiresAt: end, newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.mode).toBe('renew');
    expect(g.newExpiresAt).toEqual(addMonths(end, 1));
    expect(g.bonusDays).toBe(0);
  });

  it('renew：提前 10 天续费 vs 到期当天续费 —— 前者总时长更长，用户不吃亏', () => {
    const early = computeGrant({ currentPlan: 'byok', currentExpiresAt: day(10), newPlan: 'byok', periodMonths: 1, now: T0 });
    const onTime = computeGrant({ currentPlan: 'byok', currentExpiresAt: T0, newPlan: 'byok', periodMonths: 1, now: T0 });
    expect(early.newExpiresAt.getTime()).toBeGreaterThan(onTime.newExpiresAt.getTime());
  });

  it('upgrade：自带 Key 版剩 30 天 → 升标准版 1 个月，旧档残值折算成补偿天数', () => {
    const g = computeGrant({ currentPlan: 'byok', currentExpiresAt: day(30), newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.mode).toBe('upgrade');
    // 残值 = 30 天 × (6900/30) 分/天 = 6900 分；换算标准版 = 6900 ÷ (12900/30) ≈ 16.05 → 16 天
    expect(g.bonusDays).toBe(16);
    expect(g.newExpiresAt).toEqual(new Date(addMonths(T0, 1).getTime() + 16 * DAY_MS));
  });

  it('upgrade：剩余越多，补偿天数越多（折算是单调的）', () => {
    const a = computeGrant({ currentPlan: 'byok', currentExpiresAt: day(10), newPlan: 'personal', periodMonths: 1, now: T0 });
    const b = computeGrant({ currentPlan: 'byok', currentExpiresAt: day(300), newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(b.bonusDays).toBeGreaterThan(a.bonusDays);
  });

  it('upgrade：便宜档换贵档的天数比 1:1 少（标准版更贵，补偿天数被压缩）', () => {
    const g = computeGrant({ currentPlan: 'byok', currentExpiresAt: day(30), newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.bonusDays).toBeLessThan(30); // 不是「剩余时长原样带过去」那种白送
    expect(g.bonusDays).toBeGreaterThan(0); // 也不是「作废剩余」那种用户吃亏
  });

  it('upgrade：几乎到期时升档，补偿约等于 0（残值本来就没了）', () => {
    const g = computeGrant({ currentPlan: 'byok', currentExpiresAt: new Date(T0.getTime() + 1000), newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.bonusDays).toBe(0);
  });

  it('🔒 升档可能让到期日期**提前**（贵档同样的钱买到的天数更少）—— 这是折算的必然结果，不是 bug', () => {
    // 自带 Key 版剩 200 天（残值 ¥460）→ 买 1 个月标准版：
    // 残值折得 106 天标准版，+ 买的 31 天 = 137 天标准版，而原本还有 200 天自带 Key 版。
    // 到期日从 +200d 变成 +137d，但档位从自带 Key 版变成标准版。UI 必须让用户看见这一点。
    const g = computeGrant({ currentPlan: 'byok', currentExpiresAt: day(200), newPlan: 'personal', periodMonths: 1, now: T0 });
    expect(g.newExpiresAt.getTime()).toBeLessThan(day(200).getTime());
    // 而 grantedDays 的口径是「本单换来多少天新档」，恒为正 —— 早期版本拿
    // 「新到期日 - 旧到期日」当口径，这里会算出负数，那是口径选错不是算错。
    expect(g.grantedDays).toBe(137);
    expect(g.bonusDays).toBe(106);
  });

  it('grantedDays 是「本单发放了多少天」—— 客服解释口径，任何情形都必须为正', () => {
    for (const c of [
      { currentPlan: 'free', currentExpiresAt: null },
      { currentPlan: 'trial', currentExpiresAt: day(20) },
      { currentPlan: 'personal', currentExpiresAt: day(-5) },
      { currentPlan: 'personal', currentExpiresAt: day(20) },
      { currentPlan: 'byok', currentExpiresAt: day(200) },
    ] as const) {
      const g = computeGrant({ ...c, newPlan: 'personal', periodMonths: 1, now: T0 });
      expect(g.grantedDays).toBeGreaterThan(0);
    }
  });

  it('年付发放约 365 天', () => {
    const g = computeGrant({ currentPlan: 'free', currentExpiresAt: null, newPlan: 'personal', periodMonths: 12, now: T0 });
    expect(g.grantedDays).toBe(365);
  });
});

describe('pay/plan · assertCanPurchase 降档拦截', () => {
  it('free / 已过期 → 随便买', () => {
    expect(() => assertCanPurchase({ currentPlan: 'free', currentExpiresAt: null, newPlan: 'personal', now: T0 })).not.toThrow();
    expect(() => assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: day(-1), newPlan: 'byok', now: T0 })).not.toThrow();
  });

  // 回归：付费档 + 无到期日 = 永不过期（effectivePlan 的既定语义，运营手工开通/内部租户）。
  // 此前这里放行「随便买」，而 computeGrant 的 active 要求 currentExpiresAt !== null →
  // 走 fresh 分支，买一个月就把「永不过期」改写成「一个月后到期」，权益被无声降级且无残值补偿。
  // 与 enterprise 同样交人工处理，不猜用户意图。
  it('🔒 付费档 + 无到期日（永久有效）→ 拒绝自助购买，交客服处理', () => {
    expect(() => assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: null, newPlan: 'byok', now: T0 }))
      .toThrow(/永久有效/);
    // 同档、升档、买断一律拦（任何一种都会把 null 写成具体日期）
    expect(() => assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: null, newPlan: 'personal', now: T0 }))
      .toThrow(/永久有效/);
    expect(() => assertCanPurchase({ currentPlan: 'byok', currentExpiresAt: null, newPlan: 'personal', now: T0 }))
      .toThrow(/永久有效/);
    expect(() => assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: null, newPlan: 'byok', periodMonths: LIFETIME_MONTHS, now: T0 }))
      .toThrow(/永久有效/);
  });

  it('🔒 试用期内买任何档都放行（trial 非付费档，不触发降档拦截）——这是「注册即送」能成立的前提', () => {
    expect(() => assertCanPurchase({ currentPlan: 'trial', currentExpiresAt: day(20), newPlan: 'personal', now: T0 })).not.toThrow();
    expect(() => assertCanPurchase({ currentPlan: 'trial', currentExpiresAt: day(20), newPlan: 'byok', now: T0 })).not.toThrow();
  });

  it('同档续费 → 放行', () => {
    expect(() => assertCanPurchase({ currentPlan: 'byok', currentExpiresAt: day(10), newPlan: 'byok', now: T0 })).not.toThrow();
    expect(() => assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: day(10), newPlan: 'personal', now: T0 })).not.toThrow();
  });

  it('升档 → 放行', () => {
    expect(() => assertCanPurchase({ currentPlan: 'byok', currentExpiresAt: day(10), newPlan: 'personal', now: T0 })).not.toThrow();
  });

  it('🔒 标准版有效期内改买自带 Key 版 → 拒绝（否则标准版剩 300 天能折出约一年半自带 Key 版）', () => {
    expect(() => assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: day(300), newPlan: 'byok', now: T0 })).toThrow(/不能直接降档/);
  });

  it('拒绝文案是可直接展示的中文，并给出出路', () => {
    expect(() => assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: day(300), newPlan: 'byok', now: T0 })).toThrow(
      /到期后再购买|联系客服/,
    );
  });

  it('🔒 enterprise 有效期内自助买低档 → 拒绝（isPaidPlan("enterprise")=false 曾绕过降档闸门）', () => {
    expect(() => assertCanPurchase({ currentPlan: 'enterprise', currentExpiresAt: day(365), newPlan: 'personal', now: T0 })).toThrow(/企业版/);
    expect(() => assertCanPurchase({ currentPlan: 'enterprise', currentExpiresAt: day(365), newPlan: 'byok', now: T0 })).toThrow(/企业版/);
  });

  it('enterprise 永不过期（planExpiresAt=null）自助买低档 → 同样拒绝', () => {
    expect(() => assertCanPurchase({ currentPlan: 'enterprise', currentExpiresAt: null, newPlan: 'personal', now: T0 })).toThrow(/企业版/);
  });

  it('enterprise 已过期 → effectivePlan 降为 free → 放行', () => {
    expect(() => assertCanPurchase({ currentPlan: 'enterprise', currentExpiresAt: day(-1), newPlan: 'personal', now: T0 })).not.toThrow();
  });
});

describe('pay/pricing · 永久买断（自带 Key 版 ¥2999 / 99 年）', () => {
  it('byok 买断一口价 ¥2999，personal 不可买断', () => {
    expect(amountFenFor('byok', 1188)).toBe(299_900);
    expect(() => amountFenFor('personal', 1188)).toThrow(/买断仅支持自带 Key/);
  });

  it('isPeriodMonths 接受 1188；descriptionFor 显「永久买断」', () => {
    expect(isPeriodMonths(1188)).toBe(true);
    expect(isPeriodMonths(24)).toBe(false);
    expect(descriptionFor('byok', 1188)).toBe('烽火台 自带 Key 版 永久买断');
  });

  it('computeGrant 买断 → 从 now 起算约 99 年（1188 个月）', () => {
    const g = computeGrant({ currentPlan: 'free', currentExpiresAt: null, newPlan: 'byok', periodMonths: 1188, now: T0 });
    expect(g.mode).toBe('fresh');
    expect(g.newExpiresAt).toEqual(addMonths(T0, 1188));
    expect(g.grantedDays).toBeGreaterThan(35_000); // ~36135 天
  });

  it('byok 月付有效期内买断 → 从 now 起算，不叠加原到期（终态购买）', () => {
    const g = computeGrant({ currentPlan: 'byok', currentExpiresAt: day(15), newPlan: 'byok', periodMonths: 1188, now: T0 });
    expect(g.newExpiresAt).toEqual(addMonths(T0, 1188)); // 不是 day(15)+1188 个月
  });

  it('🔒 标准版有效期内买断 byok → 放行（买断不是降档）', () => {
    expect(() =>
      assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: day(200), newPlan: 'byok', periodMonths: 1188, now: T0 }),
    ).not.toThrow();
    // 对照：不带 periodMonths 的普通降档仍被拒
    expect(() =>
      assertCanPurchase({ currentPlan: 'personal', currentExpiresAt: day(200), newPlan: 'byok', now: T0 }),
    ).toThrow(/降档/);
  });
});
