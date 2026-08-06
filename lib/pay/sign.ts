import crypto from 'node:crypto';

// 微信支付 APIv3 的签名 / 验签 / 回调解密。**全部是纯函数**。
//
// 为什么纯：时间戳和随机串走参数、不在函数里 Date.now()/randomBytes() ——
// 这样官方文档给的签名向量能当 oracle 逐字节对拍，在拿到真实商户凭证前
// 就能证明实现是对的（火山短信那轮验证过这个打法）。
// 副作用（取时钟、掷随机数）集中在 newNonceStr()/nowTimestamp()，调用方注入。
//
// 对拍状态（tests/pay/sign.test.ts）：
//   官方向量 1（POST + body，文档 4012365336）✅ 逐字节复现
//   官方向量 2（GET + path 参数 + 空 body，文档 4012365334）✅ 逐字节复现
//   官方向量 3（GET + query，文档 4012365865）—— **官方文档的期望值是错的**，
//   用文档自己的 openssl 命令跑也得不到它。不作为验收标准，别被带沟里。

// ── 请求签名 ────────────────────────────────────────────────

/**
 * 请求签名待签串（5 行，**每行都以 \n 结尾，包括最后一行**）。
 * urlPath 必须含 query，且与实际发出的请求逐字节一致（签什么发什么，不排序）。
 * body 为空串时最后一行就只剩一个 \n —— 这正是官方要的。
 */
export function buildSignMessage(
  method: string,
  urlPath: string,
  timestamp: string,
  nonceStr: string,
  body = '',
): string {
  return `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`;
}

/** 用商户 API 私钥（apiclient_key.pem 全文，PKCS#8 或 PKCS#1 都行，Node 都吃）签名 → base64。 */
export function signMessage(message: string, privateKeyPem: string): string {
  return crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(privateKeyPem, 'base64');
}

export type AuthParams = {
  mchid: string;
  serialNo: string; // 商户 API 证书序列号（不是平台证书！）
  privateKeyPem: string;
  method: string;
  urlPath: string; // 含 query
  body?: string;
  timestamp: string; // 秒级 10 位
  nonceStr: string;
};

/** 完整 Authorization 头。5 个字段都要双引号，逗号分隔且逗号后无空格。 */
export function buildAuthorization(p: AuthParams): string {
  const message = buildSignMessage(p.method, p.urlPath, p.timestamp, p.nonceStr, p.body ?? '');
  const signature = signMessage(message, p.privateKeyPem);
  return (
    'WECHATPAY2-SHA256-RSA2048 ' +
    `mchid="${p.mchid}",` +
    `nonce_str="${p.nonceStr}",` +
    `signature="${signature}",` +
    `timestamp="${p.timestamp}",` +
    `serial_no="${p.serialNo}"`
  );
}

// ── 应答 / 回调验签 ─────────────────────────────────────────

/**
 * 验签待签串是 **3 行**（不是请求签名的 5 行）：时间戳 / 随机串 / 报文主体。
 * 回调与应答共用这一套构造。
 */
export function buildVerifyMessage(timestamp: string, nonceStr: string, body: string): string {
  return `${timestamp}\n${nonceStr}\n${body}\n`;
}

/**
 * 用微信支付公钥验签。
 *
 * ⚠️ body 必须是**原始报文字节**。任何往返（JSON.parse → JSON.stringify）都会
 * 重排空白导致验签失败 —— 这不是 bug，是设计。
 *
 * 微信会故意发**错误签名的探测流量**（签名以 WECHATPAY/SIGNTEST/ 开头）来检查
 * 商户是否真的验了签。这里不做任何特殊处理：验不过就是 false，调用方照常拒绝，
 * 微信随后会带正确签名重发。特殊处理探测流量 = 亲手把验签关掉。
 *
 * 任何异常（非法 base64、公钥格式错、签名长度不对）一律按**验签失败**处理，
 * 绝不 throw 到调用方 —— throw 有可能被上层 catch 成「跳过验签」。
 */
export function verifySignature(p: {
  timestamp: string;
  nonceStr: string;
  body: string;
  signature: string;
  publicKeyPem: string;
}): boolean {
  if (!p.timestamp || !p.nonceStr || !p.signature || !p.publicKeyPem) return false;
  try {
    const message = buildVerifyMessage(p.timestamp, p.nonceStr, p.body);
    return crypto
      .createVerify('RSA-SHA256')
      .update(message, 'utf8')
      .verify(p.publicKeyPem, Buffer.from(p.signature, 'base64'));
  } catch {
    return false;
  }
}

// ── 回调 resource 解密（AEAD_AES_256_GCM）───────────────────

export type EncryptedResource = {
  ciphertext: string; // base64，**解码后末 16 字节是 authTag**
  nonce: string; // 原样 utf8 取字节（文档说 16 字节，别硬编码长度，透传即可）
  associated_data?: string; // 可能为空串
};

