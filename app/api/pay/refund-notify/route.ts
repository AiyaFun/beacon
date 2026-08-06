import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { decryptResource, verifySignature } from '@/lib/pay/sign';
import { readWxPayEnv } from '@/lib/pay/provider';
import { applyRefundResult } from '@/lib/pay/order';
import type { RefundState } from '@/lib/pay/types';

// 微信支付**退款结果**回调。与支付回调 (../notify) 同构：验签 → 解密 → 幂等兑现。
// 单独一条路由是必须的：支付回调路由按 event_type 直接 204 吞掉 REFUND.*，且它解出的是
// 交易报文（out_trade_no/transaction_id），不是退款报文（out_refund_no/refund_status）。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 退款回调解密后的明文（只列用到的字段）
type RefundResource = {
  mchid?: string;
  out_trade_no?: string;
  out_refund_no?: string;
  refund_id?: string;
  refund_status?: string; // SUCCESS | CLOSED | ABNORMAL
  success_time?: string;
  amount?: { refund?: number };
};

type NotifyBody = {
  id?: string;
  event_type?: string; // REFUND.SUCCESS | REFUND.ABNORMAL | REFUND.CLOSED
  resource?: { ciphertext: string; nonce: string; associated_data?: string };
  summary?: string;
};

function fail(status: number, message: string) {
  return NextResponse.json({ code: 'FAIL', message }, { status });
}

// 微信 refund_status → 我们的 RefundState（退款回调不会出现 PROCESSING）
function toRefundState(s: string | undefined): RefundState {
  if (s === 'SUCCESS') return 'SUCCESS';
  if (s === 'CLOSED') return 'CLOSED';
  return 'ABNORMAL';
}

export async function POST(req: Request) {
  // 🔒 原始字节验签，同支付回调：先 text() 验签，再 JSON.parse 用于业务
  const raw = await req.text();
  const h = req.headers;
  const timestamp = h.get('Wechatpay-Timestamp') ?? '';
  const nonce = h.get('Wechatpay-Nonce') ?? '';
  const signature = h.get('Wechatpay-Signature') ?? '';
  const serial = h.get('Wechatpay-Serial') ?? '';

  let env;
  try {
    env = readWxPayEnv();
  } catch (e) {
    log.error('收到退款回调但支付通道未配置，拒绝', { err: (e as Error).message });
    return fail(503, '支付通道未配置');
  }

  // 公钥模式：Wechatpay-Serial 必须等于配置的公钥 ID
  if (serial !== env.publicKeyId) {
    log.error('退款回调 Wechatpay-Serial 与配置的公钥 ID 不符，拒绝', { got: serial, expect: env.publicKeyId });
    return fail(401, '签名证书序列号不匹配');
  }

  const verified = verifySignature({ timestamp, nonceStr: nonce, body: raw, signature, publicKeyPem: env.publicKeyPem });
  if (!verified) {
    log.warn('退款回调验签失败，拒绝', { serial, timestamp, hasSig: !!signature });
    return fail(401, '签名验证失败');
  }

  let notify: NotifyBody;
  try {
    notify = JSON.parse(raw) as NotifyBody;
  } catch {
    return fail(400, '报文不是合法 JSON');
  }
  if (!notify.id || !notify.resource) return fail(400, '报文缺少 id 或 resource');
  if (!notify.event_type?.startsWith('REFUND.')) {
    log.info('忽略非退款事件回调', { eventType: notify.event_type, id: notify.id });
    return new NextResponse(null, { status: 204 });
  }

  let rf: RefundResource;
  try {
    rf = decryptResource(env.apiV3Key, notify.resource) as RefundResource;
  } catch (e) {
    log.error('退款回调 resource 解密失败', { id: notify.id, err: (e as Error).message });
    return fail(400, '报文解密失败');
  }
  if (rf.mchid && rf.mchid !== env.mchid) {
    log.error('退款回调 mchid 与配置不符', { got: rf.mchid });
    return fail(400, '商户号不匹配');
  }
  if (!rf.out_refund_no) return fail(400, '退款报文缺少 out_refund_no');

  // 关联订单（用于日志 orderId），失败不阻断
  const refund = await prisma.wxPayRefund.findUnique({ where: { outRefundNo: rf.out_refund_no }, select: { orderId: true } });

  // 幂等第一道锁：notifyId 唯一索引（复用 WxPayNotifyLog）
  let duplicate = false;
  try {
    await prisma.wxPayNotifyLog.create({
      data: {
        notifyId: notify.id,
        orderId: refund?.orderId,
        outTradeNo: rf.out_trade_no,
        eventType: notify.event_type,
        tradeState: rf.refund_status,
        rawSummary: `${notify.summary ?? ''} refund ${rf.refund_status ?? ''} ${rf.amount?.refund ?? ''}分`.trim(),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    duplicate = true;
  }
  if (duplicate) {
    const prev = await prisma.wxPayNotifyLog.findUnique({ where: { notifyId: notify.id }, select: { processed: true } });
    if (prev?.processed) return new NextResponse(null, { status: 204 });
    log.warn('重复退款回调但上次未完成兑现，继续兑现', { id: notify.id, outRefundNo: rf.out_refund_no });
  }

  try {
    const r = await applyRefundResult({
      outRefundNo: rf.out_refund_no,
      refundId: rf.refund_id,
      status: toRefundState(rf.refund_status),
      successTimeISO: rf.success_time,
      source: 'notify',
    });
    if (!r.ok) {
      log.error('退款回调兑现被拒', { outRefundNo: rf.out_refund_no, reason: r.reason });
      await prisma.wxPayNotifyLog.updateMany({ where: { notifyId: notify.id }, data: { processed: true } });
      return new NextResponse(null, { status: 204 });
    }
    await prisma.wxPayNotifyLog.updateMany({ where: { notifyId: notify.id }, data: { processed: true } });
  } catch (e) {
    log.error('退款回调兑现异常，返回 5xx 请求微信重发', { outRefundNo: rf.out_refund_no, err: (e as Error).message });
    return fail(500, '处理失败，请重试');
  }

  return new NextResponse(null, { status: 204 });
}
