import { describe, it, expect, afterAll } from 'vitest';
import { hasRedis, rawClient, closeRaw, loadRatelimit, loadMany, closeAll, uniqKey, sleep } from './harness';

// lib/ratelimit.ts 里的 RESERVE_LUA（reserveQuota / releaseQuota），
// 也就是 lib/quota.ts 放行 LLM 调用时真正依赖的那道闸门，在真 Redis 上真的执行。

describe.skipIf(!hasRedis)('RESERVE_LUA · 真 Redis', () => {
  afterAll(closeRaw);

  it('key 不存在时用 seed 播种，然后 +1', async () => {
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('quota:seed');
      // seed = 账本里已发生的用量
      const r = await m.reserveQuota(key, 5, 10, 60_000);
      expect(r).toEqual({ ok: true, used: 6 });
      expect(Number(await probe.get(key))).toBe(6);
    } finally {
      await closeAll([m]);
    }
  });

  it('seed 只播一次：key 已存在时后续 reserve 不重新播种', async () => {
    // 播两次就意味着每次调用都把计数按回账本值 → 闸门形同虚设
    const m = await loadRatelimit();
    try {
      const key = uniqKey('quota:seed-once');
      expect((await m.reserveQuota(key, 5, 10, 60_000)).used).toBe(6);
      expect((await m.reserveQuota(key, 5, 10, 60_000)).used).toBe(7); // 不是又回到 6
      expect((await m.reserveQuota(key, 0, 10, 60_000)).used).toBe(8); // seed 变了也不影响
    } finally {
      await closeAll([m]);
    }
  });

  it('越限时 DECR 回滚：Redis 里的值停在 limit，不会涨到 limit+1', async () => {
    // 不回滚的话，计数会随着被拒的请求一路涨上去，
    // 之后就算 release 也拉不回来 —— 本周期的额度永久性地废了。
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('quota:rollback');
      for (let i = 0; i < 3; i++) expect((await m.reserveQuota(key, 0, 3, 60_000)).ok).toBe(true);

      for (let i = 0; i < 5; i++) {
        const r = await m.reserveQuota(key, 0, 3, 60_000);
        expect(r).toEqual({ ok: false, used: 3 }); // used 报的是回滚后的真实值
      }
      expect(Number(await probe.get(key))).toBe(3); // 被拒 5 次也没把计数顶上去
    } finally {
      await closeAll([m]);
    }
  });

  it('release 归还名额：被拦之后还回去，下一次就能过', async () => {
    // 对应 quota.ts：月度过了但日度被拦 → 把月度那次还回去
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('quota:release');
      expect((await m.reserveQuota(key, 0, 2, 60_000)).ok).toBe(true);
      expect((await m.reserveQuota(key, 0, 2, 60_000)).ok).toBe(true);
      expect((await m.reserveQuota(key, 0, 2, 60_000)).ok).toBe(false); // 满了

      await m.releaseQuota(key);
      expect(Number(await probe.get(key))).toBe(1);
      expect((await m.reserveQuota(key, 0, 2, 60_000)).ok).toBe(true); // 空出来的位能用
    } finally {
      await closeAll([m]);
    }
  });

  it('release 不会把计数减成负数', async () => {
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('quota:no-negative');
      await m.reserveQuota(key, 0, 5, 60_000); // → 1
      await m.releaseQuota(key); // → 0
      await m.releaseQuota(key); // → 还是 0
      await m.releaseQuota(key);
      expect(Number(await probe.get(key))).toBe(0);
    } finally {
      await closeAll([m]);
    }
  });

  it('release 一个不存在的 key 不会把它创出来', async () => {
    // 裸 DECR 会把缺失的 key 创成 -1，那等于凭空发一张额度券：
    // 下个周期首次 reserve 时 EXISTS 为真 → 不播种 → 从 -1 开始数。
    // Lua 里的 EXISTS 守卫就是挡这个的。
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('quota:release-missing');
      await m.releaseQuota(key);
      expect(await probe.exists(key)).toBe(0);
    } finally {
      await closeAll([m]);
    }
  });

  it('原子性：64 条连接并发 reserve，放行数精确等于 limit', async () => {
    const N = 64;
    const LIMIT = 10;
    const key = uniqKey('quota:atomic');
    const mods = await loadMany(N);
    const probe = await rawClient();
    try {
      await Promise.all(mods.map((m) => m.releaseQuota(`${key}:warmup`))); // 预热连接
      const results = await Promise.all(mods.map((m) => m.reserveQuota(key, 0, LIMIT, 60_000)));

      expect(results.filter((r) => r.ok).length).toBe(LIMIT);
      expect(Number(await probe.get(key))).toBe(LIMIT);
      // 放行者拿到的 used 是 1..LIMIT，每个恰好一次 —— 没有两个人拿到同一个号
      expect(results.filter((r) => r.ok).map((r) => r.used).sort((a, b) => a - b)).toEqual(
        Array.from({ length: LIMIT }, (_, i) => i + 1),
      );
    } finally {
      await closeAll(mods);
    }
  });

  it('原子性：并发 + seed>0（播种本身也在同一次 eval 里，不会各播各的）', async () => {
    // 这是 quota.ts 注释里那句「播种和自增在同一次 eval 内完成，
    // 所以并发请求不可能读到同一个旧计数」的直接检验。
    // 若播种和自增分两步，64 个并发会各自把 key 按回 8，然后放行远超 2 次。
    const N = 64;
    const mods = await loadMany(N);
    const probe = await rawClient();
    try {
      const key = uniqKey('quota:atomic-seed');
      await Promise.all(mods.map((m) => m.releaseQuota(`${key}:warmup`)));

      const results = await Promise.all(mods.map((m) => m.reserveQuota(key, 8, 10, 60_000)));
      expect(results.filter((r) => r.ok).length).toBe(2); // 10 - 8
      expect(Number(await probe.get(key))).toBe(10);
    } finally {
      await closeAll(mods);
    }
  });

  it('计数器 key 一定带 TTL，且不会被后续 reserve 续期', async () => {
    // 两件事：
    //   1. 不带 TTL = 每租户每天/每月一个永久 key，内存只涨不落。
    //   2. 更阴的是「被续期」：如果每次 reserve 都刷新 TTL，活跃租户的
    //      计数器就永远不到期 → 周期滚动了配额却不重置 → 用户被永久锁死。
    //      Lua 里只有「key 不存在」分支才 SET PX，INCR 不碰 TTL —— 这条验证它。
    const m = await loadRatelimit();
    const probe = await rawClient();
    try {
      const key = uniqKey('quota:ttl');
      await m.reserveQuota(key, 0, 100, 5_000);
      const t1 = await probe.pttl(key);
      expect(t1).toBeGreaterThan(0); // -1 = 永不过期 = 泄漏
      expect(t1).toBeLessThanOrEqual(5_000);

      await sleep(600);
      await m.reserveQuota(key, 0, 100, 5_000); // 再来一发，ttl 参数还是 5s
      const t2 = await probe.pttl(key);
      expect(t2).toBeLessThan(t1 - 400); // 在往下走，没被顶回 5000
    } finally {
      await closeAll([m]);
    }
  });

  it('浮点 TTL 会被 Redis 直接拒绝 —— 证明 quota.ts 里 msUntil 的 Math.floor 是承重的', async () => {
    // lib/quota.ts 的注释：「Redis 的 PX 只吃整数毫秒，浮点会直接报错」。
    // 这句话此前没人验证过。真跑一次：如果它是错的，这条会红，
    // 说明那个 Math.floor 只是装饰，注释在骗人。
    const m = await loadRatelimit();
    try {
      const key = uniqKey('quota:float-ttl');
      await expect(m.reserveQuota(key, 0, 10, 1_000.5)).rejects.toThrow();
    } finally {
      await closeAll([m]);
    }
  });

  it('日/月两个计数器互不干扰（quota.ts 靠这个分别封顶）', async () => {
    const m = await loadRatelimit();
    try {
      const day = uniqKey('quota:tenant:d');
      const month = uniqKey('quota:tenant:m');
      expect((await m.reserveQuota(day, 0, 1, 60_000)).ok).toBe(true);
      expect((await m.reserveQuota(day, 0, 1, 60_000)).ok).toBe(false); // 日度满
      expect((await m.reserveQuota(month, 0, 5, 60_000)).ok).toBe(true); // 月度不受影响
    } finally {
      await closeAll([m]);
    }
  });
});
