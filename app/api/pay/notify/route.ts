import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { decryptResource, verifySignature } from '@/lib/pay/sign';
import { readWxPayEnv } from '@/lib/pay/provider';
import { fulfillOrder } from '@/lib/pay/order';

// 微信支付结果回调。**整个支付里最容易被攻击的一个入口** —— 不验签 = 任何人 POST 一下就免费升档。
//
// 必须 node runtime：edge 没有 node:crypto 的 createVerify / createDecipheriv。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 解密后的交易明文（只列我们用到的字段）
type Transaction = {
  appid?: string;
  mchid?: string;
  out_trade_no?: string;
  transaction_id?: string;
  trade_state?: string;
  success_time?: string;
  amount?: { total?: number; payer_total?: number };
};

type NotifyBody = {
  id?: string;
  event_type?: string;
  resource_type?: string;
  summary?: string;
  resource?: { ciphertext: string; nonce: string; associated_data?: string };
};

/** 验签失败/报文非法的统一应答。微信只看状态码：4XX/5XX = 失败，会按 15s/15s/30s/3m… 重发（最多 15 次）。 */
function fail(status: number, message: string) {
  return NextResponse.json({ code: 'FAIL', message }, { status });
}

export async function POST(req: Request) {
  // ── 1. 拿原始报文 ─────────────────────────────────────
  // 🔒 必须是**未经改动的原始字节**：验签对 body 逐字节敏感，
  // 先 req.json() 再拿去验签 = JSON.parse→stringify 往返 = 空白被重排 = 永远验不过。
  // 而且 body 只能读一次（读两次抛 TypeError）→ 读 text()，验签用它，业务再 JSON.parse 它。
  const raw = await req.text();

  const h = req.headers; // Headers 大小写不敏感
  const timestamp = h.get('Wechatpay-Timestamp') ?? '';
  const nonce = h.get('Wechatpay-Nonce') ?? '';
  const signature = h.get('Wechatpay-Signature') ?? '';
  const serial = h.get('Wechatpay-Serial') ?? '';

  // ── 2. 配置 ───────────────────────────────────────────
  // 注意这条路由**没有 Mock 分支**：没配微信凭证就无法验签，无法验签就一律拒绝。
  // 给它开一条「dev 免验签」的口子，就是给生产留一个免费升档后门（Mock 短信那个洞的同款结构）。
  let env;
  try {
    env = readWxPayEnv();
  } catch (e) {
    log.error('收到微信支付回调但支付通道未配置，拒绝', { err: (e as Error).message });
    return fail(503, '支付通道未配置');
  }

  // ── 3. 验签 ───────────────────────────────────────────
  // 只认微信支付公钥模式：Wechatpay-Serial 必须等于我们配置的公钥 ID（PUB_KEY_ID_...）。
  // 若线上收到的是 40 位 hex 序列号，说明该商户号处于平台证书/公钥灰度期 —— 本实现不支持，
  // 会在这里拒绝并打日志（宁可拒绝也不要在验签上「兼容」出一个洞）。详见 docs/微信支付接入.md。
  if (serial !== env.publicKeyId) {
    log.error('回调 Wechatpay-Serial 与配置的微信支付公钥 ID 不符，拒绝', { got: serial, expect: env.publicKeyId });
    return fail(401, '签名证书序列号不匹配');
  }

  // 微信会故意发**错误签名的探测流量**（签名以 WECHATPAY/SIGNTEST/ 开头）来检查商户是否真的验了签。
  // 这里不做任何特殊处理：验不过就 401，微信随后会带正确签名重发。
  const verified = verifySignature({
    timestamp,
    nonceStr: nonce,
    body: raw,
    signature,
    publicKeyPem: env.publicKeyPem,
  });
  if (!verified) {
    log.warn('微信支付回调验签失败，拒绝', { serial, timestamp, hasSig: !!signature });
    return fail(401, '签名验证失败');
  }

  // ── 4. 解析 + 解密 ────────────────────────────────────
  let notify: NotifyBody;
  try {
    notify = JSON.parse(raw) as NotifyBody;
  } catch {
    return fail(400, '报文不是合法 JSON');
  }
  if (!notify.id || !notify.resource) return fail(400, '报文缺少 id 或 resource');

  // 只处理支付成功事件；其它事件（退款等）如实记账后 204，避免微信无谓重发
  if (notify.event_type !== 'TRANSACTION.SUCCESS') {
    log.info('忽略非支付成功回调', { eventType: notify.event_type, id: notify.id });
    return new NextResponse(null, { status: 204 });
  }

  let tx: Transaction;
  try {
    tx = decryptResource(env.apiV3Key, notify.resource) as Transaction;
  } catch (e) {
    // 解密失败 = 密文被篡改 / APIv3 密钥配错 / AAD 不符。绝不放行。
    // （decryptResource 一定调了 final()，authTag 真的被验过 —— 最流行的那个 Node 库正是漏了这步，
    //  篡改密文会静默返回污染明文。）
    log.error('回调 resource 解密失败', { id: notify.id, err: (e as Error).message });
    return fail(400, '报文解密失败');
  }

  // 商户号必须是我们自己的 —— 纵深防御
  if (tx.mchid && tx.mchid !== env.mchid) {
    log.error('回调 mchid 与配置不符', { got: tx.mchid });
    return fail(400, '商户号不匹配');
  }
  if (!tx.out_trade_no || !tx.transaction_id) return fail(400, '交易报文缺少订单号或交易号');

  // ── 5. 幂等 + 兑现 ────────────────────────────────────
  // 关于 5 秒应答：官方建议「先应答再异步处理业务」。这里选择**同步兑现后再应答**，理由：
  //   兑现只是 3 条 DB 写（读租户 → 条件写订单 → 更新租户），远快于 5s 预算；
  //   而「先 204 再异步」一旦异步段崩了，微信认为已成功、不再重发，这一单就永久漏发货，
  //   只能等查单兜底或人工。用同步 + 出错返 5xx 换微信重发，是更小的代价。
  //   若将来兑现变重（发票/对账/通知），再改成入队。
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo: tx.out_trade_no }, select: { id: true } });

  // 第一道锁：notifyId 唯一索引。微信重发同一通知 → INSERT 冲突 → 快速 204。
  let duplicate = false;
  try {
    await prisma.wxPayNotifyLog.create({
      data: {
        notifyId: notify.id,
        orderId: order?.id,
        outTradeNo: tx.out_trade_no,
        eventType: notify.event_type,
        tradeState: tx.trade_state,
        // 摘要而非全量：解密明文含 payer.openid 等个人信息，不落库
        rawSummary: `${notify.summary ?? ''} ${tx.trade_state ?? ''} ${tx.amount?.total ?? ''}分`.trim(),
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    duplicate = true;
  }

  if (duplicate) {
    // 重复通知。但**不能直接 204 就完事**：如果上一次记完日志就崩了、还没兑现，
    // 直接返回会让这一单永远发不出货。查一下是否真的兑现过，没兑现就继续走（兑现本身幂等）。
    const prev = await prisma.wxPayNotifyLog.findUnique({ where: { notifyId: notify.id }, select: { processed: true } });
    if (prev?.processed) return new NextResponse(null, { status: 204 });
    log.warn('重复回调但上次未完成兑现，继续兑现', { id: notify.id, outTradeNo: tx.out_trade_no });
  }

  try {
    const r = await fulfillOrder({
      outTradeNo: tx.out_trade_no,
      transactionId: tx.transaction_id,
      amountTotalFen: tx.amount?.total,
      paidAt: tx.success_time ? new Date(tx.success_time) : new Date(),
      source: 'notify',
    });
    if (!r.ok) {
      // 金额不匹配 / 订单不存在：这是我们侧的账有问题，重发也不会好。
      // 记账后 204 收下，避免微信重发 15 次，同时日志已 error 级别报警。
      log.error('回调兑现被拒', { outTradeNo: tx.out_trade_no, reason: r.reason });
      await markProcessed(notify.id);
      return new NextResponse(null, { status: 204 });
    }
    await markProcessed(notify.id);
  } catch (e) {
    // 兑现出错（DB 抖动等）→ 返 5xx 让微信按退避策略重发
    log.error('回调兑现异常，返回 5xx 请求微信重发', { outTradeNo: tx.out_trade_no, err: (e as Error).message });
    return fail(500, '处理失败，请重试');
  }

  // ── 6. 应答 ───────────────────────────────────────────
  // 🔒 成功 = **200/204 且无应答报文体**。
  // APIv3 **不需要**返回 {"code":"SUCCESS"} —— 那是 APIv2 XML 时代的遗留，照抄会白白挨 15 次重发。
  return new NextResponse(null, { status: 204 });
}

async function markProcessed(notifyId: string): Promise<void> {
  await prisma.wxPayNotifyLog.updateMany({ where: { notifyId }, data: { processed: true } });
}
