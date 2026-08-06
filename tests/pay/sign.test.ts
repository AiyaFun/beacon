import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  buildSignMessage,
  signMessage,
  buildAuthorization,
  buildVerifyMessage,
  verifySignature,
  decryptResource,
  stripAstralChars,
  isValidOutTradeNo,
  newOutTradeNo,
  newNonceStr,
  nowTimestamp,
} from '@/lib/pay/sign';
import { OFFICIAL_TEST_KEY, OFFICIAL_TEST_MCHID, OFFICIAL_TEST_SERIAL } from './official-key';

// 签名层的验收标准 = **官方文档给的签名向量逐字节复现**。
// APIv3 用 RSASSA-PKCS1-v1_5，无随机数 → 同串同 key 必得同签名，所以官方示例是硬 oracle。
// 这一层不需要真实商户凭证就能证明对错 —— 拿到用户的 mchid/私钥后，
// 剩下的不确定性只在「凭证本身对不对 / 产品权限开没开」，不在我们的代码。

describe('pay/sign · 官方签名向量对拍（不需要真实凭证即可证伪）', () => {
  it('向量1：POST + body —— 官方文档 4012365336 的 JSAPI 下单示例', () => {
    // 官方给的 body 字符串，一字不改（签名对 body 是逐字节敏感的）
    const body =
      '{"appid":"wxd678efh567hg6787","mchid":"1900007291","description":"Image形象店-深圳腾大-QQ公仔",' +
      '"out_trade_no":"1217752501201407033233368018","notify_url":"https://www.weixin.qq.com/wxpay/pay.php",' +
      '"amount":{"total":100,"currency":"CNY"},"payer":{"openid":"oUpF8uMuAJO_M2pxb1Q9zNjWeS6o"}}';
    const msg = buildSignMessage(
      'POST',
      '/v3/pay/transactions/jsapi',
      '1554208460',
      '593BEC0C930BF1AFEB40B4A08C8FB242',
      body,
    );
    expect(signMessage(msg, OFFICIAL_TEST_KEY)).toBe(
      'jnks4dlrPw3ZX+ozVvSK39oa0t7OMBsg83BHAwd8BRdUFiVaQNTLTvci+wURgP1OQBbKYhFGvt7iqYpDSTQkp7Uq1sltaQKync' +
        'CyrA1g88m5bsKERQfPyT0ahSwKTYJ1CAn9QiJuSJRq1QsQs07eehbU/k9BCS51jTyc1Jpsi2H77HF9f/BnjXAOP3/sPObg6V5E' +
        'e4EzwLox684hhuMuIwHo7D8KFk3LIHOKDcNI4It1aCXydFWNpNK+SG86VUDe5kwoDpw4Ulqfu9z8OFDGbDs9TCxEv8iqQzbpxO' +
        'lEVoOe2kalSYM5kApQb3nZcxdUtoE0liJGW3RGUNE0t4v01A==',
    );
  });

  it('向量2：GET + path 参数 + 空 body —— 官方文档 4012365334 的查退款示例', () => {
    // 空 body 时最后一行只剩一个 \n。这条向量证明的正是这个边界。
    const msg = buildSignMessage(
      'GET',
      '/v3/refund/domestic/refunds/123123123123',
      '1554208460',
      '593BEC0C930BF1AFEB40B4A08C8FB242',
      '',
    );
    expect(signMessage(msg, OFFICIAL_TEST_KEY)).toBe(
      'Lc9VXxmeonkdV8Xk9tmigQFLhl0vRWTerdmoRu01aAnYwIrD/5nsSwE1WlmZGLRlAFTNQ3QsMa0+VRDlJp1Wp5p0nO8EK68b5s' +
        'JBbjouxaFciIfq1zfDWWz+jqhcMoKXI1A6dPm1AW7D4d30WsMTNzp6g23OXakIsh9LO3lUmwvTuE0BY8ncf6tNGk4wKmvXwERd' +
        '/ZpoQY3MAVKz+Nakwc+2XBmzT66KcUehU5kr4IvGa/lEU5RZb/q00zP9VLdBhC/jQSX3X1UcJLCtEc4gTmib4tnmAT+bHF/e17' +
        'ZAuxDNcx6rqT8gNEXqaJGG+1OflMSTU2tpyG65G4dMKdFcoA==',
    );
  });

  // 官方文档 4012365865（query 参数篇）的期望值 **是错的**：用文档自己给的 openssl
  // 命令跑也复现不出来，穷举 6 种 query 排列 × 3 种 path × 2 种 body 都得不到它。
  // 结论是文档的期望值 stale，不是实现错 —— 所以那条向量**不作为验收标准**。
  // 但「query 参与签名」这条规则本身是对的（文档正文明确 + 向量1/2 的构造方式印证），
  // 下面这条锁的是规则，不是那个错的期望值。
  it('规则：URL 行必须带 query，改 query 必然改签名（查单 ?mchid= 靠这条）', () => {
    const withQuery = buildSignMessage('GET', '/v3/pay/transactions/out-trade-no/X1?mchid=1900007291', '1', 'N', '');
    const without = buildSignMessage('GET', '/v3/pay/transactions/out-trade-no/X1', '1', 'N', '');
    expect(withQuery).not.toBe(without);
    expect(signMessage(withQuery, OFFICIAL_TEST_KEY)).not.toBe(signMessage(without, OFFICIAL_TEST_KEY));
  });
});

