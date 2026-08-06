import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { createOrder, fulfillOrder, syncOrderFromWechat, toRfc3339 } from '@/lib/pay/order';
import { MockPayProvider } from '@/lib/pay/mock';
import { effectivePlan } from '@/lib/pay/plan';
import { WxPayError, type CreateNativeParams, type CreateNativeResult, type PayProvider, type QueryResult } from '@/lib/pay/types';

// 走真 SQLite：要验的正是 DB 语义 —— 条件写的原子抢占、transactionId 唯一约束、事务里的
// 「订单状态 + 租户套餐」同生共死。把 prisma mock 掉就等于把要测的东西换成手写桩。

async function mkTenant(plan = 'free', planExpiresAt: Date | null = null) {
  const t = await prisma.tenant.create({ data: { name: '测试租户', plan, planExpiresAt } });
  const m = await prisma.member.create({ data: { tenantId: t.id, name: '所有者', role: 'owner' } });
  return { tenantId: t.id, memberId: m.id };
}

function mock() {
  return new MockPayProvider();
}

beforeEach(async () => {
  await prisma.wxPayNotifyLog.deleteMany();
  await prisma.paymentOrder.deleteMany();
  await prisma.member.deleteMany();
  await prisma.tenant.deleteMany();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe('pay/order · 下单', () => {
  it('金额由服务端按 plan+period 算', async () => {
    const { tenantId, memberId } = await mkTenant();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, mock());
    expect(r.amountFen).toBe(12_900);
    const o = await prisma.paymentOrder.findUnique({ where: { outTradeNo: r.outTradeNo } });
    expect(o?.amountFen).toBe(12_900);
    expect(o?.status).toBe('created');
    expect(o?.codeUrl).toMatch(/^weixin:\/\//);
    expect(o?.codeExpiresAt).toBeTruthy();
  });

  it('🔒 前端传的金额进不来：createOrder 的入参里根本没有 amount 字段', async () => {
    const { tenantId, memberId } = await mkTenant();
    // 就算调用方硬塞 amountFen: 1，类型层拦不住的话运行时也必须无视它
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1, amountFen: 1 } as never, mock());
    expect(r.amountFen).toBe(12_900); // 不是 1
  });

  it('🔒 非法档位/时长 → 拒绝下单', async () => {
    const { tenantId, memberId } = await mkTenant();
    await expect(createOrder({ tenantId, memberId, plan: 'free', periodMonths: 1 }, mock())).rejects.toThrow(/不可下单/);
    await expect(createOrder({ tenantId, memberId, plan: 'trial', periodMonths: 1 }, mock())).rejects.toThrow(/不可下单/);
    await expect(createOrder({ tenantId, memberId, plan: 'enterprise', periodMonths: 1 }, mock())).rejects.toThrow(/不可下单/);
    await expect(createOrder({ tenantId, memberId, plan: 'team', periodMonths: 1 }, mock())).rejects.toThrow(/不可下单/); // 已下线
    await expect(createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 3 }, mock())).rejects.toThrow(/购买时长/);
    expect(await prisma.paymentOrder.count()).toBe(0); // 一条脏单都不许留
  });

  it('订单号唯一且合法', async () => {
    const { tenantId, memberId } = await mkTenant();
    const nos = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, mock());
      expect(r.outTradeNo).toMatch(/^[0-9A-Za-z_|*-]{6,32}$/);
      nos.add(r.outTradeNo);
    }
    expect(nos.size).toBe(20);
  });

  it('🔒 微信下单失败 → 订单置 failed（否则会变成关单 job 永远扫不到的孤儿单）', async () => {
    // 关单 job 扫的是 { status:'created', codeExpiresAt: { lt: now } }，
    // 而下单失败时 codeExpiresAt 是 NULL —— NULL 不匹配任何比较，这单会永远留在库里。
    const { tenantId, memberId } = await mkTenant();
    const boom: PayProvider = {
      name: 'boom',
      mocked: true,
      async refund() { throw new Error('本 stub 不测退款'); },
      async queryRefund() { return { status: 'PROCESSING' as const }; },
      async createNative(): Promise<CreateNativeResult> {
        throw new WxPayError('NO_AUTH', '商户号该产品权限未开通', 403, 'req-1');
      },
      async queryByOutTradeNo(): Promise<QueryResult> {
        return { tradeState: 'NOTPAY' };
      },
    };
    await expect(createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, boom)).rejects.toThrow(/权限未开通/);
    const o = await prisma.paymentOrder.findFirst();
    expect(o?.status).toBe('failed');
    expect(o?.failReason).toMatch(/权限未开通/);
    expect(o?.closedAt).toBeTruthy();
    // 关键：不存在「status=created 且 codeExpiresAt=null」的孤儿单
    expect(await prisma.paymentOrder.count({ where: { status: 'created', codeExpiresAt: null } })).toBe(0);
  });

  it('🔒 有效期内降档 → 拒绝下单', async () => {
    const { tenantId, memberId } = await mkTenant('personal', new Date(Date.now() + 300 * 86_400_000));
    await expect(createOrder({ tenantId, memberId, plan: 'byok', periodMonths: 1 }, mock())).rejects.toThrow(/不能直接降档/);
  });

  it('试用期内下单任何档 → 放行（注册即送的 30 天不挡购买）', async () => {
    const { tenantId, memberId } = await mkTenant('trial', new Date(Date.now() + 20 * 86_400_000));
    const r = await createOrder({ tenantId, memberId, plan: 'byok', periodMonths: 1 }, mock());
    expect(r.amountFen).toBe(6_900);
  });
});

