import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { createOrder, fulfillOrder, createRefund, applyRefundResult, syncRefundFromWechat } from '@/lib/pay/order';
import { MockPayProvider } from '@/lib/pay/mock';
import { newOutRefundNo, outRefundNoForOrder } from '@/lib/pay/sign';
import { WxPayError, type PayProvider, type RefundParams, type RefundResult, type CreateNativeResult, type QueryResult } from '@/lib/pay/types';

// 退款 v1：全额退款 + 安全回收套餐 + 幂等。走真 SQLite（要验的正是套餐回收状态机与条件写幂等）。

async function mkTenant(plan = 'free', planExpiresAt: Date | null = null) {
  const t = await prisma.tenant.create({ data: { name: '测试租户', plan, planExpiresAt } });
  const m = await prisma.member.create({ data: { tenantId: t.id, name: '所有者', role: 'owner' } });
  return { tenantId: t.id, memberId: m.id };
}

function mock() {
  return new MockPayProvider();
}

// 造一笔已支付订单：下单 → 兑现
async function seedPaidOrder(plan: 'personal' | 'byok' = 'personal', months: 1 | 12 = 1) {
  const { tenantId, memberId } = await mkTenant();
  const p = mock();
  const r = await createOrder({ tenantId, memberId, plan, periodMonths: months }, p);
  await fulfillOrder({ outTradeNo: r.outTradeNo, transactionId: `TX${r.outTradeNo}`, amountTotalFen: r.amountFen, source: 'notify' });
  return { tenantId, outTradeNo: r.outTradeNo, amountFen: r.amountFen };
}

beforeEach(async () => {
  await prisma.wxPayRefund.deleteMany();
  await prisma.wxPayNotifyLog.deleteMany();
  await prisma.paymentOrder.deleteMany();
  await prisma.llmCallLog.deleteMany();
  await prisma.member.deleteMany();
  await prisma.tenant.deleteMany();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe('pay/refund · 单号生成', () => {
  it('bcr_ 前缀、合法字符集、唯一', () => {
    const s = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const no = newOutRefundNo();
      expect(no).toMatch(/^bcr_[0-9A-Za-z_|*-]{6,28}$/);
      s.add(no);
    }
    expect(s.size).toBe(50);
  });
});

describe('pay/refund · 按天折算 / 买断防刷', () => {
  it('未消耗任何 AI → 全额退（kind=full）', async () => {
    const { outTradeNo, amountFen } = await seedPaidOrder('personal', 1);
    const r = await createRefund({ outTradeNo, operator: 'ops' }, mock());
    expect(r.ok && r.kind).toBe('full');
    expect(r.ok && r.amountRefundFen).toBe(amountFen);
  });

  it('已消耗 + 回拨已过 10 天（剩 20/30）→ 部分退款 8600（12900×20/30）', async () => {
    const { tenantId, outTradeNo, amountFen } = await seedPaidOrder('personal', 1);
    const paidAt = new Date(Date.now() - 10 * 86_400_000);
    const expires = new Date(Date.now() + 20 * 86_400_000);
    // 回拨订单 + 让租户到期与订单一致（保持「安全可回收」，退款仍会整单回收套餐）
    await prisma.paymentOrder.update({ where: { outTradeNo }, data: { paidAt, grantedDays: 30, newPlanExpiresAt: expires } });
    await prisma.tenant.update({ where: { id: tenantId }, data: { planExpiresAt: expires } });
    await prisma.llmCallLog.create({ data: { tenantId, fn: 'generation', provider: 'x', model: 'm', mocked: false } });

    const r = await createRefund({ outTradeNo, operator: 'ops' }, mock());
    expect(r.ok).toBe(true);
    expect(r.ok && r.kind).toBe('prorated');
    expect(r.ok && r.amountRefundFen).toBe(8_600);
    const rf = await prisma.wxPayRefund.findFirst({ where: { outTradeNo } });
    expect(rf?.amountRefundFen).toBe(8_600);
    expect(rf?.amountTotalFen).toBe(amountFen); // total 恒为原单额
    // 套餐照常回收到 free（用户取消订阅、退未用天数的钱）
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free');
  });

  it('🔒 只算本单窗口内的消耗：paidAt 之前的调用不算「已使用」→ 仍全额退', async () => {
    const { tenantId, outTradeNo, amountFen } = await seedPaidOrder('personal', 1);
    // 一条 paidAt 之前的调用（上一个套餐周期）
    const before = new Date(Date.now() - 3600_000);
    await prisma.paymentOrder.update({ where: { outTradeNo }, data: { paidAt: new Date() } });
    await prisma.llmCallLog.create({ data: { tenantId, fn: 'chat', provider: 'x', model: 'm', mocked: false, createdAt: before } });
    const r = await createRefund({ outTradeNo, operator: 'ops' }, mock());
    expect(r.ok && r.kind).toBe('full');
    expect(r.ok && r.amountRefundFen).toBe(amountFen);
  });

  it('🔒 永久买断已消耗 → 拒绝自助退款（manual），不创建退款单', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const o = await createOrder({ tenantId, memberId, plan: 'byok', periodMonths: 1188 }, p);
    await fulfillOrder({ outTradeNo: o.outTradeNo, transactionId: `TX${o.outTradeNo}`, amountTotalFen: o.amountFen, source: 'notify' });
    await prisma.llmCallLog.create({ data: { tenantId, fn: 'generation', provider: 'x', model: 'm', mocked: false } });

    const r = await createRefund({ outTradeNo: o.outTradeNo, operator: 'ops' }, p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/买断|客服/);
    expect(await prisma.wxPayRefund.count({ where: { outTradeNo: o.outTradeNo } })).toBe(0);
  });

  it('买断未消耗 → 仍可全额退', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const o = await createOrder({ tenantId, memberId, plan: 'byok', periodMonths: 1188 }, p);
    await fulfillOrder({ outTradeNo: o.outTradeNo, transactionId: `TX${o.outTradeNo}`, amountTotalFen: o.amountFen, source: 'notify' });
    const r = await createRefund({ outTradeNo: o.outTradeNo, operator: 'ops' }, p);
    expect(r.ok && r.kind).toBe('full');
    expect(r.ok && r.amountRefundFen).toBe(299_900);
  });
});

