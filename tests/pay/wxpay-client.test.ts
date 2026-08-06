import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { WxPayNativeProvider } from '@/lib/pay/wxpay';
import { WxPayError } from '@/lib/pay/types';
import { buildSignMessage } from '@/lib/pay/sign';
import { OFFICIAL_TEST_KEY, OFFICIAL_TEST_MCHID, OFFICIAL_TEST_SERIAL } from './official-key';

// 用一个假的 fetch 接住请求，验证**发出去的字节**是否符合 APIv3 契约。
// 重点不是「函数返回了什么」，而是「线上真发出去的是什么」—— 签名对不上时微信只回一句
// 401 SIGN_ERROR，什么都不告诉你，所以这些必须在本地焊死。

type Captured = { url: string; method: string; headers: Record<string, string>; body: string };

function providerWith(respond: (c: Captured) => Response) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k.toLowerCase()] = v));
    const c: Captured = { url: String(url), method: init?.method ?? 'GET', headers: h, body: (init?.body as string) ?? '' };
    captured.push(c);
    return respond(c);
  }) as unknown as typeof fetch;

  const p = new WxPayNativeProvider({
    appid: 'wxd678efh567hg6787',
    mchid: OFFICIAL_TEST_MCHID,
    serialNo: OFFICIAL_TEST_SERIAL,
    privateKeyPem: OFFICIAL_TEST_KEY,
    notifyUrl: 'https://beacon.example.com/api/pay/notify',
    fetchImpl,
  });
  return { p, captured };
}

const ok = (body: unknown, requestId = 'req-abc') =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Request-ID': requestId, 'Content-Type': 'application/json' } });

const err = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message }), { status, headers: { 'Request-ID': 'req-err' } });