/**
 * 解密回调 resource。key = APIv3 密钥（商户平台设的那 32 个字符，utf8 取字节）。
 *
 * ⚠️⚠️ **必须调 final()**。最流行的那个 Node 库（wechatpay-node-v3 的 decipher_gcm）
 * 只调 update() 不调 final() —— 实测篡改密文后它会**静默返回被污染的明文**，
 * authTag 根本没验，GCM 的完整性保护形同虚设。抄它等于把校验关掉。
 * 解密失败一律 throw，由调用方判定为「非法报文」。
 */
export function decryptResource(apiV3Key: string, r: EncryptedResource): unknown {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) {
    throw new Error(`APIv3 密钥必须是 32 字节，当前 ${key.length} 字节`);
  }
  const buf = Buffer.from(r.ciphertext, 'base64');
  if (buf.length <= 16) throw new Error('密文长度不足（不含完整 authTag）');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);

  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.nonce, 'utf8'));
  d.setAuthTag(authTag);
  d.setAAD(Buffer.from(r.associated_data ?? '', 'utf8'));
  const plain = Buffer.concat([d.update(data), d.final()]); // final() 才验 authTag
  return JSON.parse(plain.toString('utf8'));
}

// ── 副作用集中区（调用方注入到上面的纯函数）────────────────

/** 秒级时间戳（10 位）。微信要秒不要毫秒。 */
export function nowTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/** 32 位大写 hex 随机串（跟官方示例一致）。 */
export function newNonceStr(): string {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// ── 字符集 / 单号 ───────────────────────────────────────────

/**
 * 剥掉 4 字节 UTF-8 字符（emoji 等辅助平面字符）。
 * APIv3 只支持 1-3 字节编码的 UTF-8 子集，description/attach 带 emoji 会被拒。
 */
export function stripAstralChars(s: string): string {
  // \u{10000}-\u{10FFFF} 即 UTF-16 代理对，也就是 UTF-8 的 4 字节区
  return s.replace(/[\u{10000}-\u{10FFFF}]/gu, '');
}

const OUT_TRADE_NO_RE = /^[0-9A-Za-z_|*-]{6,32}$/;

/** 微信硬约束：6-32 位，只能是数字/大小写字母/_/-/|/*，同商户号下唯一。 */
export function isValidOutTradeNo(s: string): boolean {
  return OUT_TRADE_NO_RE.test(s);
}

/**
 * 生成商户订单号：bcn_ + 时间戳(36进制) + 随机。纯 [0-9A-Za-z_]，长度稳定在 24。
 * 时间戳前缀让订单号大致有序（排障时肉眼可读出下单时间），随机段防碰撞。
 */
export function newOutTradeNo(now = Date.now(), rand = crypto.randomBytes(6)): string {
  const ts = now.toString(36).toUpperCase().padStart(9, '0');
  const r = Buffer.from(rand).toString('hex').toUpperCase().slice(0, 11);
  const no = `bcn_${ts}${r}`;
  if (!isValidOutTradeNo(no)) throw new Error(`生成的商户订单号不合法：${no}`);
  return no;
}

/**
 * 生成商户退款单号：bcr_ 前缀（bcn=下单 / bcr=退款，肉眼可分）。字符集/长度约束与订单号完全相同
 * （微信对 out_refund_no 的规则同 out_trade_no：6-32 位 [0-9A-Za-z_|*-]，同商户号下唯一）。
 * ⚠️ 退款重试必须复用同一个 out_refund_no —— 微信按它保证退款幂等，换号会退两次钱。
 */
export function newOutRefundNo(now = Date.now(), rand = crypto.randomBytes(6)): string {
  const ts = now.toString(36).toUpperCase().padStart(9, '0');
  const r = Buffer.from(rand).toString('hex').toUpperCase().slice(0, 11);
  const no = `bcr_${ts}${r}`;
  if (!isValidOutTradeNo(no)) throw new Error(`生成的商户退款单号不合法：${no}`);
  return no;
}

/**
 * 由订单 id **确定性**派生退款单号（v1：一个订单一笔全额退款）。
 * 确定性的意义：两个并发的 createRefund 会算出同一个 out_refund_no → 第二个 create 撞
 * outRefundNo 唯一索引（P2002）→ DB 层强制「一单一活跃退款」，不靠 check-then-act 也不靠微信兜底。
 * 且重试复用同号，天然满足微信按 out_refund_no 的退款幂等。
 * orderId 是 cuid（[a-z0-9]），全在合法字符集内；截断到 32 位上限。
 */
export function outRefundNoForOrder(orderId: string): string {
  const no = `bcr_${orderId}`.slice(0, 32);
  if (!isValidOutTradeNo(no)) throw new Error(`由订单派生的退款单号不合法：${no}`);
  return no;
}