describe('pay/refund · createRefund 发起', () => {
  it('首购标准版 → 退款成功 → 订单 refunded + 套餐回收到 free', async () => {
    const { tenantId, outTradeNo } = await seedPaidOrder('personal');
    // 兑现后是 personal
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('personal');

    const r = await createRefund({ outTradeNo, operator: 'ops', reason: '测试退款' }, mock());
    expect(r.ok).toBe(true);
    expect(r.ok && r.status).toBe('SUCCESS');
    expect(r.ok && r.planRecovered).toBe(true);

    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('free'); // ★ 回收到首购前的 free
    expect(t?.planExpiresAt).toBeNull();
    const o = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    expect(o?.status).toBe('refunded');
    const rf = await prisma.wxPayRefund.findFirst({ where: { outTradeNo } });
    expect(rf?.status).toBe('success');
    expect(rf?.planRecovered).toBe(true);
    expect(rf?.recoveredPlan).toBe('free');
    expect(rf?.amountRefundFen).toBe(12_900);
  });

  it('🔒 只有 paid 订单可退款（created/failed 拒绝）', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const r = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p); // 只下单未支付
    const res = await createRefund({ outTradeNo: r.outTradeNo, operator: 'ops' }, p);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/只有已支付/);
  });

  it('🔒 同一订单不重复退款：已退成功 → 订单变 refunded，再退被状态闸挡下', async () => {
    const { outTradeNo } = await seedPaidOrder('personal');
    const r1 = await createRefund({ outTradeNo, operator: 'ops' }, mock()); // Mock 即时成功 → 订单 refunded
    expect(r1.ok).toBe(true);
    const r2 = await createRefund({ outTradeNo, operator: 'ops' }, mock());
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.reason).toMatch(/refunded|只有已支付/);
    // 只退了一次钱
    expect(await prisma.wxPayRefund.count({ where: { outTradeNo } })).toBe(1);
  });

  it('🔒 退款进行中(processing，订单仍 paid) → 不重复发起（已存在退款单闸）', async () => {
    const { outTradeNo } = await seedPaidOrder('personal');
    const proc: PayProvider = {
      name: 'proc', mocked: true,
      async createNative(): Promise<CreateNativeResult> { return { codeUrl: 'x' }; },
      async queryByOutTradeNo(): Promise<QueryResult> { return { tradeState: 'SUCCESS' }; },
      async refund(p: RefundParams): Promise<RefundResult> { return { outRefundNo: p.outRefundNo, status: 'PROCESSING' }; },
      async queryRefund(): Promise<RefundResult> { return { status: 'PROCESSING' }; },
    };
    const r1 = await createRefund({ outTradeNo, operator: 'ops' }, proc); // PROCESSING，订单仍 paid
    expect(r1.ok).toBe(true);
    const r2 = await createRefund({ outTradeNo, operator: 'ops' }, proc);
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.reason).toMatch(/已存在退款单/);
    expect(await prisma.wxPayRefund.count({ where: { outTradeNo } })).toBe(1);
  });

  it('订单不存在 → 拒绝', async () => {
    const r = await createRefund({ outTradeNo: 'bcn_NOTEXIST', operator: 'ops' }, mock());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/订单不存在/);
  });

  it('🔒 微信明确拒绝(非重试类 WxPayError，钱没动) → 退款单置 failed', async () => {
    const { outTradeNo } = await seedPaidOrder('personal');
    const boom: PayProvider = {
      name: 'boom', mocked: true,
      async createNative(): Promise<CreateNativeResult> { return { codeUrl: 'x' }; },
      async queryByOutTradeNo(): Promise<QueryResult> { return { tradeState: 'SUCCESS' }; },
      async refund(): Promise<RefundResult> { throw new WxPayError('NOT_ENOUGH', '余额不足', 403); }, // 4xx 非重试 = 明确拒绝
      async queryRefund(): Promise<RefundResult> { return { status: 'PROCESSING' }; },
    };
    const r = await createRefund({ outTradeNo, operator: 'ops' }, boom);
    expect(r.ok).toBe(false);
    const rf = await prisma.wxPayRefund.findFirst({ where: { outTradeNo } });
    expect(rf?.status).toBe('failed'); // 钱没动，真终态
    expect((await prisma.paymentOrder.findFirst({ where: { outTradeNo } }))?.status).toBe('paid');
  });

  it('🔒 bug#1：发起退款网络超时(钱可能已退) → 落 unknown(非 failed 死信) → 后续 SUCCESS 回调仍能回收套餐', async () => {
    const { tenantId, outTradeNo } = await seedPaidOrder('personal');
    const timeout: PayProvider = {
      name: 'timeout', mocked: true,
      async createNative(): Promise<CreateNativeResult> { return { codeUrl: 'x' }; },
      async queryByOutTradeNo(): Promise<QueryResult> { return { tradeState: 'SUCCESS' }; },
      async refund(): Promise<RefundResult> { throw new Error('ETIMEDOUT'); }, // 网络异常，非 WxPayError
      async queryRefund(): Promise<RefundResult> { return { status: 'PROCESSING' }; },
    };
    const r = await createRefund({ outTradeNo, operator: 'ops' }, timeout);
    expect(r.ok).toBe(false);
    const rf = await prisma.wxPayRefund.findFirst({ where: { outTradeNo } });
    expect(rf?.status).toBe('unknown'); // ★ 不是 failed 死信
    // 微信其实退成功了，异步回调/查单到达 → 必须能兑现回收，不被死信拒绝
    const outRefundNo = rf!.outRefundNo;
    const applied = await applyRefundResult({ outRefundNo, refundId: 'RID_TO', status: 'SUCCESS', source: 'notify' });
    expect(applied.ok && !applied.alreadyDone).toBe(true);
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free'); // ★ 套餐回收成功
    expect((await prisma.paymentOrder.findFirst({ where: { outTradeNo } }))?.status).toBe('refunded');
  });

  it('🔒 bug#2：确定性单号 + 唯一索引 → 同订单不可能有第二张退款单（P2002 兜底）', async () => {
    const { outTradeNo } = await seedPaidOrder('personal');
    const order = await prisma.paymentOrder.findFirst({ where: { outTradeNo } });
    // 手工塞一张确定性单号的退款单（模拟并发第一个已落库）
    await prisma.wxPayRefund.create({
      data: {
        outRefundNo: outRefundNoForOrder(order!.id),
        orderId: order!.id, outTradeNo, tenantId: order!.tenantId,
        amountRefundFen: 12_900, amountTotalFen: 12_900, operator: 'ops', status: 'unknown',
      },
    });
    // 第二个 createRefund：findFirst 或 create P2002 都应拦下，绝不生成第二张
    const r = await createRefund({ outTradeNo, operator: 'ops' }, mock());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/已存在退款单/);
    expect(await prisma.wxPayRefund.count({ where: { orderId: order!.id } })).toBe(1);
  });
});