function parseAuth(h: string) {
  const m = Object.fromEntries([...h.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  return m as { mchid: string; nonce_str: string; signature: string; timestamp: string; serial_no: string };
}

describe('pay/wxpay · Native 下单请求的线上字节', () => {
  it('打到正确的主域名与路径', async () => {
    const { p, captured } = providerWith(() => ok({ code_url: 'weixin://wxpay/bizpayurl/up?pr=X' }));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 59_900, description: '烽火台 团队版 月付' });
    expect(captured[0].url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/native');
    expect(captured[0].method).toBe('POST');
  });

  it('必填头齐全：Authorization / Accept / Content-Type / User-Agent', async () => {
    const { p, captured } = providerWith(() => ok({ code_url: 'weixin://x' }));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' });
    const h = captured[0].headers;
    expect(h.authorization).toMatch(/^WECHATPAY2-SHA256-RSA2048 /);
    // Node fetch 默认 Accept: */*，微信要 application/json
    expect(h.accept).toBe('application/json');
    expect(h['content-type']).toBe('application/json');
    // 官方明确「很可能会拒绝处理无 User-Agent 的请求」
    expect(h['user-agent']).toBe('beacon/1.0');
  });

  it('🔒 签名用的 body 与实际发出的 body **逐字节相同**（二次序列化 = 线上 401 SIGN_ERROR）', async () => {
    const { p, captured } = providerWith(() => ok({ code_url: 'weixin://x' }));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 59_900, description: '烽火台 团队版 月付' });
    const c = captured[0];
    const a = parseAuth(c.headers.authorization);
    // 拿发出去的 body 原文 + 头里的 timestamp/nonce 重算签名，必须等于头里的 signature
    const expected = crypto
      .createSign('RSA-SHA256')
      .update(buildSignMessage('POST', '/v3/pay/transactions/native', a.timestamp, a.nonce_str, c.body), 'utf8')
      .sign(OFFICIAL_TEST_KEY, 'base64');
    expect(a.signature).toBe(expected);
  });

  it('Authorization 里的 mchid / serial_no 来自配置，timestamp 是 10 位秒级', async () => {
    const { p, captured } = providerWith(() => ok({ code_url: 'weixin://x' }));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' });
    const a = parseAuth(captured[0].headers.authorization);
    expect(a.mchid).toBe(OFFICIAL_TEST_MCHID);
    expect(a.serial_no).toBe(OFFICIAL_TEST_SERIAL);
    expect(a.timestamp).toMatch(/^\d{10}$/);
    expect(a.nonce_str).toMatch(/^[0-9A-F]{32}$/);
  });

  it('请求体字段符合契约：amount.total 是整数分、currency=CNY、notify_url 来自配置', async () => {
    const { p, captured } = providerWith(() => ok({ code_url: 'weixin://x' }));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 59_900, description: '烽火台 团队版 月付' });
    const b = JSON.parse(captured[0].body);
    expect(b.appid).toBe('wxd678efh567hg6787');
    expect(b.mchid).toBe(OFFICIAL_TEST_MCHID);
    expect(b.out_trade_no).toBe('bcn_TEST01');
    expect(b.amount).toEqual({ total: 59_900, currency: 'CNY' });
    expect(b.notify_url).toBe('https://beacon.example.com/api/pay/notify');
    expect(Number.isInteger(b.amount.total)).toBe(true);
  });

  it('🔒 description 里的 emoji 被剥掉（APIv3 只收 1-3 字节 UTF-8，带 emoji 会被拒）', async () => {
    const { p, captured } = providerWith(() => ok({ code_url: 'weixin://x' }));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: '烽火台 团队版 🎉🔥' });
    const b = JSON.parse(captured[0].body);
    expect(b.description).toBe('烽火台 团队版 ');
    for (const ch of b.description as string) expect(Buffer.from(ch, 'utf8').length).toBeLessThanOrEqual(3);
  });

  it('time_expire 传了才带（RFC3339 带时区偏移）', async () => {
    const { p, captured } = providerWith(() => ok({ code_url: 'weixin://x' }));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' });
    expect(JSON.parse(captured[0].body).time_expire).toBeUndefined();
    await p.createNative({ outTradeNo: 'bcn_TEST02', amountFen: 100, description: 'x', timeExpireISO: '2026-07-17T13:29:35+08:00' });
    expect(JSON.parse(captured[1].body).time_expire).toBe('2026-07-17T13:29:35+08:00');
  });

  it('🔒 金额不是正整数分 → 本地就拒绝，不浪费一次微信调用', async () => {
    const { p } = providerWith(() => ok({ code_url: 'weixin://x' }));
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: bad, description: 'x' })).rejects.toThrow(/正整数分/);
    }
  });

  it('返回 code_url 与 Request-ID（排障必备，微信报障必须提供）', async () => {
    const { p } = providerWith(() => ok({ code_url: 'weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00' }, 'req-xyz'));
    const r = await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' });
    expect(r.codeUrl).toBe('weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00');
    expect(r.requestId).toBe('req-xyz');
  });

  it('200 但没有 code_url → 报错（不返回一个 undefined 让二维码渲染炸在别处）', async () => {
    const { p } = providerWith(() => ok({}));
    await expect(p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' })).rejects.toThrow(/未返回 code_url/);
  });
});

