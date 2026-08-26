import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { POST } from '@/app/api/pay/notify/route';
import { createOrder } from '@/lib/pay/order';
import { MockPayProvider } from '@/lib/pay/mock';

// 回调路由是整个支付**最容易被攻击的入口**：验签漏了 = 任何人 POST 一下就免费升档。
// 这里的每个 🔒 用例都对应一种真实的攻击/事故。

const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const WX_PUB = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const WX_PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(); // 扮演「微信的私钥」
const MERCHANT_KEY = crypto
  .generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const APIV3_KEY = 'k'.repeat(32);
const PUB_KEY_ID = 'PUB_KEY_ID_0000000000000024101100397200000006';
import { OFFICIAL_TEST_MCHID } from './official-key';
const MCHID = OFFICIAL_TEST_MCHID;

function stubEnv() {
  vi.stubEnv('BEACON_PAY_VENDOR', 'wxpay');
  vi.stubEnv('BEACON_WXPAY_APPID', 'wxd678efh567hg6787');
  vi.stubEnv('BEACON_WXPAY_MCHID', MCHID);
  vi.stubEnv('BEACON_WXPAY_SERIAL_NO', '408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB');
  vi.stubEnv('BEACON_WXPAY_PRIVATE_KEY', MERCHANT_KEY);
  vi.stubEnv('BEACON_WXPAY_APIV3_KEY', APIV3_KEY);
  vi.stubEnv('BEACON_WXPAY_PUBLIC_KEY', WX_PUB);
  vi.stubEnv('BEACON_WXPAY_PUBLIC_KEY_ID', PUB_KEY_ID);
  vi.stubEnv('BEACON_WXPAY_NOTIFY_URL', 'https://beacon.example.com/api/pay/notify');
}

/** 用 APIv3 密钥加密一份交易明文（扮演微信侧） */
function encrypt(plain: unknown, key = APIV3_KEY) {
  const nonce = 'abcdef0123456789';
  const aad = 'transaction';
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(nonce, 'utf8'));
  c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return { ciphertext: Buffer.concat([enc, c.getAuthTag()]).toString('base64'), nonce, associated_data: aad };
}

type TxOverrides = Partial<{ out_trade_no: string; transaction_id: string; total: number; mchid: string }>;

function buildNotify(o: TxOverrides & { id?: string; eventType?: string } = {}) {
  const tx = {
    appid: 'wxd678efh567hg6787',
    mchid: o.mchid ?? MCHID,
    out_trade_no: o.out_trade_no ?? 'bcn_X',
    transaction_id: o.transaction_id ?? 'TX_WX_1',
    trade_state: 'SUCCESS',
    trade_state_desc: '支付成功',
    success_time: new Date().toISOString(),
    payer: { openid: 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o' },
    amount: { total: o.total ?? 12_900, payer_total: o.total ?? 12_900, currency: 'CNY' },
  };
  return JSON.stringify({
    id: o.id ?? `EV-${crypto.randomUUID()}`,
    create_time: new Date().toISOString(),
    event_type: o.eventType ?? 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    summary: '支付成功',
    resource: encrypt(tx),
  });
}

/** 扮演微信：用 3 行验签串 + 微信私钥签名 */
function sign(raw: string, ts: string, nonce: string, priv = WX_PRIV): string {
  return crypto.createSign('RSA-SHA256').update(`${ts}\n${nonce}\n${raw}\n`, 'utf8').sign(priv, 'base64');
}

function post(raw: string, opts: { sig?: string; serial?: string; ts?: string; nonce?: string } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000).toString();
  const nonce = opts.nonce ?? 'ABCDEF0123456789';
  const headers = new Headers({
    'Wechatpay-Timestamp': ts,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': opts.sig ?? sign(raw, ts, nonce),
    'Wechatpay-Serial': opts.serial ?? PUB_KEY_ID,
    'Wechatpay-Signature-Type': 'WECHATPAY2-SHA256-RSA2048',
    'Content-Type': 'application/json',
  });
  return POST(new Request('https://beacon.example.com/api/pay/notify', { method: 'POST', headers, body: raw }));
}

async function seedOrder(plan: 'personal' | 'byok' = 'personal') {
  const t = await prisma.tenant.create({ data: { name: '测试租户', plan: 'free' } });
  const m = await prisma.member.create({ data: { tenantId: t.id, name: '所有者', role: 'owner' } });
  const r = await createOrder({ tenantId: t.id, memberId: m.id, plan, periodMonths: 1 }, new MockPayProvider());
  return { tenantId: t.id, outTradeNo: r.outTradeNo, amountFen: r.amountFen };
}