describe('pay/sign · 待签串构造（每一条都是能让线上 401 的坑）', () => {
  it('5 行，且最后一行也以 \\n 结尾', () => {
    expect(buildSignMessage('POST', '/v3/pay/transactions/native', '1554208460', 'ABC', '{"a":1}')).toBe(
      'POST\n/v3/pay/transactions/native\n1554208460\nABC\n{"a":1}\n',
    );
  });

  it('空 body → 最后一行只有一个 \\n（不是空字符串，也不是两个）', () => {
    expect(buildSignMessage('GET', '/v3/certificates', '1', 'N', '')).toBe('GET\n/v3/certificates\n1\nN\n\n');
  });

  it('签名确定性：同串同 key 必得同签名（这正是官方向量能当 oracle 的前提）', () => {
    const m = buildSignMessage('GET', '/v3/certificates', '1', 'N', '');
    expect(signMessage(m, OFFICIAL_TEST_KEY)).toBe(signMessage(m, OFFICIAL_TEST_KEY));
  });

  it('PKCS#8 与 PKCS#1 两种 PEM 产出相同签名（无需转换格式）', () => {
    const pkcs1 = crypto.createPrivateKey(OFFICIAL_TEST_KEY).export({ type: 'pkcs1', format: 'pem' }).toString();
    const m = buildSignMessage('GET', '/v3/certificates', '1', 'N', '');
    expect(signMessage(m, pkcs1)).toBe(signMessage(m, OFFICIAL_TEST_KEY));
  });

  it('签名长度 256 字节 → base64 344 字符', () => {
    const sig = signMessage(buildSignMessage('GET', '/x', '1', 'N', ''), OFFICIAL_TEST_KEY);
    expect(Buffer.from(sig, 'base64').length).toBe(256);
    expect(sig.length).toBe(344);
  });
});