describe('pay/wxpay · 查单', () => {
  it('🔒 mchid 是必填 query，且**参与签名**（URL 行必须与实际请求逐字节一致）', async () => {
    const { p, captured } = providerWith(() => ok({ trade_state: 'SUCCESS', transaction_id: 'TX1', amount: { total: 100 } }));
    await p.queryByOutTradeNo('bcn_TEST01');
    const c = captured[0];
    expect(c.url).toBe(`https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/bcn_TEST01?mchid=${OFFICIAL_TEST_MCHID}`);

    const a = parseAuth(c.headers.authorization);
    const urlPath = `/v3/pay/transactions/out-trade-no/bcn_TEST01?mchid=${OFFICIAL_TEST_MCHID}`;
    const expected = crypto
      .createSign('RSA-SHA256')
      .update(buildSignMessage('GET', urlPath, a.timestamp, a.nonce_str, ''), 'utf8')
      .sign(OFFICIAL_TEST_KEY, 'base64');
    expect(a.signature).toBe(expected); // ★ 带 query 的 URL 行签对了
  });

  it('GET 空 body：不发 Content-Type、不带 body', async () => {
    const { p, captured } = providerWith(() => ok({ trade_state: 'NOTPAY' }));
    await p.queryByOutTradeNo('bcn_TEST01');
    expect(captured[0].body).toBe('');
    expect(captured[0].headers['content-type']).toBeUndefined();
  });

  it('解析各种 trade_state', async () => {
    for (const st of ['SUCCESS', 'REFUND', 'NOTPAY', 'CLOSED'] as const) {
      const { p } = providerWith(() => ok({ trade_state: st, transaction_id: 'TX1', amount: { total: 59_900 } }));
      const r = await p.queryByOutTradeNo('bcn_TEST01');
      expect(r.tradeState).toBe(st);
    }
  });

  it('返回金额与交易号供上层对账', async () => {
    const { p } = providerWith(() => ok({ trade_state: 'SUCCESS', transaction_id: 'TX9', amount: { total: 59_900 }, success_time: '2026-07-17T13:29:35+08:00' }));
    const r = await p.queryByOutTradeNo('bcn_TEST01');
    expect(r.transactionId).toBe('TX9');
    expect(r.amountTotalFen).toBe(59_900);
    expect(r.successTimeISO).toBe('2026-07-17T13:29:35+08:00');
  });
});

describe('pay/wxpay · 错误码与重试判据', () => {
  it('业务错误 → WxPayError，带 code / httpStatus / requestId', async () => {
    const { p } = providerWith(() => err(403, 'NO_AUTH', '商户号该产品权限未开通，请前往商户平台>产品中心检查后重试'));
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' }).catch((e: WxPayError) => {
      expect(e).toBeInstanceOf(WxPayError);
      expect(e.code).toBe('NO_AUTH');
      expect(e.httpStatus).toBe(403);
      expect(e.requestId).toBe('req-err');
      expect(e.retryable).toBe(false);
    });
    expect.assertions(5);
  });

  it('🔒 只有 SYSTEM_ERROR / FREQUENCY_LIMITED 可重试；4xx 全都不可重试', () => {
    const mk = (code: string, status: number) => new WxPayError(code, 'm', status);
    expect(mk('SYSTEM_ERROR', 500).retryable).toBe(true);
    expect(mk('FREQUENCY_LIMITED', 429).retryable).toBe(true);
    // 4xx 全是我们自己的错，重试没有意义
    for (const [c, s] of [
      ['PARAM_ERROR', 400],
      ['INVALID_REQUEST', 400],
      ['SIGN_ERROR', 401],
      ['APPID_MCHID_NOT_MATCH', 400],
      ['MCH_NOT_EXISTS', 400],
      ['ORDER_CLOSED', 400],
      ['NO_AUTH', 403],
      ['OUT_TRADE_NO_USED', 403],
      ['RULE_LIMIT', 403],
      ['ORDER_NOT_EXIST', 404],
    ] as const) {
      expect(mk(c, s).retryable).toBe(false);
    }
  });

  it('APIv3 用的是下划线错误码（不是 APIv2 的 NOAUTH/ORDERPAID/SYSTEMERROR）', () => {
    expect(new WxPayError('OUT_TRADE_NO_USED', 'm', 403).code).toBe('OUT_TRADE_NO_USED');
    // APIv3 没有 ORDERPAID 这个码，对应的是 OUT_TRADE_NO_USED
    expect(new WxPayError('SYSTEM_ERROR', 'm', 500).retryable).toBe(true);
    expect(new WxPayError('SYSTEMERROR', 'm', 500).retryable).toBe(false); // v2 写法不该被当成可重试
  });

  it('非 JSON 错误体（网关 502 之类）也不炸，降级成 HTTP_xxx', async () => {
    const { p } = providerWith(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    await expect(p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' })).rejects.toThrow(WxPayError);
    await p.createNative({ outTradeNo: 'bcn_TEST01', amountFen: 100, description: 'x' }).catch((e: WxPayError) => {
      expect(e.code).toBe('HTTP_502');
    });
  });
});