describe('pay/refund · 套餐回收安全性（不误伤后续购买）', () => {
  it('🔒 退款前其上又买了一单（planExpiresAt 变了）→ 拒绝自助退款，转人工', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    // 第一单：personal 1 月，兑现
    const a = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    await fulfillOrder({ outTradeNo: a.outTradeNo, transactionId: 'TXA', amountTotalFen: a.amountFen, source: 'notify' });
    // 第二单：又续了一年（叠加），兑现 → 租户 planExpiresAt 变成更晚，不再等于第一单的结果
    const b = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 12 }, p);
    await fulfillOrder({ outTradeNo: b.outTradeNo, transactionId: 'TXB', amountTotalFen: b.amountFen, source: 'notify' });

    // 退第一单 → 应被拒（其上叠加过 B）
    const r = await createRefund({ outTradeNo: a.outTradeNo, operator: 'ops' }, p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/后续购买|人工/);
    // 租户套餐没被动
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('personal');
    expect(await prisma.wxPayRefund.count()).toBe(0); // 一条退款单都没生成
  });

  it('退最近一单（其上无叠加）→ 允许，回收到上一单的到期时间', async () => {
    const { tenantId, memberId } = await mkTenant();
    const p = mock();
    const a = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    await fulfillOrder({ outTradeNo: a.outTradeNo, transactionId: 'TXA', amountTotalFen: a.amountFen, source: 'notify' });
    const tAfterA = await prisma.tenant.findUnique({ where: { id: tenantId } });
    // 再买一单（renew 叠加），此时 B 是最近一单
    const b = await createOrder({ tenantId, memberId, plan: 'personal', periodMonths: 1 }, p);
    await fulfillOrder({ outTradeNo: b.outTradeNo, transactionId: 'TXB', amountTotalFen: b.amountFen, source: 'notify' });

    // 退最近的 B → 允许，回收到 A 兑现后的到期时间（B 的 prevPlanExpiresAt）
    const r = await createRefund({ outTradeNo: b.outTradeNo, operator: 'ops' }, p);
    expect(r.ok).toBe(true);
    expect(r.ok && r.planRecovered).toBe(true);
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('personal'); // 仍是 personal（A 还在）
    expect(t?.planExpiresAt?.getTime()).toBe(tAfterA?.planExpiresAt?.getTime()); // 回到 A 之后的到期
  });
});

