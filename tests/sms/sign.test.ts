import { describe, it, expect } from 'vitest';
import { signVolcRequest, deriveSigningKey, formatVolcDate, sha256Hex } from '@/lib/sms/sign';
import crypto from 'node:crypto';

// 火山引擎 OpenAPI 签名 V4 —— 官方对拍向量（来源：火山文档 6369/67269）。
//
// 这组测试的价值：在拿到真实 AK/SK 之前就能证明签名算法逐字节正确。
// 签名是短信通道里最容易错又最难排查的部分（错了只回一个没有任何提示的 RE:0000）。
//
// ⚠️ 维护须知：期望值是**官方给的**，不是从我们实现里跑出来的。
// 如果哪天它红了，先怀疑实现，不要改这里的期望值——改绿了就等于没测。
//
// ── 关于 query 的一段考证（首次跑这组向量时踩到，留档免得后人重走）──
// 契约文档 §2.4 转述这组向量时**漏掉了请求的 query string**，只说了 POST / + body。
// 照文档字面输入（query 为空）算出的 CR-SHA 对不上官方值，四条端到端断言全红。
// 判定过程（两步，结论是"实现没问题，是文档漏了输入"）：
//   1. 自洽性检验：用【官方给的】CR-SHA 直接算签名 → 得到【官方给的】Signature。
//      说明 SK / CR-SHA / Signature 三者互相印证，向量本身没抄错，问题只在 CanonicalRequest 原文。
//   2. 反解 CanonicalRequest：穷举变体找 hash 命中 27383e3b… 的那个，
//      命中项含 `Action=ListBill&Version=2022-01-01`（billing 的 ListBill 接口，Action/Version 走 query）。
//      SHA256 命中不可能是巧合，故该重建是确定的。
// 补上这段被漏掉的 query 后，SHA256(CanonicalRequest) 与 Signature 双双逐字节命中 → **实现正确**。
// 注意：这里改的是**输入**，不是期望值——期望值一个字符都没动。
const VEC = {
  secretAccessKey: ['WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUx', 'TXpZeU9UVXlOMlE1TmpZeVlqTQ=='].join(''),
  accessKeyId: ['AKLT', 'YWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg'].join(''),
  shortDate: '20250329',
  xDate: '20250329T180937Z',
  region: 'cn-beijing',
  service: 'billing',
  host: 'billing.volcengineapi.com',
  // 文档 §2.4 漏掉的输入，由官方 CR-SHA 反解得出（见上方考证）
  query: { Action: 'ListBill', Version: '2022-01-01' },
  body: '{"Limit":10,"BillPeriod":"2023-08"}',
  bodySha: 'e8cc56e129d9759d56c936e679a345d001a4235b58bee8e935ccad97f23ed663',
  kDate: '069b1da2ba9c0ecbd8e8aaf2a5742696ebc22f3fe95a649983d31b433ba94ff3',
  kRegion: '2f41e8c797f1f0200484c9b0986f89cb371bf44d51e37ca7ad0e12dcbbd83cfd',
  kService: '2d9caf568d4a1bd052daf42378d281e7f3233c7110dd6849988bd17fd5423777',
  kSigning: 'b491ed164936de3bb06c1eb23326aa9587b5aaa6a4e02144b9d523bbebb7ca9f',
  canonicalRequestSha: '27383e3b56d03850f5634483527fbddcbf06cf98de1bc8a6679ef2300bff3b15',
  signature: '5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658',
};

const hmacHex = (key: Buffer | string, content: string) =>
  crypto.createHmac('sha256', key).update(content, 'utf8').digest('hex');
const hmacRaw = (key: Buffer | string, content: string) =>
  crypto.createHmac('sha256', key).update(content, 'utf8').digest();

describe('火山签名 · 四级密钥派生（官方对拍向量）', () => {
  // 逐级对拍：任何一级错了都能立刻定位是哪一级，不用去猜端到端为什么不对。
  // 这里刻意手工重算每一级，而不是调 deriveSigningKey —— 它只返回最后一级。
  it('kDate = HMAC(SK原文, shortDate)：SK 不加 "AWS4" 前缀', () => {
    expect(hmacHex(VEC.secretAccessKey, VEC.shortDate)).toBe(VEC.kDate);
  });

  it('kRegion = HMAC(kDate原始digest, region)：中间结果是 raw binary 不是 hex 字符串', () => {
    const kDate = hmacRaw(VEC.secretAccessKey, VEC.shortDate);
    expect(hmacHex(kDate, VEC.region)).toBe(VEC.kRegion);
  });

  it('kService = HMAC(kRegion, service)', () => {
    const kRegion = hmacRaw(hmacRaw(VEC.secretAccessKey, VEC.shortDate), VEC.region);
    expect(hmacHex(kRegion, VEC.service)).toBe(VEC.kService);
  });

  it('kSigning = HMAC(kService, "request")：终结符是 request 不是 aws4_request', () => {
    const kService = hmacRaw(
      hmacRaw(hmacRaw(VEC.secretAccessKey, VEC.shortDate), VEC.region),
      VEC.service,
    );
    expect(hmacHex(kService, 'request')).toBe(VEC.kSigning);
  });

  it('deriveSigningKey() 一步到位的结果 = 官方 kSigning', () => {
    const key = deriveSigningKey(VEC.secretAccessKey, VEC.shortDate, VEC.region, VEC.service);
    expect(key.toString('hex')).toBe(VEC.kSigning);
  });

  it('派生密钥对 SK 敏感：SK 改一个字符结果必须完全不同', () => {
    const a = deriveSigningKey(VEC.secretAccessKey, VEC.shortDate, VEC.region, VEC.service);
    const b = deriveSigningKey(`${VEC.secretAccessKey}x`, VEC.shortDate, VEC.region, VEC.service);
    expect(a.toString('hex')).not.toBe(b.toString('hex'));
  });
});