describe('pay/order · 兑现与幂等（漏了 = 用户付一次得两个月）', () => {
  async function seedOrder(plan: 'personal' | 'byok' = 'personal', months: 1 | 12 = 1) {
    const { tenantId, memberId } = await mkTenant();
    const r = await createOrder({ tenantId, memberId, plan, periodMonths: months }, mock());
    return { tenantId, outTradeNo: r.outTradeNo, amountFen: r.amountFen };
  }

  it('首次兑现 → 租户升档 + 订单转 paid + 审计字段落库', async () => {
    const { tenantId, outTradeNo, amountFen } = await seedOrder();
    const r = await fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen, source: 'notify' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.alreadyDone).toBe(false);

    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('personal');
    expect(t?.planExpiresAt).toBeTruthy();
    expect(effectivePlan(t!.plan, t!.planExpiresAt)).toBe('personal');

    const o = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    expect(o?.status).toBe('paid');
    expect(o?.transactionId).toBe('TX1');
    expect(o?.paidAt).toBeTruthy();
    expect(o?.prevPlan).toBe('free'); // 兑现前的档位，对账要
    expect(o?.grantedDays).toBeGreaterThan(0);
    expect(o?.newPlanExpiresAt).toEqual(t?.planExpiresAt);
  });

  it('🔒 重复回调（微信最多重发 15 次）→ 只发一次货', async () => {
    const { tenantId, outTradeNo, amountFen } = await seedOrder();
    const first = await fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen, source: 'notify' });
    const end1 = (await prisma.tenant.findUnique({ where: { id: tenantId } }))!.planExpiresAt;

    // 微信重发 14 次
    for (let i = 0; i < 14; i++) {
      const r = await fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen, source: 'notify' });
      expect(r.ok).toBe(true);
      expect(r.ok && r.alreadyDone).toBe(true); // 每一次都必须是「已处理过」
    }

    const end2 = (await prisma.tenant.findUnique({ where: { id: tenantId } }))!.planExpiresAt;
    expect(end2).toEqual(end1); // ★ 到期时间没有被叠加 15 次
    expect(first.ok && !first.alreadyDone).toBe(true);
    expect(await prisma.paymentOrder.count({ where: { status: 'paid' } })).toBe(1);
  });

  it('🔒 **并发**回调（微信可能并发到达）→ 恰好一次发货', async () => {
    const { tenantId, outTradeNo, amountFen } = await seedOrder();
    // 8 路并发打同一单
    const results = await Promise.all(
      Array.from({ length: 8 }, () => fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen, source: 'notify' })),
    );
    const fresh = results.filter((r) => r.ok && !r.alreadyDone);
    expect(fresh.length).toBe(1); // ★ 恰好一个赢家，靠的是 DB 条件写而不是「先查后写」

    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const o = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    expect(o?.status).toBe('paid');
    // 只加了一个月：约 28-31 天，绝不是 8 个月
    const days = Math.round((t!.planExpiresAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('🔒 回调与查单兜底**并发**兑现同一单 → 也只发一次货（两条入口共用一个幂等点）', async () => {
    const { tenantId, outTradeNo, amountFen } = await seedOrder();
    const results = await Promise.all([
      fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen, source: 'notify' }),
      fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen, source: 'query' }),
      fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen, source: 'notify' }),
    ]);
    expect(results.filter((r) => r.ok && !r.alreadyDone).length).toBe(1);
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(Math.round((t!.planExpiresAt!.getTime() - Date.now()) / 86_400_000)).toBeLessThan(32);
  });

  it('🔒 金额被篡改（实收 1 分）→ 拒绝发货并置 failed', async () => {
    const { tenantId, outTradeNo } = await seedOrder('personal');
    const r = await fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: 1, source: 'notify' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/金额不匹配/);

    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('free'); // ★ 没升档
    expect(t?.planExpiresAt).toBeNull();
    const o = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    expect(o?.status).toBe('failed');
    expect(o?.failReason).toMatch(/金额不匹配/);
  });

  it('🔒 实收比应付多也拒绝（不只是防少付，是防对账对不上）', async () => {
    const { tenantId, outTradeNo, amountFen } = await seedOrder('personal');
    const r = await fulfillOrder({ outTradeNo, transactionId: 'TX1', amountTotalFen: amountFen + 1, source: 'notify' });
    expect(r.ok).toBe(false);
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free');
  });

  it('订单不存在 → 拒绝，不抛', async () => {
    const r = await fulfillOrder({ outTradeNo: 'bcn_NOTEXIST', transactionId: 'TX1', source: 'notify' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/订单不存在/);
  });

  it('🔒 同一 transactionId 兑现两个不同订单 → 被唯一索引挡住（第二道锁）', async () => {
    const a = await seedOrder('personal');
    const b = await seedOrder('personal');
    const r1 = await fulfillOrder({ outTradeNo: a.outTradeNo, transactionId: 'SAME_TX', amountTotalFen: a.amountFen, source: 'notify' });
    expect(r1.ok && !r1.alreadyDone).toBe(true);
    // 同一笔微信支付不可能同时属于两个订单；真发生了就是我们的匹配逻辑出了问题，必须拦
    const r2 = await fulfillOrder({ outTradeNo: b.outTradeNo, transactionId: 'SAME_TX', amountTotalFen: b.amountFen, source: 'notify' });
    expect(r2.ok && r2.alreadyDone).toBe(true); // 判定为重复兑现，不发货
    expect(await prisma.paymentOrder.count({ where: { status: 'paid' } })).toBe(1);
  });

  it('续费叠加：已有标准版剩 10 天 → 再买 1 个月 = 从原到期日往后加', async () => {
    const end = new Date(Date.now() + 10 * 86_400_000);
    const { tenantId, memberId } = await mkTenant('personal', end);
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, mock());
    await fulfillOrder({ outTradeNo: r.outTradeNo, transactionId: 'TX1', amountTotalFen: r.amountFen, source: 'notify' });
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const days = Math.round((t!.planExpiresAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThan(37); // 10 + 约 30
  });

  it('过期后续费：不叠加已过期的时长（从付款日起算）', async () => {
    const { tenantId, memberId } = await mkTenant('personal', new Date(Date.now() - 100 * 86_400_000));
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, mock());
    await fulfillOrder({ outTradeNo: r.outTradeNo, transactionId: 'TX1', amountTotalFen: r.amountFen, source: 'notify' });
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const days = Math.round((t!.planExpiresAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });
});

describe('pay/order · 查单兜底（回调丢了也要能发货）', () => {
  it('查到 SUCCESS → 兑现', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    p.markPaid(r.outTradeNo); // 模拟：用户付了，但回调丢了

    const f = await syncOrderFromWechat(r.outTradeNo, p);
    expect(f?.ok).toBe(true);
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('personal');
  });

  it('查到 NOTPAY → 不动', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    expect(await syncOrderFromWechat(r.outTradeNo, p)).toBeNull();
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free');
    expect((await prisma.paymentOrder.findUnique({ where: { outTradeNo: r.outTradeNo } }))?.status).toBe('created');
  });

  it('查到 CLOSED → 关单', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    const closed: PayProvider = {
      name: 'x',
      mocked: true,
      async refund() { throw new Error('本 stub 不测退款'); },
      async queryRefund() { return { status: 'PROCESSING' as const }; },
      createNative: p.createNative.bind(p),
      async queryByOutTradeNo(): Promise<QueryResult> {
        return { tradeState: 'CLOSED' };
      },
    };
    await syncOrderFromWechat(r.outTradeNo, closed);
    const o = await prisma.paymentOrder.findUnique({ where: { outTradeNo: r.outTradeNo } });
    expect(o?.status).toBe('closed');
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free');
  });

  it('查单接口报错 → 吞掉不影响用户（回调可能仍会到）', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    const broken: PayProvider = {
      name: 'x',
      mocked: true,
      async refund() { throw new Error('本 stub 不测退款'); },
      async queryRefund() { return { status: 'PROCESSING' as const }; },
      createNative: p.createNative.bind(p),
      async queryByOutTradeNo(): Promise<QueryResult> {
        throw new WxPayError('SYSTEM_ERROR', '系统异常', 500);
      },
    };
    await expect(syncOrderFromWechat(r.outTradeNo, broken)).resolves.toBeNull();
    expect((await prisma.paymentOrder.findUnique({ where: { outTradeNo: r.outTradeNo } }))?.status).toBe('created');
  });

  it('已兑现的单不再查（省一次微信调用）', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    p.markPaid(r.outTradeNo);
    await syncOrderFromWechat(r.outTradeNo, p);

    let queried = 0;
    const counting: PayProvider = {
      name: 'x',
      mocked: true,
      async refund() { throw new Error('本 stub 不测退款'); },
      async queryRefund() { return { status: 'PROCESSING' as const }; },
      createNative: p.createNative.bind(p),
      async queryByOutTradeNo(): Promise<QueryResult> {
        queried++;
        return { tradeState: 'SUCCESS' };
      },
    };
    expect(await syncOrderFromWechat(r.outTradeNo, counting)).toBeNull();
    expect(queried).toBe(0);
  });
});