describe('pay/sign · Authorization 头', () => {
  const base = {
    mchid: OFFICIAL_TEST_MCHID,
    serialNo: OFFICIAL_TEST_SERIAL,
    privateKeyPem: OFFICIAL_TEST_KEY,
    method: 'GET',
    urlPath: '/v3/certificates',
    timestamp: '1554208460',
    nonceStr: '593BEC0C930BF1AFEB40B4A08C8FB242',
  };

  it('格式：认证类型 + 5 个带双引号字段，逗号分隔且逗号后无空格', () => {
    const h = buildAuthorization(base);
    expect(h.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
    expect(h).toContain(`mchid="${OFFICIAL_TEST_MCHID}"`);
    expect(h).toContain(`serial_no="${OFFICIAL_TEST_SERIAL}"`);
    expect(h).toContain('timestamp="1554208460"');
    expect(h).toContain('nonce_str="593BEC0C930BF1AFEB40B4A08C8FB242"');
    expect(h).not.toMatch(/,\s/); // 逗号后不能有空格
  });

  it('头里的 signature 与「用同样 timestamp/nonce 手算」一致 —— 三者必须同源', () => {
    const h = buildAuthorization(base);
    const expected = signMessage(
      buildSignMessage(base.method, base.urlPath, base.timestamp, base.nonceStr, ''),
      OFFICIAL_TEST_KEY,
    );
    expect(h).toContain(`signature="${expected}"`);
  });

  it('body 参与签名：body 变一个字节，头里的签名就变', () => {
    const a = buildAuthorization({ ...base, method: 'POST', body: '{"total":1}' });
    const b = buildAuthorization({ ...base, method: 'POST', body: '{"total":2}' });
    expect(a).not.toBe(b);
  });
});

// ── 验签方向：自己造 keypair 造向量，重点是**负面对照** ──
const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function signNotify(timestamp: string, nonce: string, body: string): string {
  return crypto.createSign('RSA-SHA256').update(`${timestamp}\n${nonce}\n${body}\n`, 'utf8').sign(PRIV, 'base64');
}

describe('pay/sign · 回调验签（验签漏了 = 任何人 POST 一下就免费升档）', () => {
  const ts = '1554208460';
  const nonce = 'ABCDEF0123456789';
  const body = '{"id":"EV-1","event_type":"TRANSACTION.SUCCESS"}';

  it('验签串是 3 行（不是请求签名的 5 行）', () => {
    expect(buildVerifyMessage(ts, nonce, body)).toBe(`${ts}\n${nonce}\n${body}\n`);
  });

  it('合法签名 → 通过', () => {
    expect(
      verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: signNotify(ts, nonce, body), publicKeyPem: PUB }),
    ).toBe(true);
  });

  it('🔒 伪造签名 → 拒绝', () => {
    expect(
      verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: 'ZmFrZS1zaWduYXR1cmU=', publicKeyPem: PUB }),
    ).toBe(false);
  });

  it('🔒 别人的私钥签的 → 拒绝', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sig = crypto
      .createSign('RSA-SHA256')
      .update(`${ts}\n${nonce}\n${body}\n`, 'utf8')
      .sign(other.privateKey, 'base64');
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: sig, publicKeyPem: PUB })).toBe(false);
  });

  it('🔒 篡改 body（哪怕只改金额一位）→ 拒绝', () => {
    const sig = signNotify(ts, nonce, body);
    const tampered = body.replace('EV-1', 'EV-2');
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body: tampered, signature: sig, publicKeyPem: PUB })).toBe(
      false,
    );
  });

  it('🔒 篡改 timestamp / nonce → 拒绝', () => {
    const sig = signNotify(ts, nonce, body);
    expect(verifySignature({ timestamp: '1554208461', nonceStr: nonce, body, signature: sig, publicKeyPem: PUB })).toBe(false);
    expect(verifySignature({ timestamp: ts, nonceStr: 'XXXX', body, signature: sig, publicKeyPem: PUB })).toBe(false);
  });

  it('🔒 微信的 SIGNTEST 探测流量（故意的错误签名）→ 走正常失败分支，不抛异常', () => {
    // 微信会在极少数回调里发错误签名，探测商户是否真的验了签。不特殊处理它，
    // 验不过就返回 4xx，微信随后会带正确签名重发。特殊处理 = 亲手把验签关掉。
    const probe = 'WECHATPAY/SIGNTEST/' + 'A'.repeat(300);
    expect(() =>
      verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: probe, publicKeyPem: PUB }),
    ).not.toThrow();
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: probe, publicKeyPem: PUB })).toBe(false);
  });

  it('🔒 body 被 JSON.parse→stringify 往返过 → 拒绝（框架篡改 body 会静默炸掉验签）', () => {
    const spaced = '{"id": "EV-1", "event_type": "TRANSACTION.SUCCESS"}'; // 带空格的原始报文
    const sig = signNotify(ts, nonce, spaced);
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body: spaced, signature: sig, publicKeyPem: PUB })).toBe(true);
    const roundTripped = JSON.stringify(JSON.parse(spaced)); // 空格没了
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body: roundTripped, signature: sig, publicKeyPem: PUB })).toBe(
      false,
    );
  });

  it('🔒 缺头（空 timestamp/nonce/signature/公钥）→ 拒绝，不抛', () => {
    const sig = signNotify(ts, nonce, body);
    expect(verifySignature({ timestamp: '', nonceStr: nonce, body, signature: sig, publicKeyPem: PUB })).toBe(false);
    expect(verifySignature({ timestamp: ts, nonceStr: '', body, signature: sig, publicKeyPem: PUB })).toBe(false);
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: '', publicKeyPem: PUB })).toBe(false);
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: sig, publicKeyPem: '' })).toBe(false);
  });

  it('🔒 公钥是垃圾字符串 → 拒绝而不是抛（抛有可能被上层 catch 成「跳过验签」）', () => {
    const sig = signNotify(ts, nonce, body);
    expect(verifySignature({ timestamp: ts, nonceStr: nonce, body, signature: sig, publicKeyPem: 'not-a-pem' })).toBe(false);
  });
});