const planOf = (id: string) => prisma.tenant.findUnique({ where: { id } }).then((t) => t?.plan);

beforeEach(async () => {
  await prisma.wxPayNotifyLog.deleteMany();
  await prisma.paymentOrder.deleteMany();
  await prisma.member.deleteMany();
  await prisma.tenant.deleteMany();
  vi.unstubAllEnvs();
  stubEnv();
});
afterEach(() => vi.unstubAllEnvs());

describe('pay/notify · 验签（漏了 = 任何人 POST 一下就免费升档）', () => {
  it('合法签名 → 204 且**无应答报文体**（APIv3 的成功就是这样，不需要 {"code":"SUCCESS"}）', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const res = await post(buildNotify({ out_trade_no: outTradeNo }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe(''); // 空 body
    expect(await planOf(tenantId)).toBe('personal');
  });

  it('🔒 伪造签名 → 拒绝，且**不发货**', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const res = await post(buildNotify({ out_trade_no: outTradeNo }), { sig: 'ZmFrZQ==' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'FAIL', message: '签名验证失败' });
    expect(await planOf(tenantId)).toBe('free'); // ★ 没升档
    expect((await prisma.paymentOrder.findUnique({ where: { outTradeNo } }))?.status).toBe('created');
  });

  it('🔒 完全没有签名头 → 拒绝', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const raw = buildNotify({ out_trade_no: outTradeNo });
    const res = await POST(
      new Request('https://x/api/pay/notify', {
        method: 'POST',
        headers: new Headers({ 'Wechatpay-Serial': PUB_KEY_ID }),
        body: raw,
      }),
    );
    expect(res.status).toBe(401);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 攻击者用自己的私钥签一个「我付了钱」的报文 → 拒绝', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const raw = buildNotify({ out_trade_no: outTradeNo });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await post(raw, { sig: sign(raw, ts, 'N', evil), ts, nonce: 'N' });
    expect(res.status).toBe(401);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 签名合法但 body 被改过一个字节 → 拒绝', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const raw = buildNotify({ out_trade_no: outTradeNo, id: 'EV-ORIGINAL' });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = sign(raw, ts, 'N'); // 对原文签名
    const tampered = raw.replace('EV-ORIGINAL', 'EV-TAMPERED'); // 改外层 body
    expect(tampered).not.toBe(raw);
    const res = await post(tampered, { sig, ts, nonce: 'N' });
    expect(res.status).toBe(401);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 换单号必须同时打破签名或 authTag —— out_trade_no 在密文里，改不了外层', async () => {
    // 这条用例最初写错了：以为可以在外层 body 里把 a 的单号 replace 成 b 的单号。
    // 实际上外层只有 id/create_time/event_type/resource{ciphertext,nonce,associated_data}，
    // out_trade_no 在 AES-256-GCM 密文**内部**。所以「拿 a 的合法回调去给 b 发货」这条攻击
    // 需要同时伪造微信签名**和** GCM authTag —— 两把不同的密钥，都在微信手上。
    const a = await seedOrder('personal');
    const b = await seedOrder('byok');
    const raw = buildNotify({ out_trade_no: a.outTradeNo, total: a.amountFen });
    expect(raw).not.toContain(a.outTradeNo); // ★ 单号根本不在外层报文里

    // 攻击者能做的只有：把整个 resource 换成自己伪造的密文 → GCM 解密必失败（400）
    const forged = JSON.parse(raw);
    const evilKey = 'z'.repeat(32);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(evilKey, 'utf8'), Buffer.from('abcdef0123456789', 'utf8'));
    c.setAAD(Buffer.from('transaction', 'utf8'));
    const enc = Buffer.concat([c.update(JSON.stringify({ out_trade_no: b.outTradeNo, transaction_id: 'X', mchid: MCHID, amount: { total: b.amountFen } }), 'utf8'), c.final()]);
    forged.resource = {
      ciphertext: Buffer.concat([enc, c.getAuthTag()]).toString('base64'),
      nonce: 'abcdef0123456789',
      associated_data: 'transaction',
    };
    const res = await post(JSON.stringify(forged)); // 重新签名（假设攻击者连微信私钥都拿到了）
    expect(res.status).toBe(400); // 仍然被 APIv3 密钥挡住
    expect(await planOf(b.tenantId)).toBe('free');
  });

  it('🔒 微信的 SIGNTEST 探测流量 → 照常按验签失败处理（特殊处理它 = 亲手关掉验签）', async () => {
    // 微信会在极少数回调里故意发错误签名，探测商户是否真的验了签。
    // 正确做法：不特殊处理，验不过就 4xx，微信随后带正确签名重发。
    const { tenantId, outTradeNo } = await seedOrder();
    const res = await post(buildNotify({ out_trade_no: outTradeNo }), { sig: 'WECHATPAY/SIGNTEST/' + 'A'.repeat(300) });
    expect(res.status).toBe(401);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 Wechatpay-Serial 与配置的公钥 ID 不符 → 拒绝（防拿平台证书序列号糊弄）', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const res = await post(buildNotify({ out_trade_no: outTradeNo }), { serial: '408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB' });
    expect(res.status).toBe(401);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 timestamp/nonce 被改 → 拒绝（它们参与验签）', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const raw = buildNotify({ out_trade_no: outTradeNo });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = sign(raw, ts, 'N');
    expect((await post(raw, { sig, ts: '1', nonce: 'N' })).status).toBe(401);
    expect((await post(raw, { sig, ts, nonce: 'OTHER' })).status).toBe(401);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 支付通道未配置 → 503 拒绝（**没有 dev 免验签旁路**）', async () => {
    // 这条路由没有 Mock 分支：给它开一条「dev 跳过验签」的口子就是给生产留免费升档后门
    vi.unstubAllEnvs();
    const { tenantId, outTradeNo } = await seedOrder();
    const res = await post(buildNotify({ out_trade_no: outTradeNo }));
    expect(res.status).toBe(503);
    expect(await planOf(tenantId)).toBe('free');
  });
});