describe('pay/order · Mock 通道全流程（dev 零凭证跑通）', () => {
  it('下单 → 出二维码 → 模拟支付 → 查单兜底兑现 → 套餐生效', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();

    // 1. 下单
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 12 }, p);
    expect(r.mocked).toBe(true);
    expect(r.codeUrl).toMatch(/^weixin:\/\/wxpay\/bizpayurl\?pr=MOCK/);
    expect(r.amountFen).toBe(129_000);

    // 2. 还没付
    expect((await p.queryByOutTradeNo(r.outTradeNo)).tradeState).toBe('NOTPAY');
    expect(await syncOrderFromWechat(r.outTradeNo, p)).toBeNull();
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free');

    // 3. 模拟支付成功
    expect(p.markPaid(r.outTradeNo)).toBe(true);
    expect((await p.queryByOutTradeNo(r.outTradeNo)).tradeState).toBe('SUCCESS');

    // 4. 前端轮询触发查单兜底 → 走**生产同款**兑现路径
    const f = await syncOrderFromWechat(r.outTradeNo, p);
    expect(f?.ok).toBe(true);

    // 5. 套餐生效
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('personal');
    expect(effectivePlan(t!.plan, t!.planExpiresAt)).toBe('personal');
    const days = Math.round((t!.planExpiresAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThan(360);

    // 6. 再轮询几次也不会重复发货
    for (let i = 0; i < 3; i++) await syncOrderFromWechat(r.outTradeNo, p);
    const t2 = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t2?.planExpiresAt).toEqual(t?.planExpiresAt);
  });

  it('markPaid 对不存在/已付的单返回 false', async () => {
    const p = mock();
    expect(p.markPaid('bcn_NOPE')).toBe(false);
    const { tenantId, memberId } = await mkTenant();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    expect(p.markPaid(r.outTradeNo)).toBe(true);
    expect(p.markPaid(r.outTradeNo)).toBe(false);
  });
});

describe('pay/order · toRfc3339', () => {
  it('输出带时区偏移，不是 Z 结尾的 UTC 串（微信只吃前者）', () => {
    const s = toRfc3339(new Date('2026-07-17T13:29:35+08:00'));
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(s).not.toMatch(/Z$/);
  });
});
