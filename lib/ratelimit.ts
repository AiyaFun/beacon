// 通用限流器（滑动窗口计数）+ 原子准入计数器。
// 开发态用进程内 Map，零基础设施；生产态配了 REDIS_URL 自动切 Redis
// （Lua 脚本保证原子），跨实例共享计数。

import { log } from './logger';

export type RateLimitResult = {
  ok: boolean;
  remaining: number; // 本窗口剩余次数
  resetAt: number; // 最早可再次通过的时间戳（ms）
};

export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  // 存储故障时的取向。默认 'closed'（拒绝）—— 见 checkRateLimit 上方的论证。
  // 只有「放行的最坏情况有界」的闸门才该显式选 'open'。
  failMode?: 'open' | 'closed';
};

// 准入计数器：一次原子的「按需播种 → +1 → 越限则回滚」
export type ReserveResult = { ok: boolean; used: number };

interface RateLimitStore {
  readonly kind: 'inprocess' | 'redis';
  hit(key: string, opts: RateLimitOptions): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
  // seed：key 不存在时的初始值（从账本读来的历史用量）
  reserve(key: string, seed: number, limit: number, ttlMs: number): Promise<ReserveResult>;
  release(key: string): Promise<void>;
  close(): Promise<void>;
}

// ── 进程内实现（开发态）──
// 注意：计数只存在于当前进程。多实例部署时每实例独立计数，
// 实际放行量 ≈ limit × 实例数 —— 生产必须配 REDIS_URL 走下面的 RedisStore。
class InProcessStore implements RateLimitStore {
  readonly kind = 'inprocess' as const;
  private hits = new Map<string, number[]>(); // key → 命中时间戳（升序）
  private counters = new Map<string, { v: number; exp: number }>(); // 准入计数器
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private maxKeys = 10_000; // 防内存膨胀：超出后丢最旧的 key

  constructor() {
    // 定期清扫空 key，避免长跑进程内存泄漏；unref 不阻止进程退出
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  private sweep() {
    const now = Date.now();
    for (const [k, ts] of this.hits) {
      // 保守以 1 小时为最长窗口回收；窗口内无命中的 key 直接删
      if (ts.length === 0 || now - ts[ts.length - 1] > 3600_000) this.hits.delete(k);
    }
    for (const [k, c] of this.counters) if (c.exp <= now) this.counters.delete(k);
  }

  async hit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    const now = Date.now();
    const from = now - opts.windowMs;
    const ts = (this.hits.get(key) ?? []).filter((t) => t > from);

    if (ts.length >= opts.limit) {
      this.hits.set(key, ts);
      return { ok: false, remaining: 0, resetAt: ts[0] + opts.windowMs };
    }
    ts.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest) this.hits.delete(oldest);
    }
    this.hits.set(key, ts);
    return { ok: true, remaining: opts.limit - ts.length, resetAt: ts[0] + opts.windowMs };
  }

  async reset(key: string) {
    this.hits.delete(key);
  }

  // 单线程 JS，整个函数体内无 await → 天然原子，等价于下面的 Lua
  async reserve(key: string, seed: number, limit: number, ttlMs: number): Promise<ReserveResult> {
    const now = Date.now();
    const cur = this.counters.get(key);
    const c = !cur || cur.exp <= now ? { v: seed, exp: now + ttlMs } : cur;
    c.v += 1;
    if (!this.counters.has(key) && this.counters.size >= this.maxKeys) {
      const oldest = this.counters.keys().next().value;
      if (oldest) this.counters.delete(oldest);
    }
    this.counters.set(key, c);
    if (c.v > limit) {
      c.v -= 1; // 回滚，越限的这次不占名额
      return { ok: false, used: c.v };
    }
    return { ok: true, used: c.v };
  }

  async release(key: string) {
    const c = this.counters.get(key);
    if (c && c.exp > Date.now() && c.v > 0) c.v -= 1;
  }

  async close() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.hits.clear();
    this.counters.clear();
  }
}

// 滑动窗口 Lua：清理过期成员 → 计数 → 未超则写入。整段在 Redis 单线程内原子执行。
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  redis.call('PEXPIRE', key, window)
  return {0, 0, math.floor(tonumber(oldest[2]) + window)}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {1, limit - count - 1, math.floor(tonumber(first[2]) + window)}
`;

// 准入计数器 Lua：播种（仅当 key 不存在）→ INCR → 越限则 DECR 回滚。
// 播种和自增在同一次 eval 内完成，所以并发请求不可能读到同一个旧计数。
const RESERVE_LUA = `
local key = KEYS[1]
local seed = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if redis.call('EXISTS', key) == 0 then
  redis.call('SET', key, seed, 'PX', ttl)
