import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { reconcilePendingRefunds } from '@/lib/pay/order';
import { before } from '../helpers/anchor';

// 退款对账（2026-08-29 全库「写了没接」扫描查出）。
//
// ── 查出来的缺陷 ──
// `syncRefundFromWechat` 的注释写着「退款回调丢了也要能兑现 · 前端/内部轮询触发」，
// 而它**一个调用点都没有**。支付那侧是对称的：`syncOrderFromWechat` 由 actPollOrder
// 在用户盯着二维码时轮询；退款没有对应的东西——用户点完退款就走了，没人守着页面。
//
// 于是 `actRefund` 里那句注释「没配则靠即时返回 + **查单兜底**」在退款这条路上是**假的**：
// 回调一丢（支付那侧的注释就列了两种：反代过滤 Wechatpay-* 头、公网抖动），
// 退款单永远停在 processing —— **钱退了，而我们这边的套餐没收回**。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('退款对账：回调丢了也要落定', () => {
  beforeEach(async () => {
    await prisma.wxPayRefund.deleteMany({});
  });

  it('🔒 真跑：processing 的退款单会被查单并落定', async () => {
    const t = await prisma.tenant.create({ data: { name: 't' } });
    const order = await prisma.paymentOrder.create({
      data: {
        tenantId: t.id, memberId: 'm1', outTradeNo: 'bcn_recon_1', plan: 'personal', periodMonths: 1,
        amountFen: 12900, status: 'paid',
      },
    });
    await prisma.wxPayRefund.create({
      data: {
        outRefundNo: 'rfd_recon_1', orderId: order.id, outTradeNo: order.outTradeNo,
        tenantId: t.id, operator: 'm1',
        amountRefundFen: 12900, amountTotalFen: 12900, status: 'processing',
      },
    });

    // 假的 provider：查单说已成功
    const provider = {
      queryRefund: vi.fn(async () => ({
        refundId: 'wx-refund-1', status: 'SUCCESS' as const, successTimeISO: new Date().toISOString(),
      })),
    } as never;

    const r = await reconcilePendingRefunds(provider);
    expect(r.scanned).toBe(1);
    const after = await prisma.wxPayRefund.findUnique({ where: { outRefundNo: 'rfd_recon_1' } });
    expect(after!.status).toBe('success');
    // 订单也要跟着转 refunded——否则用户退了钱，账面上还是「已支付」
    expect((await prisma.paymentOrder.findUnique({ where: { id: order.id } }))!.status).toBe('refunded');
  });

  it('🔒 已终态的不再查单（success/closed/failed 不是可复核态）', async () => {
    const t = await prisma.tenant.create({ data: { name: 't' } });
    const order = await prisma.paymentOrder.create({
      data: {
        tenantId: t.id, memberId: 'm1', outTradeNo: 'bcn_recon_2', plan: 'personal', periodMonths: 1,
        amountFen: 12900, status: 'refunded',
      },
    });
    await prisma.wxPayRefund.create({
      data: {
        outRefundNo: 'rfd_recon_2', orderId: order.id, outTradeNo: order.outTradeNo,
        tenantId: t.id, operator: 'm1',
        amountRefundFen: 12900, amountTotalFen: 12900, status: 'success',
      },
    });
    const provider = { queryRefund: vi.fn() } as never;
    const r = await reconcilePendingRefunds(provider);
    expect(r.scanned).toBe(0);
    expect((provider as unknown as { queryRefund: { mock: { calls: unknown[] } } }).queryRefund.mock.calls.length).toBe(0);
  });

  it('单条查单失败不连累其余（由 syncRefundFromWechat 内部 catch 保证）', async () => {
    // 【这条证明的是什么，说准确】变异验证发现：把外层的 `.catch(() => null)` 删掉，
    // 这条**照样绿**——因为 syncRefundFromWechat 里已经把 queryRefund 的异常 catch 掉了。
    // 所以它证明的是「查单网络失败不中断整轮」，而不是「外层 catch 有效」。
    // 外层那个 catch 守的是另一条路（applyRefundResult 会把非 P2002 的错**重新抛出**），
    // 那条路在单测里构造不出来，只能用源码断言钉住（见下一条）。
    const t = await prisma.tenant.create({ data: { name: 't' } });
    for (const n of [1, 2]) {
      const o = await prisma.paymentOrder.create({
        data: {
          tenantId: t.id, memberId: 'm1', outTradeNo: `bcn_recon_f${n}`, plan: 'personal', periodMonths: 1,
          amountFen: 12900, status: 'paid',
        },
      });
      await prisma.wxPayRefund.create({
        data: {
          outRefundNo: `rfd_recon_f${n}`, orderId: o.id, outTradeNo: o.outTradeNo,
          tenantId: t.id, operator: 'm1',
          amountRefundFen: 12900, amountTotalFen: 12900, status: 'processing',
        },
      });
    }
    let call = 0;
    const provider = {
      queryRefund: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('网络炸了');
        return { refundId: 'wx-2', status: 'SUCCESS' as const, successTimeISO: new Date().toISOString() };
      }),
    } as never;
    const r = await reconcilePendingRefunds(provider);
    expect(r.scanned).toBe(2);
    expect(r.settled).toBe(1); // 第二条照样落定
  });
});

describe('对账真的被挂上了（不是又一个孤儿）', () => {
  it('🔒 逐单包 catch —— 守的是 applyRefundResult 抛非 P2002 错那条路', () => {
    // applyRefundResult 的 catch 里写着 `if (P2002) …; throw e;`——它会重新抛。
    // 没有逐单 catch 的话，一条落库异常会让**这一轮剩下的退款单全部不对账**，
    // 而下一轮同样从它开始、同样炸——永久卡死，且只表现为「退款一直没落定」。
    const src = read('lib/pay/order.ts');
    expect(src).toContain('await syncRefundFromWechat(r.outRefundNo, provider).catch(() => null)');
  });

  it('🔒 有调用点，且只在有计费的形态跑', () => {
    const h = read('lib/jobs/handlers.ts');
    expect(h).toContain('reconcilePendingRefunds()');
    // 企业版没有计费面，跑它只会白报错
    expect(before(h, 'reconcilePendingRefunds()', 200)).toContain("editionCan('payment')");
  });

  it('🔒 对账失败不连累续费提醒（那是这个 job 的主业）', () => {
    const h = read('lib/jobs/handlers.ts');
    expect(h).toContain('reconcilePendingRefunds().catch(');
  });

  it('结果要印出来（不印的话没人知道它跑没跑）', () => {
    expect(read('lib/jobs/handlers.ts')).toContain('退款对账 ${refunds.scanned} 单');
  });
});