describe('pay/notify · 解密', () => {
  it('🔒 密文被篡改 → 400，不发货（GCM 的 authTag 真的验了 —— 靠 final()）', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const body = JSON.parse(buildNotify({ out_trade_no: outTradeNo }));
    const buf = Buffer.from(body.resource.ciphertext, 'base64');
    buf[0] ^= 0xff;
    body.resource.ciphertext = buf.toString('base64');
    const raw = JSON.stringify(body); // 重新签名，模拟「签名合法但密文被换」
    const res = await post(raw);
    expect(res.status).toBe(400);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 用别的 APIv3 密钥加密的报文 → 400', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const body = JSON.parse(buildNotify({ out_trade_no: outTradeNo }));
    body.resource = encrypt({ out_trade_no: outTradeNo, transaction_id: 'X', amount: { total: 1 } }, 'z'.repeat(32));
    const res = await post(JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('🔒 mchid 不是我们的 → 400（纵深防御）', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const res = await post(buildNotify({ out_trade_no: outTradeNo, mchid: '9999999999' }));
    expect(res.status).toBe(400);
    expect(await planOf(tenantId)).toBe('free');
  });

  it('非法 JSON / 缺字段 → 400', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ id: 'EV-1' }))).status).toBe(400); // 缺 resource
  });

  it('非支付成功事件 → 204 收下（避免微信无谓重发），但不发货', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const res = await post(buildNotify({ out_trade_no: outTradeNo, eventType: 'REFUND.SUCCESS' }));
    expect(res.status).toBe(204);
    expect(await planOf(tenantId)).toBe('free');
  });
});