end
local n = redis.call('INCR', key)
if n > limit then
  redis.call('DECR', key)
  return {0, n - 1}
end
return {1, n}
`;

// ── Redis 实现（生产态）──
class RedisStore implements RateLimitStore {
  readonly kind = 'redis' as const;
  // 延迟加载 ioredis，避免 dev 无 Redis 时初始化连接
  private _redis: import('ioredis').Redis | null = null;

  private async redis() {
    if (this._redis) return this._redis;
    const IORedis = (await import('ioredis')).default;
    this._redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
    return this._redis;
  }

  async hit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    const now = Date.now();
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`; // 同毫秒并发不互相覆盖
    const r = await this.redis();
    const [ok, remaining, resetAt] = (await r.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(now),
      String(opts.windowMs),
      String(opts.limit),
      member,
    )) as [number, number, number];
    return { ok: ok === 1, remaining, resetAt };
  }

  async reset(key: string) {
    const r = await this.redis();
    await r.del(key);
  }

  async reserve(key: string, seed: number, limit: number, ttlMs: number): Promise<ReserveResult> {
    const r = await this.redis();
    const [ok, used] = (await r.eval(RESERVE_LUA, 1, key, String(seed), String(limit), String(ttlMs))) as [
      number,
      number,
    ];
    return { ok: ok === 1, used };
  }

  async release(key: string) {
    const r = await this.redis();
    // 只在 key 还在时回滚，且不减到负数
    await r.eval(`if redis.call('EXISTS', KEYS[1]) == 1 and tonumber(redis.call('GET', KEYS[1])) > 0 then redis.call('DECR', KEYS[1]) end`, 1, key);
  }

  async close() {
    if (this._redis) await this._redis.quit();
  }
}

let cached: RateLimitStore | null = null;

// 工厂：有 REDIS_URL 就用 Redis，否则进程内
export function getRateLimitStore(): RateLimitStore {
  if (cached) return cached;
  cached = process.env.REDIS_URL ? new RedisStore() : new InProcessStore();
  return cached;
}

// 主入口。
//
// 存储故障时默认 **fail-close（拒绝）**，理由：
//   放行的最坏情况是「无界」的——攻击者打挂 Redis 就能把付费短信通道刷穿，
//   而账单是不可回滚的；拒绝的最坏情况是「登录暂时不可用」，是可恢复的，
//   且 Redis 挂了本来就是一场有人在处理的事故。响亮地坏掉 > 静默地被穿。
// 需要「可用性优先」的闸门（放行的最坏情况有界）显式传 failMode: 'open'。
export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  try {
    return await getRateLimitStore().hit(key, opts);
  } catch (err) {
    const open = opts.failMode === 'open';
    // 走 logger 而不是裸 console：prod 出 JSON 行，且 error 级会自动触发 Sentry 上报
    log.error('限流存储异常', {
      err,
      key,
      store: getRateLimitStore().kind,
      failMode: open ? 'open' : 'closed',
    });
    if (open) return { ok: true, remaining: opts.limit, resetAt: Date.now() + opts.windowMs };
    // 拒绝时给一个短退避，别让用户看到「请 1 小时后再试」
    return { ok: false, remaining: 0, resetAt: Date.now() + Math.min(opts.windowMs, 30_000) };
  }
}

export async function resetRateLimit(key: string): Promise<void> {
  try {
    await getRateLimitStore().reset(key);
  } catch {
    /* 重置失败无害，忽略 */
  }
}

// ── 原子准入计数器（给 lib/quota.ts 用）────────────────
// 语义：counter 不存在时用 seed 播种（seed = 账本里已发生的用量），然后 +1；
// 超过 limit 就回滚并返回 ok:false。播种+自增在存储侧原子完成，
// 所以并发调用者不可能都读到同一个旧计数 —— 这正是 check-then-act 的病根。
export async function reserveQuota(
  key: string,
  seed: number,
  limit: number,
  ttlMs: number,
): Promise<ReserveResult> {
  return getRateLimitStore().reserve(key, seed, limit, ttlMs);
}

// 归还一个名额（比如月度过了但日度被拦，得把月度那次加回去）
export async function releaseQuota(key: string): Promise<void> {
  try {
    await getRateLimitStore().release(key);
  } catch {
    /* 归还失败只会让本周期略微保守，不放大风险，忽略 */
  }
}

// ── key 构造辅助（scope 用来区分不同闸门，别让两个场景共用计数）──
export function ipKey(scope: string, ip: string): string {
  return `rl:${scope}:ip:${ip}`;
}

export function phoneKey(scope: string, phone: string): string {
  return `rl:${scope}:phone:${phone}`;
}

export function tenantKey(scope: string, tenantId: string): string {
  return `rl:${scope}:tenant:${tenantId}`;
}

