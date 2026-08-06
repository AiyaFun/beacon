import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkRateLimit, resetRateLimit, ipKey, phoneKey, tenantKey, getClientIp, retryHint } from '@/lib/ratelimit';

// 限流器（进程内实现）。Redis 路径未测——见文件末尾说明。
const uniq = () => `k-${Math.random().toString(36).slice(2)}`;

afterEach(() => vi.useRealTimers());

describe('ratelimit · 窗口内放行与拦截', () => {
  it('未达上限一律放行', async () => {
    const key = uniq();
    for (let i = 0; i < 3; i++) expect((await checkRateLimit(key, { limit: 3, windowMs: 60_000 })).ok).toBe(true);
  });

  it('第 limit+1 次被拦', async () => {
    const key = uniq();
    for (let i = 0; i < 3; i++) await checkRateLimit(key, { limit: 3, windowMs: 60_000 });
    expect((await checkRateLimit(key, { limit: 3, windowMs: 60_000 })).ok).toBe(false);
  });

  it('remaining 逐次递减到 0', async () => {
    const key = uniq();
    const opts = { limit: 3, windowMs: 60_000 };
    expect((await checkRateLimit(key, opts)).remaining).toBe(2);
    expect((await checkRateLimit(key, opts)).remaining).toBe(1);
    expect((await checkRateLimit(key, opts)).remaining).toBe(0);
    expect((await checkRateLimit(key, opts)).remaining).toBe(0); // 拦下后仍是 0，不出现负数
  });

  it('被拦后继续打不会把窗口越推越远（不是「惩罚性」限流）', async () => {
    const key = uniq();
    const opts = { limit: 2, windowMs: 60_000 };
    await checkRateLimit(key, opts);
    await checkRateLimit(key, opts);
    const first = await checkRateLimit(key, opts);
    const second = await checkRateLimit(key, opts);
    expect(second.resetAt).toBe(first.resetAt); // resetAt 锚在最早那次命中，不被后续请求刷新
  });

  it('limit=1 边界', async () => {
    const key = uniq();
    expect((await checkRateLimit(key, { limit: 1, windowMs: 60_000 })).ok).toBe(true);
    expect((await checkRateLimit(key, { limit: 1, windowMs: 60_000 })).ok).toBe(false);
  });

  it('resetAt 落在未来且不超过一个窗口', async () => {
    const key = uniq();
    const now = Date.now();
    const r = await checkRateLimit(key, { limit: 1, windowMs: 60_000 });
    expect(r.resetAt).toBeGreaterThan(now - 1);
    expect(r.resetAt).toBeLessThanOrEqual(now + 60_000 + 50);
  });
});

describe('ratelimit · 滑动窗口', () => {
  it('窗口滚过之后恢复放行', async () => {
    vi.useFakeTimers();
    const key = uniq();
    const opts = { limit: 2, windowMs: 60_000 };
    await checkRateLimit(key, opts);
    await checkRateLimit(key, opts);
    expect((await checkRateLimit(key, opts)).ok).toBe(false);

    vi.advanceTimersByTime(60_001); // 整窗滚过
    expect((await checkRateLimit(key, opts)).ok).toBe(true);
  });

  it('是滑动窗口不是固定窗口：只有过期的那次被释放出来', async () => {
    vi.useFakeTimers();
    const key = uniq();
    const opts = { limit: 2, windowMs: 60_000 };
    await checkRateLimit(key, opts); // t=0
    vi.advanceTimersByTime(30_000);
    await checkRateLimit(key, opts); // t=30s
    expect((await checkRateLimit(key, opts)).ok).toBe(false); // 窗口内已 2 次

    vi.advanceTimersByTime(30_001); // t=60.001s，t=0 那次滑出窗口
    expect((await checkRateLimit(key, opts)).ok).toBe(true); // 释放出一个名额
    expect((await checkRateLimit(key, opts)).ok).toBe(false); // 但只有一个
  });
});

describe('ratelimit · key 隔离', () => {
  it('不同 key 各自计数，互不影响', async () => {
    const [a, b] = [uniq(), uniq()];
    await checkRateLimit(a, { limit: 1, windowMs: 60_000 });
    expect((await checkRateLimit(a, { limit: 1, windowMs: 60_000 })).ok).toBe(false);
    expect((await checkRateLimit(b, { limit: 1, windowMs: 60_000 })).ok).toBe(true);
  });

  it('scope 隔离：同一 IP 的发码闸与校验闸不共用计数', async () => {
    const ip = '1.2.3.4';
    expect(ipKey('login:send', ip)).not.toBe(ipKey('login:verify', ip));
    await checkRateLimit(ipKey('login:send', ip), { limit: 1, windowMs: 60_000 });
    expect((await checkRateLimit(ipKey('login:verify', ip), { limit: 1, windowMs: 60_000 })).ok).toBe(true);
  });

  it('key 构造器格式稳定且维度隔离', () => {
    expect(ipKey('login:send', '1.2.3.4')).toBe('rl:login:send:ip:1.2.3.4');
    expect(phoneKey('login:send', '13800138000')).toBe('rl:login:send:phone:13800138000');
    expect(tenantKey('llm', 't1')).toBe('rl:llm:tenant:t1');
    // ip / phone / tenant 三个维度不会互撞
    expect(new Set([ipKey('s', 'x'), phoneKey('s', 'x'), tenantKey('s', 'x')]).size).toBe(3);
  });

  it('resetRateLimit 清零后重新放行', async () => {
    const key = uniq();
    await checkRateLimit(key, { limit: 1, windowMs: 60_000 });
    expect((await checkRateLimit(key, { limit: 1, windowMs: 60_000 })).ok).toBe(false);
    await resetRateLimit(key);
    expect((await checkRateLimit(key, { limit: 1, windowMs: 60_000 })).ok).toBe(true);
  });
});

