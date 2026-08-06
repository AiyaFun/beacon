import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// BYOK 主密钥加解密 + 生产态 fail-fast。
//
// 为什么每个用例都 resetModules + 动态 import：
// lib/crypto.ts 有模块级 cachedKey，一旦某个用例把 key 算出来缓存了，
// 后面的用例改 env 也不会生效——静态 import 只能测到第一次的结果。
async function freshCrypto() {
  vi.resetModules();
  return import('@/lib/crypto');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  // 默认静音 dev 态那条主密钥告警，避免刷屏；断言它的用例自己接管
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('crypto · 加解密往返', () => {
  it('encryptKey → decryptKey 还原原文', async () => {
    const { encryptKey, decryptKey } = await freshCrypto();
    const plain = 'sk-proj-abcdef1234567890';
    expect(decryptKey(encryptKey(plain))).toBe(plain);
  });

  it('密文格式为 iv.tag.data 三段 base64', async () => {
    const { encryptKey } = await freshCrypto();
    expect(encryptKey('hello').split('.')).toHaveLength(3);
  });

  it('同一明文两次加密结果不同（随机 IV），但都能解回来', async () => {
    const { encryptKey, decryptKey } = await freshCrypto();
    const a = encryptKey('same-key');
    const b = encryptKey('same-key');
    expect(a).not.toBe(b); // IV 复用会让 GCM 完全失去安全性，这条必须成立
    expect(decryptKey(a)).toBe('same-key');
    expect(decryptKey(b)).toBe('same-key');
  });

  it('中文与长文本往返无损', async () => {
    const { encryptKey, decryptKey } = await freshCrypto();
    const plain = '密钥·烽火台'.repeat(200);
    expect(decryptKey(encryptKey(plain))).toBe(plain);
  });

  it('空字符串往返', async () => {
    const { encryptKey, decryptKey } = await freshCrypto();
    expect(decryptKey(encryptKey(''))).toBe('');
  });
});

describe('crypto · GCM 完整性校验（篡改必须失败）', () => {
  it('篡改密文正文 → 返回空串，不返回垃圾明文', async () => {
    const { encryptKey, decryptKey } = await freshCrypto();
    const [iv, tag, data] = encryptKey('sk-secret-value').split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    expect(decryptKey(`${iv}.${tag}.${flipped.toString('base64')}`)).toBe('');
  });

  it('篡改 auth tag → 返回空串', async () => {
    const { encryptKey, decryptKey } = await freshCrypto();
    const [iv, tag, data] = encryptKey('sk-secret-value').split('.');
    const flipped = Buffer.from(tag, 'base64');
    flipped[0] ^= 0xff;
    expect(decryptKey(`${iv}.${flipped.toString('base64')}.${data}`)).toBe('');
  });

  it('篡改 IV → 返回空串', async () => {
    const { encryptKey, decryptKey } = await freshCrypto();
    const [iv, tag, data] = encryptKey('sk-secret-value').split('.');
    const flipped = Buffer.from(iv, 'base64');
    flipped[0] ^= 0xff;
    expect(decryptKey(`${flipped.toString('base64')}.${tag}.${data}`)).toBe('');
  });

  it('结构不合法的密文（缺段/空串/乱码）一律返回空串而非抛异常', async () => {
    const { decryptKey } = await freshCrypto();
    for (const bad of ['', 'garbage', 'a.b', 'a.b.c', '...']) expect(decryptKey(bad)).toBe('');
  });

  it('换了主密钥后旧密文解不开（证明密文与 BEACON_MASTER_KEY 绑定）', async () => {
    vi.stubEnv('BEACON_MASTER_KEY', 'k1-'.repeat(20));
    const c1 = await freshCrypto();
    const enc = c1.encryptKey('sk-abc');

    vi.stubEnv('BEACON_MASTER_KEY', 'k2-'.repeat(20));
    const c2 = await freshCrypto();
    // 这正是「密钥用错落库后密文无法迁移」在代码层的表现
    expect(c2.decryptKey(enc)).toBe('');
  });
});

describe('crypto · maskKey 脱敏', () => {
  it('长 key 保留首 4 尾 4', async () => {
    const { maskKey } = await freshCrypto();
    expect(maskKey('sk-abcdefghijklmnwxyz')).toBe('sk-a····wxyz');
  });

  it('短 key（≤8）全打码，不泄漏任何字符', async () => {
    const { maskKey } = await freshCrypto();
    expect(maskKey('12345678')).toBe('****');
    expect(maskKey('ab')).toBe('****');
  });

  it('空串返回空串', async () => {
    const { maskKey } = await freshCrypto();
    expect(maskKey('')).toBe('');
  });

  it('掩码结果不含原 key 的中段', async () => {
    const { maskKey } = await freshCrypto();
    const secret = 'sk-proj-SUPERSECRETMIDDLE-xyz9';
    expect(maskKey(secret)).not.toContain('SUPERSECRETMIDDLE');
  });
});

// ── 生产态 fail-fast ──
// 这一组是本文件的重点：这些分支只在生产触发，本地开发永远跑不到，
// 靠人肉 review 保不住。CI 里跑一遍，等于每次改动都替生产按了一次快门。
describe('crypto · 生产态 fail-fast', () => {
  const PROD_CASES: Array<[string, string | undefined]> = [
    ['缺 BEACON_MASTER_KEY', undefined],
    ['空字符串', ''],
    ['只有空白字符', '   '],
    ['仍是 dev 默认密钥', 'beacon-dev-master-key-change-in-prod-please'],
    ['模板占位值 CHANGE_ME（长度 33 已过长度检查，只有占位符正则拦得住）', 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET'],
    ['占位值 YOUR_SECRET', 'YOUR_SECRET_KEY_HERE_PLEASE_REPLACE_IT'],
    ['占位值 PLACEHOLDER', 'PLACEHOLDER_PLACEHOLDER_PLACEHOLDER_XX'],
    ['占位值 xxxx', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    ['长度不足 32', 'short-key-only-20chr'],
  ];

  for (const [name, key] of PROD_CASES) {
    it(`NODE_ENV=production + ${name} → 加密时 throw`, async () => {
      vi.stubEnv('NODE_ENV', 'production');
      if (key === undefined) vi.stubEnv('BEACON_MASTER_KEY', '');
      else vi.stubEnv('BEACON_MASTER_KEY', key);
      const { encryptKey } = await freshCrypto();
      expect(() => encryptKey('sk-x')).toThrow(/beacon\/crypto/);
    });
  }

  it('BEACON_ENV=prod 与 NODE_ENV=production 等效（两条判定路径都要拦）', async () => {
    vi.stubEnv('BEACON_ENV', 'prod');
    vi.stubEnv('BEACON_MASTER_KEY', '');
    const { encryptKey } = await freshCrypto();
    expect(() => encryptKey('sk-x')).toThrow(/未配置 BEACON_MASTER_KEY/);
  });

  it('错误信息里给出了可照做的生成命令', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_MASTER_KEY', '');
    const { encryptKey } = await freshCrypto();
    expect(() => encryptKey('sk-x')).toThrow(/openssl rand -base64 48/);
  });

  it('decryptKey 的配置错误不被 catch 吞掉（必须 throw，不能静默返回空串）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_MASTER_KEY', '');
    const { decryptKey } = await freshCrypto();
    // 回归锁：masterKey() 若被挪进 try 里，这里会变成返回 '' —— 配置错误伪装成「解密失败」，
    // 生产上会静默把用户的 BYOK key 全判成失效，且无人知道真实原因。
    expect(() => decryptKey('a.b.c')).toThrow(/beacon\/crypto/);
  });

  it('assertMasterKey() 生产缺 key 时 throw —— 供启动处预检', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_MASTER_KEY', '');
    const { assertMasterKey } = await freshCrypto();
    expect(() => assertMasterKey()).toThrow(/beacon\/crypto/);
  });

  it('生产态配了合法强密钥 → 放行且可正常往返', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_MASTER_KEY', 'Zm9vYmFyYmF6cXV4' + 'A'.repeat(40)); // 56 字符，非占位符
    const { encryptKey, decryptKey, assertMasterKey } = await freshCrypto();
    expect(() => assertMasterKey()).not.toThrow();
    expect(decryptKey(encryptKey('sk-real'))).toBe('sk-real');
  });

  it('dev 态缺 key → 不 throw，回退默认密钥并打告警（零配置可跑不能被破坏）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BEACON_MASTER_KEY', '');
    const { encryptKey, decryptKey } = await freshCrypto();
    expect(decryptKey(encryptKey('sk-dev'))).toBe('sk-dev');
    expect(warn).toHaveBeenCalled();
  });

  it('dev 态用 CHANGE_ME 占位值不 throw（只有生产拦）', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BEACON_MASTER_KEY', 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET');
    const { encryptKey } = await freshCrypto();
    expect(() => encryptKey('sk-x')).not.toThrow();
  });
});
