import crypto from 'node:crypto';
import { isProd } from '../env';
import type { CreateNativeParams, CreateNativeResult, PayProvider, QueryResult, RefundParams, RefundResult } from './types';

// 开发态 Mock 支付通道：没有任何微信凭证也能把「下单 → 出二维码 → 支付成功 → 兑现套餐」跑通。
//
// 🔒 安全不变式：**生产态永远不会构造出这个类**（见 provider.ts 的工厂）。
// Mock 通道 = 点一下按钮就把 plan 升到 team = 免费升档。这与「Mock 短信通道 = 任意账号接管」
// 是同一个结构的洞。所以工厂在生产态未配 vendor 时是 **throw 而不是回退 Mock**。
// 这里再加一道纵深防御：构造函数在生产态直接炸，别指望上游永远不写错。

type MockOrder = { amountFen: number; paid: boolean; transactionId?: string; successTimeISO?: string };

// 模块级状态在 dev 热重载时会丢，挂到 globalThis 上（同 lib/db.ts 对 PrismaClient 的处理）
const g = globalThis as unknown as { __beaconMockPayOrders?: Map<string, MockOrder> };
const orders: Map<string, MockOrder> = (g.__beaconMockPayOrders ??= new Map());

export class MockPayProvider implements PayProvider {
  readonly name = 'mock-pay';
  readonly mocked = true;

  constructor() {
    if (isProd()) {
      throw new Error('[beacon/pay] Mock 支付通道在生产环境被构造 —— 这等于免费升档，拒绝启动。');
    }
  }

  async createNative(p: CreateNativeParams): Promise<CreateNativeResult> {
    orders.set(p.outTradeNo, { amountFen: p.amountFen, paid: false });
    // 形状与真实 code_url 一致（能被二维码编码器正常处理），但扫了不会真跳微信 —— UI 会标明「模拟通道」
    const pr = crypto.randomBytes(4).toString('hex').toUpperCase();
    return { codeUrl: `weixin://wxpay/bizpayurl?pr=MOCK${pr}`, requestId: `mock-${pr}` };
  }

  async queryByOutTradeNo(outTradeNo: string): Promise<QueryResult> {
    const o = orders.get(outTradeNo);
    if (!o) return { tradeState: 'NOTPAY', tradeStateDesc: '订单不存在于 Mock 通道（可能是进程重启后内存态丢失）' };
    if (!o.paid) return { tradeState: 'NOTPAY', tradeStateDesc: '模拟通道：尚未点击「模拟支付成功」' };
    return {
      tradeState: 'SUCCESS',
      tradeStateDesc: '模拟支付成功',
      transactionId: o.transactionId,
      amountTotalFen: o.amountFen,
      successTimeISO: o.successTimeISO,
    };
  }

  /**
   * dev 专用：把某个单标记为已支付。
   * 标记完**不直接兑现**，而是让前端轮询走「查单兜底」那条真实路径去兑现 ——
   * 这样 Mock 流程验证的是生产同款的兑现代码（含幂等），而不是一条只有 dev 才走的旁路。
   */
  markPaid(outTradeNo: string): boolean {
    if (isProd()) throw new Error('[beacon/pay] 生产态不得调用 Mock 支付通道');
    const o = orders.get(outTradeNo);
    if (!o || o.paid) return false;
    o.paid = true;
    o.transactionId = `MOCKTX${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    o.successTimeISO = new Date().toISOString();
    return true;
  }

  // dev 退款：立即成功（走生产同款 applyRefundResult 兑现路径，验证套餐回收逻辑）
  async refund(p: RefundParams): Promise<RefundResult> {
    return {
      outRefundNo: p.outRefundNo,
      refundId: `MOCKREFUND${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      status: 'SUCCESS',
      amountRefundFen: p.amountRefundFen,
      successTimeISO: new Date().toISOString(),
    };
  }

  async queryRefund(outRefundNo: string): Promise<RefundResult> {
    return { outRefundNo, status: 'SUCCESS' };
  }
}