describe('ratelimit · 登录闸门实际阈值（security agent 定的档）', () => {
  it('login:send 按 IP 10 次/小时：第 11 次拦', async () => {
    const key = ipKey('login:send', `ip-${Math.random()}`);
    const opts = { limit: 10, windowMs: 3600_000 };
    for (let i = 0; i < 10; i++) expect((await checkRateLimit(key, opts)).ok).toBe(true);
    expect((await checkRateLimit(key, opts)).ok).toBe(false);
  });

  it('login:verify 按 IP 20 次/10 分钟：第 21 次拦', async () => {
    const key = ipKey('login:verify', `ip-${Math.random()}`);
    const opts = { limit: 20, windowMs: 600_000 };
    for (let i = 0; i < 20; i++) expect((await checkRateLimit(key, opts)).ok).toBe(true);
    expect((await checkRateLimit(key, opts)).ok).toBe(false);
  });
});

describe('ratelimit · getClientIp', () => {
  it('x-forwarded-for 取最左（最初的客户端）', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' });
    expect(getClientIp(h)).toBe('203.0.113.9');
  });

  it('单个 xff 值', () => {
    expect(getClientIp(new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('xff 带空格被 trim', () => {
    expect(getClientIp(new Headers({ 'x-forwarded-for': '  203.0.113.9 , 10.0.0.1' }))).toBe('203.0.113.9');
  });

  it('无 xff 时回退 x-real-ip', () => {
    expect(getClientIp(new Headers({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('xff 优先于 x-real-ip', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '198.51.100.7' });
    expect(getClientIp(h)).toBe('203.0.113.9');
  });

  it('两个头都没有 → unknown（不抛异常）', () => {
    expect(getClientIp(new Headers())).toBe('unknown');
  });

  it('空 xff 值 → 回退', () => {
    expect(getClientIp(new Headers({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('⚠️ 所有 unknown 共用一个计数桶：拿不到 IP 时全网用户互相挤兑', async () => {
    // 记录既有行为而非主张它是对的。反代必须**覆写** x-forwarded-for，
    // 否则要么被伪造绕过（改个头就换一个桶），要么全落进 unknown 这个共享桶里互相误伤。
    expect(getClientIp(new Headers())).toBe(getClientIp(new Headers()));
  });
});

describe('ratelimit · retryHint 文案', () => {
  it('小于 60 秒说秒', () => {
    expect(retryHint(Date.now() + 30_000)).toMatch(/^\d+ 秒后$/);
  });

  it('大于 60 秒说分钟', () => {
    expect(retryHint(Date.now() + 300_000)).toBe('5 分钟后');
  });

  it('已过期的 resetAt 不产生负数或 0', () => {
    expect(retryHint(Date.now() - 10_000)).toBe('1 秒后');
  });
});

describe('ratelimit · 存储故障时的取向', () => {
  // 设计取舍（与旧版相反，是有意推翻的）：默认 fail-close。
  // 放行的最坏情况「无界」——打挂 Redis 就能刷穿付费短信，账单不可回滚；
  // 拒绝的最坏情况「登录暂时不可用」，可恢复。响亮地坏掉 > 静默地被穿。
  it('store.hit 抛错 → 默认拒绝并告警', async () => {
    vi.resetModules();
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1'); // 走 Redis 分支，但连不上
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { checkRateLimit: check } = await import('@/lib/ratelimit');
    const r = await check(uniq(), { limit: 1, windowMs: 1000 });
    expect(r.ok).toBe(false);
    expect(err).toHaveBeenCalled();
    vi.unstubAllEnvs();
    err.mockRestore();
  });

  it('拒绝时给短退避，不让用户看到「请 1 小时后再试」', async () => {
    vi.resetModules();
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { checkRateLimit: check } = await import('@/lib/ratelimit');
    const r = await check(uniq(), { limit: 10, windowMs: 3600_000 });
    expect(r.ok).toBe(false);
    expect(r.resetAt - Date.now()).toBeLessThanOrEqual(30_000);
    vi.unstubAllEnvs();
    err.mockRestore();
  });

  // 可用性优先的闸门（放行的最坏情况有界）显式选 open
  it('failMode: open → 仍放行并告警', async () => {
    vi.resetModules();
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { checkRateLimit: check } = await import('@/lib/ratelimit');
    const r = await check(uniq(), { limit: 1, windowMs: 1000, failMode: 'open' });
    expect(r.ok).toBe(true);
    expect(err).toHaveBeenCalled();
    vi.unstubAllEnvs();
    err.mockRestore();
  });
});