// ── resource 解密 ──
const APIV3_KEY = 'a'.repeat(32);

function encryptResource(plain: string, opts: { key?: string; nonce?: string; aad?: string } = {}) {
  const nonce = opts.nonce ?? '0123456789abcdef';
  const aad = opts.aad ?? 'transaction';
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(opts.key ?? APIV3_KEY, 'utf8'), Buffer.from(nonce, 'utf8'));
  c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return {
    ciphertext: Buffer.concat([enc, c.getAuthTag()]).toString('base64'), // authTag 拼在尾部
    nonce,
    associated_data: aad,
  };
}

describe('pay/sign · resource 解密（AEAD_AES_256_GCM）', () => {
  it('往返：加密→解密拿回原对象', () => {
    const tx = { out_trade_no: 'bcn_X', transaction_id: '42', trade_state: 'SUCCESS', amount: { total: 12900 } };
    expect(decryptResource(APIV3_KEY, encryptResource(JSON.stringify(tx)))).toEqual(tx);
  });

  it('🔒 篡改密文 → 抛（**这条就是 wechatpay-node-v3 静默失效的地方**：它不调 final()）', () => {
    const r = encryptResource(JSON.stringify({ out_trade_no: 'bcn_X', amount: { total: 1 } }));
    const buf = Buffer.from(r.ciphertext, 'base64');
    buf[0] ^= 0xff; // 翻转首字节
    expect(() => decryptResource(APIV3_KEY, { ...r, ciphertext: buf.toString('base64') })).toThrow();
  });

  it('🔒 篡改 authTag（尾部 16 字节）→ 抛', () => {
    const r = encryptResource(JSON.stringify({ a: 1 }));
    const buf = Buffer.from(r.ciphertext, 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptResource(APIV3_KEY, { ...r, ciphertext: buf.toString('base64') })).toThrow();
  });

  it('🔒 associated_data 不对 → 抛（同样只有 final() 拦得住）', () => {
    const r = encryptResource(JSON.stringify({ a: 1 }), { aad: 'transaction' });
    expect(() => decryptResource(APIV3_KEY, { ...r, associated_data: 'wrong' })).toThrow();
  });

  it('🔒 用错的 APIv3 密钥 → 抛', () => {
    const r = encryptResource(JSON.stringify({ a: 1 }));
    expect(() => decryptResource('b'.repeat(32), r)).toThrow();
  });

  it('nonce 12 字节与 16 字节都能收发（文档说 16，实测 Node 两种都行 → 透传不硬编码长度）', () => {
    for (const n of ['0123456789ab', '0123456789abcdef']) {
      const r = encryptResource('{"n":1}', { nonce: n });
      expect(decryptResource(APIV3_KEY, r)).toEqual({ n: 1 });
    }
  });

  it('associated_data 为空串也能解（平台证书接口固定 "certificate"，交易回调可能为空）', () => {
    const r = encryptResource('{"n":1}', { aad: '' });
    expect(decryptResource(APIV3_KEY, { ciphertext: r.ciphertext, nonce: r.nonce })).toEqual({ n: 1 });
    expect(decryptResource(APIV3_KEY, { ...r, associated_data: '' })).toEqual({ n: 1 });
  });

  it('APIv3 密钥不是 32 字节 → 明确报错（而不是 Node 的天书异常）', () => {
    expect(() => decryptResource('short', encryptResource('{}'))).toThrow(/32 字节/);
  });

  it('密文短于 authTag → 明确报错', () => {
    expect(() => decryptResource(APIV3_KEY, { ciphertext: Buffer.alloc(8).toString('base64'), nonce: '0123456789ab' })).toThrow(
      /密文长度不足/,
    );
  });
});

