import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// 手写包装而不是 promisify：scrypt 有带/不带 options 两个重载，promisify 的类型只留一个
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

// ── 本机密码（个人创作者小站）────────────────────────────────────────────────
//
// 【为什么是 scrypt 而不是 bcrypt】Node 内置，零新依赖——密码哈希是最不该
// 引入供应链新面的地方。参数存在哈希串里（`scrypt:N:r:p:salt:hash`），
// 将来调参数只影响新设的密码，旧的照常验证。
//
// 【它只服务 appliance/private】SaaS 上 MATRIX.passwordLogin=false，
// 登录页不渲染表单、server action 也被能力闸拦住（两道都要有，别只拦一道）。

const N = 16384; // 2^14：单人小站的交互式登录，~50ms 量级
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(plain: string): Promise<string> {
  const pwd = plain.normalize('NFKC');
  if (pwd.length < MIN_PASSWORD_LENGTH) throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  const salt = randomBytes(16);
  const derived = await scrypt(pwd, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

/** 校验密码。哈希串格式坏 / 参数异常一律按「不匹配」处理，不抛错（登录路径要统一文案）。 */
export async function verifyPassword(plain: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr); const r = Number(rStr); const p = Number(pStr);
  // 参数上限闸：哈希串来自我们自己的库，但万一被改大成 DoS 参数（N=2^30），
  // 一次登录尝试就能吃光内存——不认非常规参数比“兼容一切”安全
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 4) return false;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(hashB64, 'base64');
    if (salt.length < 8 || expect.length < 32) return false;
    const derived = await scrypt(plain.normalize('NFKC'), salt, expect.length, {
      N: n, r, p,
      // scrypt 内存 ≈ 128·N·r 字节；配合上限闸再给一个显式天花板
      maxmem: 256 * 1024 * 1024,
    });
    return timingSafeEqual(derived, expect);
  } catch {
    return false;
  }
}
