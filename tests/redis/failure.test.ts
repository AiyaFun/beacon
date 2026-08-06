import { describe, it, expect, afterAll } from 'vitest';
import {
  hasRedis,
  urlHasPassword,
  REDIS_URL,
  loadRatelimit,
  closeAll,
  hardDisconnect,
  uniqKey,
  freePort,
  closeRaw,
  rawClient,
} from './harness';

// Redis 挂掉时的行为。进程内实现永远不会挂，所以这几条路径在
// tests/ratelimit.test.ts 里是测不到的 —— 只有真连一次真连不上才算数。

describe.skipIf(!hasRedis)('Redis 故障 · fail-close 与鉴权', () => {
  afterAll(closeRaw);

  it('Redis 连不上时限流 fail-close（默认拒绝）', async () => {
    // 「对花钱的闸门 fail-close」这条决策，此前只存在于注释里。
    const port = await freePort(); // 确定没人监听 → ECONNREFUSED
    const m = await loadRatelimit(`redis://127.0.0.1:${port}`);
    try {
      expect(m.getRateLimitStore().kind).toBe('redis');
      const before = Date.now();
      const r = await m.checkRateLimit(uniqKey('fail:closed'), { limit: 100, windowMs: 3_600_000 });

      expect(r.ok).toBe(false); // 存储没了 → 不放行
      expect(r.remaining).toBe(0);
      // 拒绝时给短退避，不能让用户看到「请 1 小时后再试」（windowMs 是 1 小时）
      expect(r.resetAt).toBeLessThanOrEqual(before + 30_000 + 1_000);
    } finally {
      hardDisconnect(m.getRateLimitStore());
      await closeAll([m]);
      process.env.REDIS_URL = REDIS_URL; // 还原，别污染同文件后续用例
    }
  });

  it('显式 failMode:"open" 时 Redis 挂了仍放行', async () => {
    const port = await freePort();
    const m = await loadRatelimit(`redis://127.0.0.1:${port}`);
    try {
      const r = await m.checkRateLimit(uniqKey('fail:open'), {
        limit: 100,
        windowMs: 60_000,
        failMode: 'open',
      });
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(100);
    } finally {
      hardDisconnect(m.getRateLimitStore());
      await closeAll([m]);
      process.env.REDIS_URL = REDIS_URL;
    }
  });

  it('Redis 挂了时 reserveQuota 会抛出（quota.ts 的降级分支正是靠这个触发）', async () => {
    // reserveQuota 故意**不吞**异常：lib/quota.ts 在 catch 里降级回账本直读。
    // 若哪天有人给 reserveQuota 加个 try/catch 返回 {ok:true}，
    // Redis 一抖动配额就彻底失效且无声无息 —— 这条挡的是那个。
    const port = await freePort();
    const m = await loadRatelimit(`redis://127.0.0.1:${port}`);
    try {
      await expect(m.reserveQuota(uniqKey('fail:reserve'), 0, 10, 60_000)).rejects.toThrow();
    } finally {
      hardDisconnect(m.getRateLimitStore());
      await closeAll([m]);
      process.env.REDIS_URL = REDIS_URL;
    }
  });

  it('releaseQuota 吞掉异常（归还失败只让本周期保守一点，不该炸调用方）', async () => {
    const port = await freePort();
    const m = await loadRatelimit(`redis://127.0.0.1:${port}`);
    try {
      await expect(m.releaseQuota(uniqKey('fail:release'))).resolves.toBeUndefined();
    } finally {
      hardDisconnect(m.getRateLimitStore());
      await closeAll([m]);
      process.env.REDIS_URL = REDIS_URL;
    }
  });

  // 只在 REDIS_URL 真带密码时才有意义（CI 带，本地裸跑可能不带）
  it.skipIf(!urlHasPassword())('不带密码的连接会被 Redis 拒（NOAUTH）', async () => {
    // 反过来说：上面那些用例能连上、能跑 Lua，就证明了
    // 「URL 里的密码被 ioredis 正确解析并 AUTH 了」——
    // 生产（docker-compose.yml）的 Redis 就是 --requirepass 起的。
    const u = new URL(REDIS_URL);
    const IORedis = (await import('ioredis')).default;
    const naked = new IORedis({
      host: u.hostname,
      port: Number(u.port || 6379),
      // 不给 password
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // 不要无限重连
      lazyConnect: true,
    });
    try {
      await naked.connect().catch(() => {}); // 有的版本在握手阶段就失败
      await expect(naked.get('anything')).rejects.toThrow(/NOAUTH|AUTH|Connection is closed/i);
    } finally {
      naked.disconnect();
    }

    // 对照：带密码的同一个 URL 连得上
    const good = await rawClient();
    expect(await good.ping()).toBe('PONG');
  });
});
