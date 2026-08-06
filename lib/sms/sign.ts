import crypto from 'node:crypto';

// 火山引擎 OpenAPI 签名 V4（HMAC-SHA256）。抽成纯函数便于单测用官方对拍向量验证。
//
// 与 AWS SigV4 的三处关键差异（照抄 AWS 实现会同时踩中）：
//   1. 算法名是裸的 HMAC-SHA256，不是 AWS4-HMAC-SHA256
//   2. scope 终结符是 request，不是 aws4_request
//   3. 派生密钥直接用 SK 原文起步，没有 "AWS4" 前缀
// 另：派生密钥每一级都是 raw binary digest，不是 hex 字符串
//（官方文档「Hex 类型的密钥」那句是误导，同页说明已自行澄清）。

export interface VolcSignInput {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string; // 短信必须是 volcSMS，大小写敏感
  method: string;
  path: string;
  host: string;
  query: Record<string, string>;
  body: string; // 已序列化好的 body，调用方必须拿同一个字符串去发请求
  date: Date; // 由调用方传入，便于单测传固定时间对拍
  headers?: Record<string, string>; // 额外入签的头，key 必须小写；host / x-date 由本函数注入
  signContentSha256?: boolean; // true 时把 x-content-sha256 也纳入签名（Go SDK 路线）
}

export interface VolcSignResult {
  authorization: string;
  xDate: string;
  bodySha: string;
  signedHeaders: string;
  signature: string;
  canonicalRequest: string; // 暴露出来供单测对拍
  stringToSign: string;
}

// ISO8601 basic：20260717T090000Z（UTC，秒精度，无分隔符）
export function formatVolcDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, content: string): Buffer {
  return crypto.createHmac('sha256', key).update(content, 'utf8').digest();
}

// 四级派生：SK -> date -> region -> service -> request，中间结果全是 raw digest
export function deriveSigningKey(
  secretAccessKey: string,
  shortDate: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(secretAccessKey, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'request');
}

// RFC3986：unreserved = A-Za-z0-9-_.~，其余全转义（空格 -> %20，* -> %2A）
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizePath(path: string): string {
  if (!path) return '/';
  return path.split('/').map(encodeRfc3986).join('/');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k])}`)
    .join('&');
}

export function signVolcRequest(input: VolcSignInput): VolcSignResult {
  const xDate = formatVolcDate(input.date);
  const shortDate = xDate.slice(0, 8); // 必须从 xDate 截取，另取本地日期会在跨 UTC 零点时偶发失败
  const bodySha = sha256Hex(input.body);

  const signMap: Record<string, string> = { ...input.headers, host: input.host, 'x-date': xDate };
  if (input.signContentSha256) signMap['x-content-sha256'] = bodySha;

  const names = Object.keys(signMap).sort();
  const signedHeaders = names.join(';');
  // 每行都以 \n 结尾（包括最后一行），因此下面 join 后会与 signedHeaders 之间产生一个空行——这是头号踩坑点
  const canonicalHeaders = names.map((k) => `${k}:${signMap[k].trim()}\n`).join('');

  const canonicalRequest = [
    input.method,
    normalizePath(input.path),
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    bodySha,
  ].join('\n');

  const credentialScope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = deriveSigningKey(input.secretAccessKey, shortDate, input.region, input.service);
  const signature = hmac(signingKey, stringToSign).toString('hex');

  const authorization =
    `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}` +
    `, SignedHeaders=${signedHeaders}` +
    `, Signature=${signature}`;

  return { authorization, xDate, bodySha, signedHeaders, signature, canonicalRequest, stringToSign };
}