describe('pay/notify · 金额与幂等', () => {
  it('🔒 报文里的金额被改成 1 分 → 不发货（服务端拿下单金额对账）', async () => {
    const { tenantId, outTradeNo } = await seedOrder('personal'); // 应付 12900
    const res = await post(buildNotify({ out_trade_no: outTradeNo, total: 1 }));
    expect(res.status).toBe(204); // 收下不让微信重发，但
    expect(await planOf(tenantId)).toBe('free'); // ★ 绝不发货
    const o = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    expect(o?.status).toBe('failed');
    expect(o?.failReason).toMatch(/金额不匹配/);
  });

  it('🔒 微信重发同一通知 15 次 → 只发一次货，且每次都 204', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const raw = buildNotify({ out_trade_no: outTradeNo, id: 'EV-SAME' });
    for (let i = 0; i < 15; i++) {
      const res = await post(raw);
      expect(res.status).toBe(204);
    }
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('personal');
    const days = Math.round((t!.planExpiresAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBeLessThan(32); // ★ 只加了一个月，不是 15 个月
    expect(await prisma.wxPayNotifyLog.count()).toBe(1); // notifyId 唯一索引挡住了
  });

  it('🔒 **并发**收到同一通知 → 只发一次货', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    const raw = buildNotify({ out_trade_no: outTradeNo, id: 'EV-CONCURRENT' });
    const results = await Promise.all(Array.from({ length: 6 }, () => post(raw)));
    for (const r of results) expect([204, 500]).toContain(r.status); // 不能有 4xx（那会让微信以为我们拒了）
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(t?.plan).toBe('personal');
    expect(Math.round((t!.planExpiresAt!.getTime() - Date.now()) / 86_400_000)).toBeLessThan(32);
  });

  it('🔒 不同 notifyId 但同一笔支付（微信换了事件 id 重发）→ 仍只发一次货', async () => {
    // 第一道锁（notifyId）对这种情况无效，靠的是第二道锁：订单条件写 + transactionId 唯一
    const { tenantId, outTradeNo } = await seedOrder();
    await post(buildNotify({ out_trade_no: outTradeNo, id: 'EV-A', transaction_id: 'TX_SAME' }));
    const end1 = (await prisma.tenant.findUnique({ where: { id: tenantId } }))!.planExpiresAt;
    const res = await post(buildNotify({ out_trade_no: outTradeNo, id: 'EV-B', transaction_id: 'TX_SAME' }));
    expect(res.status).toBe(204);
    const end2 = (await prisma.tenant.findUnique({ where: { id: tenantId } }))!.planExpiresAt;
    expect(end2).toEqual(end1); // ★ 没有叠加
    expect(await prisma.wxPayNotifyLog.count()).toBe(2); // 两条日志，但只发一次货
  });

  it('回调日志只记摘要，不落 openid 等个人信息', async () => {
    const { outTradeNo } = await seedOrder();
    await post(buildNotify({ out_trade_no: outTradeNo }));
    const logs = await prisma.wxPayNotifyLog.findMany();
    expect(logs.length).toBe(1);
    expect(JSON.stringify(logs[0])).not.toContain('oUpF8uMuAJO_M2pxb1Q9zNjWeS6o');
    expect(logs[0].processed).toBe(true);
    expect(logs[0].outTradeNo).toBe(outTradeNo);
  });

  it('订单不存在 → 204 收下并记账（重发也不会好，日志已报警）', async () => {
    const res = await post(buildNotify({ out_trade_no: 'bcn_GHOST' }));
    expect(res.status).toBe(204);
    const logs = await prisma.wxPayNotifyLog.findMany();
    expect(logs[0]?.orderId).toBeNull(); // 匹配不到订单也要留痕便于排障
  });

  it('🔒 上次记了日志但没兑现完就崩了 → 重发时继续兑现（不能直接 204 把货吞掉）', async () => {
    const { tenantId, outTradeNo } = await seedOrder();
    // 手工制造「日志已记、processed=false、订单仍 created」的中断现场
    await prisma.wxPayNotifyLog.create({
      data: { notifyId: 'EV-CRASHED', outTradeNo, eventType: 'TRANSACTION.SUCCESS', processed: false },
    });
    expect(await planOf(tenantId)).toBe('free');
    const res = await post(buildNotify({ out_trade_no: outTradeNo, id: 'EV-CRASHED' }));
    expect(res.status).toBe(204);
    expect(await planOf(tenantId)).toBe('personal'); // ★ 补上了，没被 notifyId 去重吞掉
  });
});

describe('pay/notify · raw body 处理', () => {
  it('🔒 带空格的原始报文能验签通过（证明我们没有对 body 做 JSON 往返）', async () => {
    // 若路由里先 req.json() 再 stringify 去验签，空白会被重排 → 验签必失败。
    // 这条用例就是防止有人「顺手优化」成那样。
    const { tenantId, outTradeNo } = await seedOrder();
    const compact = buildNotify({ out_trade_no: outTradeNo });
    const spaced = JSON.stringify(JSON.parse(compact), null, 2); // 带缩进和换行的等价报文
    expect(spaced).not.toBe(compact);
    const res = await post(spaced); // 对 spaced 原文签名
    expect(res.status).toBe(204);
    expect(await planOf(tenantId)).toBe('personal');
  });
});