// ── 客户端 IP 解析 ──────────────────────────────────────
//
// ⚠️ 核心事实（已实测 next/dist/server/base-server.js:539）：
//     req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress
//   是 `??=` —— Next **只在该头缺失时**才注入 socket IP，客户端自己带了就原样透传。
//   所以「Next 注入的 XFF」和「攻击者伪造的 XFF」在应用层**完全无法区分**：
//   两者都可能是单个值。而 App Router 又不把 socket 暴露给 Server Action。
//   结论：没有反代时，客户端 IP 在应用层就是**不可知**的，任何「猜」都是可绕过的。
//
// 于是策略按 BEACON_TRUSTED_PROXY_HOPS（可信反代层数，默认 0）分野：
//   hops > 0：XFF 从右往左数第 hops 跳。最右边那几跳是你自己的反代追加的，
//             最左侧永远是客户端自己写的，不可信。
//   hops = 0（生产）：不采信任何转发头 → 一律 'unknown'，即全站共用一个桶。
//             这不是「限流失效」而是「限流退化成全局闸」：付费短信的花费仍被
//             limit 死死封顶。代价是正常用户会互相挤兑 —— 这是故意的强制函数，
//             逼运维去配反代，而不是让攻击者静悄悄刷爆你的短信费。
//   hops = 0（开发/测试）：没有攻击者，采信 XFF 最左值，保持零配置开发体验。
const IP_MAX_LEN = 45; // IPv6 最长（含 IPv4 映射）就 45 字符
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-f:]{2,45}$/i; // 粗校验：只放行十六进制和冒号

function isProdRuntime(): boolean {
  return process.env.BEACON_ENV === 'prod' || process.env.NODE_ENV === 'production';
}

function trustedProxyHops(): number {
  const n = Number.parseInt(process.env.BEACON_TRUSTED_PROXY_HOPS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 归一化并粗校验：挡住「任意字符串灌进限流 key 撑爆 key 空间」
function normalizeIp(raw: string | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || s.length > IP_MAX_LEN + 8) return null; // +8 容纳 [..]:port 包装
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined); // [::1]:443
  if (IPV4_RE.test(s.split(':')[0]) && s.includes(':')) s = s.split(':')[0]; // 1.2.3.4:5678
  if (s.length > IP_MAX_LEN) return null;
  if (IPV4_RE.test(s)) {
    return s.split('.').every((o) => Number(o) <= 255) ? s : null;
  }
  // ::ffff:127.0.0.1 这类 IPv4 映射地址原样保留（能唯一标识客户端就够了）
  if (IPV6_RE.test(s) || /^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) return s.toLowerCase();
  return null;
}

let warnedNoProxy = false;

export function getClientIp(h: Headers): string {
  const hops = trustedProxyHops();

  if (hops === 0) {
    if (isProdRuntime()) {
      // 生产 + 未声明反代 = 客户端 IP 不可知。宁可退化成全局闸，也不接受可伪造的输入。
      if (!warnedNoProxy) {
        warnedNoProxy = true;
        log.error('未配置 BEACON_TRUSTED_PROXY_HOPS：无法确定客户端 IP，IP 限流已退化为全局闸门', {
          hint: '请在入口反代覆写/追加 x-forwarded-for，并把 BEACON_TRUSTED_PROXY_HOPS 设为反代层数（通常 1）',
        });
      }
      return 'unknown';
    }
    // dev/test：无攻击者，保持原有宽松行为，零配置可用
    const xff = h.get('x-forwarded-for');
    const first = xff ? normalizeIp(xff.split(',')[0]) : null;
    return first ?? normalizeIp(h.get('x-real-ip') ?? undefined) ?? 'unknown';
  }

  // hops > 0：只认最右边那 hops 跳里最外层那个（= 最外层可信反代看到的对端）
  const parts = (h.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    // 反代声称存在但没给 XFF：退 x-real-ip（nginx 的 X-Real-IP 是覆写语义，hops=1 时可信）
    return normalizeIp(h.get('x-real-ip') ?? undefined) ?? 'unknown';
  }
  const idx = parts.length - hops;
  if (idx < 0) {
    // XFF 比声明的层数还短 → hops 配大了，此时任何取值都可能是客户端伪造的
    log.warn('x-forwarded-for 跳数少于 BEACON_TRUSTED_PROXY_HOPS，按不可知处理', {
      got: parts.length,
      hops,
    });
    return 'unknown';
  }
  return normalizeIp(parts[idx]) ?? 'unknown';
}

export function retryHint(resetAt: number): string {
  const sec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  if (sec < 60) return `${sec} 秒后`;
  return `${Math.ceil(sec / 60)} 分钟后`;
}