describe('pay/sign · 字符集与商户订单号', () => {
  it('剥掉 emoji（4 字节 UTF-8）—— APIv3 只收 1-3 字节编码，带 emoji 的 description 会被拒', () => {
    expect(stripAstralChars('烽火台 个人版 🎉🔥')).toBe('烽火台 个人版 ');
    expect(stripAstralChars('纯中文和 ASCII 不动 abc')).toBe('纯中文和 ASCII 不动 abc');
  });

  it('中日韩汉字是 3 字节，必须保留', () => {
    expect(stripAstralChars('烽火台')).toBe('烽火台');
    expect(Buffer.from('烽', 'utf8').length).toBe(3);
  });

  it('剥完的字符串每个字符的 UTF-8 编码都 ≤ 3 字节', () => {
    const s = stripAstralChars('a烽🎉b𝕏c😀');
    for (const ch of s) expect(Buffer.from(ch, 'utf8').length).toBeLessThanOrEqual(3);
  });

  it('订单号校验：6-32 位 [0-9A-Za-z_|*-]', () => {
    expect(isValidOutTradeNo('bcn_ABC123')).toBe(true);
    expect(isValidOutTradeNo('a|b*c-d_e')).toBe(true);
    expect(isValidOutTradeNo('short')).toBe(false); // 5 位
    expect(isValidOutTradeNo('x'.repeat(33))).toBe(false); // 33 位
    expect(isValidOutTradeNo('订单号中文')).toBe(false);
    expect(isValidOutTradeNo('has space')).toBe(false);
    expect(isValidOutTradeNo('has.dot')).toBe(false);
  });

  it('生成的订单号合法且不重复', () => {
    const set = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const no = newOutTradeNo();
      expect(isValidOutTradeNo(no)).toBe(true);
      expect(no.length).toBeLessThanOrEqual(32);
      set.add(no);
    }
    expect(set.size).toBe(500);
  });

  it('订单号含时间戳前缀 → 大致有序（排障时肉眼可读出下单时间）', () => {
    const a = newOutTradeNo(1_700_000_000_000);
    const b = newOutTradeNo(1_800_000_000_000);
    expect(a.slice(4, 13) < b.slice(4, 13)).toBe(true);
  });

  it('nonce 是 32 位大写 hex；timestamp 是 10 位秒级（不是毫秒！）', () => {
    expect(newNonceStr()).toMatch(/^[0-9A-F]{32}$/);
    expect(nowTimestamp()).toMatch(/^\d{10}$/);
    expect(Number(nowTimestamp()) * 1000).toBeCloseTo(Date.now(), -5);
  });
});
