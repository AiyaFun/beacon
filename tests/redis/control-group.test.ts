import { describe, it, expect, afterAll } from 'vitest';
import { hasRedis, rawClient, closeRaw, loadMany, closeAll, uniqKey, warmUp } from './harness';

// ── 控制组：先证明这套测试台真的压得出竞态 ──────────────────────────
//
// 下面几个文件都会断言「原子实现恰好放行 limit 次」。可是「恰好 limit 次」
// 在**没有并发**的情况下也成立 —— 串行跑当然不会超发。所以那种绿色
// 什么都不证明，除非先证明：同样的压力打在**故意非原子**的实现上，
// 它真的会超发。
//
// 这个文件就是那个证明。它要是变红（非原子实现居然没超发），说明并发压力
// 不够，那么其余文件的所有绿色都是自我安慰 —— 该去调 N，而不是去庆祝。

const N = 48; // 并发连接数
const LIMIT = 5;

describe.skipIf(!hasRedis)('控制组 · 证明并发压力真实存在', () => {
  afterAll(closeRaw);

  it('非原子 GET+INCR：N 条连接打同一 key → 真的超发', async () => {
    const key = uniqKey('ctrl:counter');
    const clients = await Promise.all(Array.from({ length: N }, () => rawClient()));
    await Promise.all(clients.map((c) => c.ping())); // 预热，让压力真的同时到达

    const results = await Promise.all(
      clients.map(async (c) => {
        const cur = Number((await c.get(key)) ?? 0); // ← check
        if (cur >= LIMIT) return false;
        await c.incr(key); // ← then act。这两步之间的窗口就是病根
        return true;
      }),
    );

    const granted = results.filter(Boolean).length;
    // 这条断言**必须**通过，它是整个 tests/redis/ 的地基。
    expect(granted).toBeGreaterThan(LIMIT);
    // Redis 里的真实值也确实被打穿了（不是我们的计数方式有问题）
    expect(Number(await clients[0].get(key))).toBe(granted);
  });

  it('非原子 ZCARD+ZADD：滑动窗口版的同一个病 → 真的超发', async () => {
    const key = uniqKey('ctrl:zset');
    const windowMs = 60_000;
    const clients = await Promise.all(Array.from({ length: N }, () => rawClient()));
    await Promise.all(clients.map((c) => c.ping()));

    const results = await Promise.all(
      clients.map(async (c, i) => {
        const now = Date.now();
        await c.zremrangebyscore(key, 0, now - windowMs);
        const count = await c.zcard(key); // ← check
        if (count >= LIMIT) return false;
        await c.zadd(key, now, `m-${i}`); // ← then act
        return true;
      }),
    );

    const granted = results.filter(Boolean).length;
    expect(granted).toBeGreaterThan(LIMIT);
    expect(await clients[0].zcard(key)).toBe(granted);
  });

  it('对照：同样的 N 条连接、同样的 key，走真 Lua → 恰好 limit 次', async () => {
    const key = uniqKey('ctrl:lua');
    const mods = await loadMany(N);
    try {
      await warmUp(mods, key);

      const results = await Promise.all(
        mods.map((m) => m.checkRateLimit(key, { limit: LIMIT, windowMs: 60_000 })),
      );
      const granted = results.filter((r) => r.ok).length;

      // 上面两条证明了这套压力能把非原子实现打穿；这条才有意义
      expect(granted).toBe(LIMIT);

      // 旁证：不看被测代码自己的返回值，直接问 Redis
      const probe = await rawClient();
      expect(await probe.zcard(key)).toBe(LIMIT);
    } finally {
      await closeAll(mods);
    }
  });
});