describe('火山签名 · 端到端（官方对拍向量）', () => {
  // 向量走的是 host;x-date 路线：不传 headers、不传 signContentSha256 正好命中。
  const sign = () =>
    signVolcRequest({
      accessKeyId: VEC.accessKeyId,
      secretAccessKey: VEC.secretAccessKey,
      region: VEC.region,
      service: VEC.service,
      method: 'POST',
      path: '/',
      host: VEC.host,
      query: VEC.query,
      body: VEC.body,
      date: new Date('2025-03-29T18:09:37Z'),
    });

  it('bodySha = SHA256(body)', () => {
    expect(sha256Hex(VEC.body)).toBe(VEC.bodySha);
    expect(sign().bodySha).toBe(VEC.bodySha);
  });

  it('X-Date 格式为 ISO8601 basic（无分隔符、秒精度）', () => {
    expect(sign().xDate).toBe(VEC.xDate);
    expect(formatVolcDate(new Date('2025-03-29T18:09:37.123Z'))).toBe(VEC.xDate);
  });

  it('SignedHeaders = host;x-date', () => {
    expect(sign().signedHeaders).toBe('host;x-date');
  });

  it('SHA256(CanonicalRequest) 逐字节命中官方值', () => {
    // 这条是整个签名里最容易错的：CanonicalHeaders 每行都以 \n 结尾，
    // 因此与 SignedHeaders 之间会多出一个空行。少一个换行 hash 就全错。
    expect(sha256Hex(sign().canonicalRequest)).toBe(VEC.canonicalRequestSha);
  });

  it('StringToSign 结构正确：HMAC-SHA256 / xDate / scope / hash', () => {
    const r = sign();
    expect(r.stringToSign).toBe(
      ['HMAC-SHA256', VEC.xDate, `${VEC.shortDate}/${VEC.region}/${VEC.service}/request`, VEC.canonicalRequestSha].join('\n'),
    );
  });

  it('Signature 逐字节命中官方值 —— 签名实现正确的最终判据', () => {
    expect(sign().signature).toBe(VEC.signature);
  });

  it('Authorization 头组装正确', () => {
    expect(sign().authorization).toBe(
      `HMAC-SHA256 Credential=${VEC.accessKeyId}/${VEC.shortDate}/${VEC.region}/${VEC.service}/request` +
        `, SignedHeaders=host;x-date, Signature=${VEC.signature}`,
    );
  });
});

describe('火山签名 · 生产路线与不变式', () => {
  const base = {
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    region: 'cn-north-1',
    service: 'volcSMS',
    method: 'POST',
    path: '/',
    host: 'sms.volcengineapi.com',
    query: { Action: 'SendSms', Version: '2020-01-01' },
    body: '{"a":1}',
    date: new Date('2026-07-17T09:00:00Z'),
  };

  it('Go SDK 路线：signContentSha256 + content-type 头 → 四头入签且 ASCII 排序', () => {
    const r = signVolcRequest({ ...base, headers: { 'content-type': 'application/json' }, signContentSha256: true });
    expect(r.signedHeaders).toBe('content-type;host;x-content-sha256;x-date');
  });

  it('shortDate 从 xDate 截取：跨 UTC 零点时 scope 与 X-Date 同日，不会偶发失败', () => {
    // 本地时区若在东八区，这个时刻的「本地日期」是 7-18，但 UTC 日期是 7-17。
    // 实现若另取本地日期，credential scope 会与 X-Date 差一天 → 线上凌晨随机挂。
    const r = signVolcRequest({ ...base, date: new Date('2026-07-17T23:30:00Z') });
    expect(r.xDate).toBe('20260717T233000Z');
    expect(r.authorization).toContain('/20260717/cn-north-1/volcSMS/request');
  });

  it('query 按 key 排序进 CanonicalRequest', () => {
    const r = signVolcRequest({ ...base, query: { Version: '2020-01-01', Action: 'SendSms' } });
    expect(r.canonicalRequest.split('\n')[2]).toBe('Action=SendSms&Version=2020-01-01');
  });

  it('CanonicalRequest 里 SignedHeaders 前有且仅有一个空行', () => {
    const lines = signVolcRequest(base).canonicalRequest.split('\n');
    // POST / query host行 xdate行 '' signedHeaders bodySha
    expect(lines[lines.length - 3]).toBe('');
    expect(lines[lines.length - 2]).toBe('host;x-date');
  });

  it('body 变化 → 签名变化（body 与签名绑定，防串改）', () => {
    const a = signVolcRequest(base);
    const b = signVolcRequest({ ...base, body: '{"a":2}' });
    expect(a.signature).not.toBe(b.signature);
  });

  it('service 大小写敏感：volcSMS ≠ volcsms', () => {
    const a = signVolcRequest(base);
    const b = signVolcRequest({ ...base, service: 'volcsms' });
    expect(a.signature).not.toBe(b.signature);
  });
});
