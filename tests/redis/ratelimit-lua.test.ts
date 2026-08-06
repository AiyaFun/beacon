import { describe, it, expect, afterAll } from 'vitest';
import {
  hasRedis,
  rawClient,
  closeRaw,
  loadRatelimit,
  loadMany,
  closeAll,
  uniqKey,
  sleep,
  warmUp,
} from './harness';

// lib/ratelimit.ts 里的 SLIDING_WINDOW_LUA，在真 Redis 上真的执行。
// 生产走的就是这段 Lua，在此之前它一次都没跑过。

describe.skipIf(!hasRedis)('SLIDING_WINDOW_LUA · 真 Redis', () => {
  afterAll(closeRaw);

  // 这条排第一：它要是挂了，底下所有绿色都是在测进程内 Map，一文不值。
  it('配了 REDIS_URL 走的确实是 Redis 实现', async () => {
    const m = await loadRatelimit();
    try {
      expect(m.getRateLimitStore().kind).toBe('redis');
      // 而且真连得上（kind 只是个字段，连不上照样是 'redis'）
      const key = uniqKey('rl:alive');
      expect((await m.checkRateLimit(key, { limit: 1, windowMs: 10_000 })).ok).toBe(true);
      expect(await (await rawClient()).zcard(key)).toBe(1); // 计数真的落在 Redis 里
    } finally {
      await closeAll([m]);
    }
  });

  it('Lua 返回值解析：ok/remaining/resetAt 是数字且逐次精确', async () => {
    // 「解析有 bug 会让限流静默全面失效」这个怀疑，之前只被代码推理证伪过。
    // 这里真跑：如果 Redis 回的是字符串而不是整数，`ok === 1` 恒为 false，
    // 第一次调用就会被拦 —— 下面第一条断言立刻变红。
    const m = await loadRatelimit();
    try {
      const key = uniqKey('rl:parse');
      const opts = { limit: 3, windowMs: 60_000 };
      const before = Date.now();

      const r1 = await m.checkRateLimit(key, opts);
      expect(r1.ok).toBe(true);
      expect(r1.remaining).toBe(2);
      expect(Number.isInteger(r1.resetAt)).toBe(true); // 字符串/浮点都会挂在这
      expect(r1.resetAt).toBeGreaterThanOrEqual(before + opts.windowMs - 5);
      expect(r1.resetAt).toBeLessThanOrEqual(Date.now() + opts.windowMs);

      expect((await m.checkRateLimit(key, opts)).remaining).toBe(1);
      expect((await m.checkRateLimit(key, opts)).remaining).toBe(0);

      const blocked = await m.checkRateLimit(key, opts);
      expect(blocked.ok).toBe(false);
      expect(blocked.remaining).toBe(0); // 不出现负数
      expect(Number.isInteger(blocked.resetAt)).toBe(true);
      // 被拦时 resetAt 锚在**最早**那次命中 + window（不是惩罚性地往后推）
      expect(blocked.resetAt).toBe(r1.resetAt);
    } finally {
      await closeAll([m]);
    }
  });

  it('窗口滚过之后恢复放行（真等，不是 fake timer）', async () => {
    const m = await loadRatelimit();
    try {
      const key = uniqKey('rl:window');
      const opts = { limit: 2, windowMs: 1_000 };
      expect((await m.checkRateLimit(key, opts)).ok).toBe(true);
      expect((await m.checkRateLimit(key, opts)).ok).toBe(true);
      expect((await m.checkRateLimit(key, opts)).ok).toBe(false); // 窗口内第 3 次

      await sleep(1_200); // 让窗口整个滚过去

      const after = await m.checkRateLimit(key, opts);
      expect(after.ok).toBe(true);
      expect(after.remaining).toBe(1); // 旧的两次被 ZREMRANGEBYSCORE 清了，额度是满的
    } finally {
      await closeAll([m]);
    }
  });

  it('key 一定带 TTL —— 放行和拦截两条分支都要带（不然就是内存泄漏）', async () => {
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('rl:ttl');
      const opts = { limit: 1, windowMs: 60_000 };

      await m.checkRateLimit(key, opts); // 放行分支
      const t1 = await probe.pttl(key);
      expect(t1).toBeGreaterThan(0); // -1 = 永不过期 = 泄漏
      expect(t1).toBeLessThanOrEqual(opts.windowMs);

      await m.checkRateLimit(key, opts); // 拦截分支
      const t2 = await probe.pttl(key);
      expect(t2).toBeGreaterThan(0);
      expect(t2).toBeLessThanOrEqual(opts.windowMs);
    } finally {
      await closeAll([m]);
    }
  });

  it('resetRateLimit 真的把 key 从 Redis 删掉', async () => {
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('rl:reset');
      await m.checkRateLimit(key, { limit: 1, windowMs: 60_000 });
      expect(await probe.exists(key)).toBe(1);

      await m.resetRateLimit(key);
      expect(await probe.exists(key)).toBe(0);
      expect((await m.checkRateLimit(key, { limit: 1, windowMs: 60_000 })).ok).toBe(true);
    } finally {
      await closeAll([m]);
    }
  });

  it('原子性：64 条连接同时打同一 key，放行数精确等于 limit', async () => {
    // Lua 存在的全部理由。控制组（control-group.test.ts）已证明同样的压力
    // 能把非原子实现打穿，所以这条的「精确」才是有内容的。
    const N = 64;
    const LIMIT = 10;
    const key = uniqKey('rl:atomic');
    const mods = await loadMany(N);
    const probe = await rawClient();
    try {
      await warmUp(mods, key);

      const results = await Promise.all(
        mods.map((m) => m.checkRateLimit(key, { limit: LIMIT, windowMs: 60_000 })),
      );

      expect(results.filter((r) => r.ok).length).toBe(LIMIT);
      expect(results.filter((r) => !r.ok).length).toBe(N - LIMIT);
      expect(await probe.zcard(key)).toBe(LIMIT); // 不多不少，一次都没漏进去

      // 同毫秒并发不会互相覆盖（member 带随机后缀）—— ZCARD 等于 LIMIT 已经证明了这点：
      // 若 member 只用毫秒时间戳，同毫秒的 ZADD 会覆盖，ZCARD 会 < LIMIT。
      const remainings = results.filter((r) => r.ok).map((r) => r.remaining).sort((a, b) => a - b);
      expect(remainings).toEqual(Array.from({ length: LIMIT }, (_, i) => i)); // 0..LIMIT-1 各一次
    } finally {
      await closeAll(mods);
    }
  });

  it('多个 key 互不串（scope 分桶真的有效）', async () => {
    const m = await loadRatelimit();
    try {
      const a = m.ipKey('login', '1.2.3.4');
      const b = m.ipKey('login', '5.6.7.8');
      const c = m.phoneKey('login', '13800138000');
      await m.resetRateLimit(a);
      await m.resetRateLimit(b);
      await m.resetRateLimit(c);

      const opts = { limit: 1, windowMs: 60_000 };
      expect((await m.checkRateLimit(a, opts)).ok).toBe(true);
      expect((await m.checkRateLimit(a, opts)).ok).toBe(false); // a 打满
      expect((await m.checkRateLimit(b, opts)).ok).toBe(true); // b 不受影响
      expect((await m.checkRateLimit(c, opts)).ok).toBe(true); // c 不受影响
    } finally {
      await closeAll([m]);
    }
  });
});