describe('pay/refund · applyRefundResult 幂等', () => {
  it('🔒 退款回调重复/并发 → 只回收一次套餐', async () => {
    const { tenantId, outTradeNo } = await seedPaidOrder('personal');
    // 先发起（PROCESSING，不即时兑现）—— 用一个返回 PROCESSING 的 provider
    const proc: PayProvider = {
      name: 'proc', mocked: true,
      async createNative(): Promise<CreateNativeResult> { return { codeUrl: 'x' }; },
      async queryByOutTradeNo(): Promise<QueryResult> { return { tradeState: 'SUCCESS' }; },
      async refund(p: RefundParams): Promise<RefundResult> { return { outRefundNo: p.outRefundNo, refundId: 'RID1', status: 'PROCESSING' }; },
      async queryRefund(): Promise<RefundResult> { return { status: 'PROCESSING' }; },
    };
    const c = await createRefund({ outTradeNo, operator: 'ops' }, proc);
    expect(c.ok && c.status).toBe('PROCESSING');
    const outRefundNo = (await prisma.wxPayRefund.findFirst({ where: { outTradeNo } }))!.outRefundNo;

    // 8 路并发回调兑现同一退款
    const results = await Promise.all(
      Array.from({ length: 8 }, () => applyRefundResult({ outRefundNo, refundId: 'RID1', status: 'SUCCESS', source: 'notify' })),
    );
    const fresh = results.filter((r) => r.ok && !r.alreadyDone);
    expect(fresh.length).toBe(1); // ★ 恰好一次兑现
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('free'); // 回收一次
    expect(await prisma.wxPayRefund.count({ where: { status: 'success' } })).toBe(1);
  });

  it('查单兜底 syncRefundFromWechat：回调丢了也能兑现', async () => {
    const { tenantId, outTradeNo } = await seedPaidOrder('personal');
    const proc: PayProvider = {
      name: 'proc', mocked: true,
      async createNative(): Promise<CreateNativeResult> { return { codeUrl: 'x' }; },
      async queryByOutTradeNo(): Promise<QueryResult> { return { tradeState: 'SUCCESS' }; },
      async refund(p: RefundParams): Promise<RefundResult> { return { outRefundNo: p.outRefundNo, status: 'PROCESSING' }; },
      async queryRefund(outRefundNo: string): Promise<RefundResult> { return { outRefundNo, refundId: 'RID2', status: 'SUCCESS', successTimeISO: new Date().toISOString() }; },
    };
    await createRefund({ outTradeNo, operator: 'ops' }, proc);
    const outRefundNo = (await prisma.wxPayRefund.findFirst({ where: { outTradeNo } }))!.outRefundNo;
    // 回调没来，主动查单
    const s = await syncRefundFromWechat(outRefundNo, proc);
    expect(s?.ok).toBe(true);
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free');
  });

  it('非 SUCCESS 状态（ABNORMAL）→ 不回收套餐，退款单标 abnormal', async () => {
    const { tenantId, outTradeNo } = await seedPaidOrder('personal');
    const proc: PayProvider = {
      name: 'proc', mocked: true,
      async createNative(): Promise<CreateNativeResult> { return { codeUrl: 'x' }; },
      async queryByOutTradeNo(): Promise<QueryResult> { return { tradeState: 'SUCCESS' }; },
      async refund(p: RefundParams): Promise<RefundResult> { return { outRefundNo: p.outRefundNo, status: 'PROCESSING' }; },
      async queryRefund(): Promise<RefundResult> { return { status: 'PROCESSING' }; },
    };
    await createRefund({ outTradeNo, operator: 'ops' }, proc);
    const outRefundNo = (await prisma.wxPayRefund.findFirst({ where: { outTradeNo } }))!.outRefundNo;
    await applyRefundResult({ outRefundNo, status: 'ABNORMAL', source: 'notify' });
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('personal'); // ★ 套餐没动（钱未确认出账）
    const rf = await prisma.wxPayRefund.findUnique({ where: { outRefundNo } });
    expect(rf?.status).toBe('abnormal');
  });

  it('🔒 bug#3：先 ABNORMAL 后 SUCCESS（微信文档化时序）→ SUCCESS 必须能翻转 abnormal 并回收套餐', async () => {
    const { tenantId, outTradeNo } = await seedPaidOrder('personal');
    const proc: PayProvider = {
      name: 'proc', mocked: true,
      async createNative(): Promise<CreateNativeResult> { return { codeUrl: 'x' }; },
      async queryByOutTradeNo(): Promise<QueryResult> { return { tradeState: 'SUCCESS' }; },
      async refund(p: RefundParams): Promise<RefundResult> { return { outRefundNo: p.outRefundNo, status: 'PROCESSING' }; },
      async queryRefund(): Promise<RefundResult> { return { status: 'PROCESSING' }; },
    };
    await createRefund({ outTradeNo, operator: 'ops' }, proc);
    const outRefundNo = (await prisma.wxPayRefund.findFirst({ where: { outTradeNo } }))!.outRefundNo;
    // 第一条回调：ABNORMAL → abnormal（此刻不回收）
    await applyRefundResult({ outRefundNo, status: 'ABNORMAL', source: 'notify' });
    expect((await prisma.wxPayRefund.findUnique({ where: { outRefundNo } }))?.status).toBe('abnormal');
    // 第二条回调：SUCCESS → 必须翻转并回收（旧实现会因 abnormal 不在条件写集合被静默丢弃）
    const r2 = await applyRefundResult({ outRefundNo, refundId: 'RID_AB', status: 'SUCCESS', source: 'notify' });
    expect(r2.ok && !r2.alreadyDone).toBe(true);
    expect((await prisma.tenant.findUnique({ where: { id: tenantId } }))?.plan).toBe('free'); // ★ 回收成功
    expect((await prisma.wxPayRefund.findUnique({ where: { outRefundNo } }))?.status).toBe('success');
  });
});
