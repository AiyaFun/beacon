import crypto from 'node:crypto';

// BYOK API Key 加密存储（AES-256-GCM）。开发态用固定默认密钥零配置跑；
// 生产态必须由 KMS/Secret 注入 BEACON_MASTER_KEY，缺失或仍是占位值一律拒绝启动。

const DEV_FALLBACK = 'beacon-dev-master-key-change-in-prod-please';
const MIN_LEN = 32; // 低于此长度的主密钥熵不足，拒绝

function isProd(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.BEACON_ENV === 'prod';
}

let cachedKey: Buffer | null = null;

// 懒校验：首次真正用到密钥时才校验并缓存派生 key。
// 为什么不在模块顶层 throw —— app/(app)/settings/page.tsx 与 lib/llm/gateway.ts 都 import 本模块，
// next build 收集页面数据时会加载它们，而构建期 NODE_ENV=production 且没有 env
// （Dockerfile builder 阶段 .env 被 .dockerignore 排除，实测顶层 throw 会把构建打挂）。
// 推迟到调用点后：构建不受影响，生产上第一次加解密就炸 —— 依旧是 fail-fast。
function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.BEACON_MASTER_KEY?.trim();

  if (isProd()) {
    if (!raw) throw new Error(prodError('未配置 BEACON_MASTER_KEY'));
    if (raw === DEV_FALLBACK) throw new Error(prodError('BEACON_MASTER_KEY 仍是开发态默认密钥'));
    if (/CHANGE_?ME|YOUR_|PLACEHOLDER|xxx+/i.test(raw)) {
      throw new Error(prodError('BEACON_MASTER_KEY 仍是模板占位值（.env.production.example 里的 CHANGE_ME）'));
    }
    if (raw.length < MIN_LEN) throw new Error(prodError(`BEACON_MASTER_KEY 长度仅 ${raw.length} 字符，至少需要 ${MIN_LEN}`));
  } else if (!raw) {
    console.warn(
      '\n⚠️  [beacon/crypto] 正在使用开发态默认主密钥加密 BYOK API Key —— 仅限本地开发。\n' +
        '   生产部署前务必注入 BEACON_MASTER_KEY，否则进程会拒绝启动。\n',
    );
  }

  cachedKey = crypto.createHash('sha256').update(raw || DEV_FALLBACK).digest(); // 32 bytes
  return cachedKey;
}

function prodError(reason: string): string {
  return (
    `[beacon/crypto] 生产环境安全阻塞：${reason}。\n` +
    `拒绝用不安全的密钥加密用户的 BYOK API Key（一旦用错密钥落库，密文将无法迁移）。\n` +
    `生成一个强主密钥：\n` +
    `    openssl rand -base64 48\n` +
    `再通过 KMS / K8s Secret / docker-compose env 注入 BEACON_MASTER_KEY（不要写进镜像或提交进仓库）。`
  );
}

// 供进程启动处（如 worker.ts）显式预检，把错误提前到启动而非首个请求
export function assertMasterKey(): void {
  masterKey();
}

// ── 无状态短期令牌签名（HMAC-SHA256，主密钥派生）──
// 用于「邮件里的确认链接」这类**不值得为它建一张表**的一次性凭证：
// 载荷自带过期时间，签名保证不可伪造，服务端零存储。
// 刻意与 encryptKey 共用主密钥派生：换主密钥时所有在途链接一起失效，语义正确。

export function signPayload(payload: string): string {
  return crypto.createHmac('sha256', masterKey()).update(payload).digest('base64url');
}

export function verifyPayload(payload: string, sig: string): boolean {
  const expected = Buffer.from(signPayload(payload));
  const got = Buffer.from(sig || '');
  // 长度不等时 timingSafeEqual 会抛，先挡掉；长度本身不是秘密。
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(expected, got);
}

export function encryptKey(plain: string): string {
  const key = masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptKey(enc: string): string {
  const key = masterKey(); // 必须在 try 外：主密钥配置错误要抛出，不能被下面的 catch 吞成空串
  try {
    const [ivB, tagB, dataB] = enc.split('.');
    if (!ivB || !tagB || !dataB) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// 脱敏展示：sk-abcd...wxyz
export function maskKey(plain: string): string {
  if (!plain) return '';
  if (plain.length <= 8) return '****';
  return `${plain.slice(0, 4)}····${plain.slice(-4)}`;
}
