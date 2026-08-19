import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { log } from '@/lib/logger';
import { createRefund } from '@/lib/pay/order';
import { can } from '@/lib/edition';

// 内部受控退款接口（v1 不开放用户自助退款）。
//
// 🔒 双重门禁：
//   1. **默认关闭**——未配置 BEACON_ADMIN_TOKEN 时一律 503，退款通道不存在。
//   2. 配置后需请求头 x-beacon-admin-token 精确匹配（constant-time 比较），否则 401。
// 只做「谁能触发退款」的门禁；退款本身的正确性（全额、安全回收、幂等）在 lib/pay/order.ts。
// 不接受金额入参：金额由服务端从原订单读，防篡改（同下单）。
//
// ⚠️ 本路由在 middleware 的 PUBLIC_PATHS 里（ops 用 curl 调，无登录 cookie）——所以 token 是唯一闸门，
// 务必用足够长的随机 token（openssl rand -hex 32），且只在受信网络/运维手里使用。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tokenOk(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // 长度不等时 timingSafeEqual 会抛，先挡掉（长度本身不是秘密）
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  // 形态闸：企业版（appliance/private）不收钱，支付回调端点不该存在。
  // 回 404 而不是 403 —— 客户机器上这个端点在语义上就是「没有这个东西」，
  // 403 反而是在告诉扫描器「这里有支付入口，只是被关了」。
  if (!can('payment')) return new Response('Not Found', { status: 404 });
  const expected = process.env.BEACON_ADMIN_TOKEN?.trim() ?? '';
  if (!expected) {
    return NextResponse.json({ ok: false, error: '退款通道未启用（未配置 BEACON_ADMIN_TOKEN）' }, { status: 503 });
  }
  const token = req.headers.get('x-beacon-admin-token') ?? '';
  if (!tokenOk(token, expected)) {
    log.warn('内部退款接口鉴权失败');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: { outTradeNo?: string; reason?: string; operator?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const outTradeNo = String(body.outTradeNo ?? '').trim();
  if (!outTradeNo) return NextResponse.json({ ok: false, error: '缺少 outTradeNo' }, { status: 400 });

  // 退款回调地址（可选）：配了就传给微信，让退款结果异步回调；没配则靠即时返回 + 查单兜底
  const notifyUrl = process.env.BEACON_WXPAY_REFUND_NOTIFY_URL?.trim() || undefined;

  const r = await createRefund({
    outTradeNo,
    reason: (body.reason ?? '').slice(0, 80) || undefined,
    operator: (body.operator ?? 'ops').slice(0, 64),
    notifyUrl,
  });
  log.info('内部退款接口调用', { outTradeNo, ok: r.ok, ...(r.ok ? { status: r.status, planRecovered: r.planRecovered } : { reason: r.reason }) });
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
