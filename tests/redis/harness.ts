import { vi } from 'vitest';
import type { Redis } from 'ioredis';
import net from 'node:net';

// tests/redis/ 的公共脚手架。核心难点只有一个：**怎么造出真并发**。

export const REDIS_URL = process.env.REDIS_URL ?? '';
export const hasRedis = REDIS_URL.length > 0;

type RateLimitModule = typeof import('@/lib/ratelimit');

const rawClients: Redis[] = [];

// 裸 ioredis 连接，绕开 lib/ratelimit.ts。用途有二：
//   1. 控制组（故意的非原子实现）；
//   2. 从旁边观察 Redis 里的真实状态（GET / ZCARD / PTTL），
//      不通过被测代码自己的返回值来证明被测代码是对的。
export async function rawClient(url = REDIS_URL): Promise<Redis> {
  const IORedis = (await import('ioredis')).default;
  const c = new IORedis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  await c.connect();
  rawClients.push(c);
  return c;
}

export async function closeRaw(): Promise<void> {
  await Promise.all(
    rawClients.splice(0).map((c) => c.quit().catch(() => c.disconnect())),
  );
}

// 拿一份「全新的 lib/ratelimit 模块副本」。
//
// 为什么要这么脏：lib/ratelimit.ts 里的 store 是模块级单例（`let cached`），
// 而这个单例只持有**一条** ioredis 连接。单连接上的命令是排队执行的，
// 用它压不出「多进程/多实例同时打同一个 key」—— 而那正是 Lua 存在的唯一理由。
// vi.resetModules() 清掉模块注册表，下一次 import 得到一份全新副本（cached=null），
// 于是各自新建一条自己的连接。N 份副本 = N 条连接 = 真并发。
export async function loadRatelimit(url = REDIS_URL): Promise<RateLimitModule> {
  vi.resetModules();
  // 注意：RedisStore 是在**首条命令**时才读 process.env.REDIS_URL（见 RedisStore.redis()），
  // 不是构造时。所以这里设了之后不能提前还原。
  process.env.REDIS_URL = url;
  return (await import('@/lib/ratelimit')) as RateLimitModule;
}

export async function loadMany(n: number, url = REDIS_URL): Promise<RateLimitModule[]> {
  const mods: RateLimitModule[] = [];
  for (let i = 0; i < n; i++) mods.push(await loadRatelimit(url));
  return mods;
}

export async function closeAll(mods: RateLimitModule[]): Promise<void> {
  await Promise.all(
    mods.map(async (m) => {
      try {
        await m.getRateLimitStore().close();
      } catch {
        /* 连接本来就是坏的（死端口用例），关不掉无所谓 */
      }
    }),
  );
}

// 预热：让每条连接先完成握手/AUTH，这样后面 Promise.all 里的命令才是
// 真的在同一瞬间涌向 Redis，而不是被连接建立过程串行化掉。
export async function warmUp(mods: RateLimitModule[], key: string): Promise<void> {
  // reset 是最轻的一条真实命令（DEL），顺便保证 key 是干净的
  await Promise.all(mods.map((m) => m.resetRateLimit(`${key}:warmup`)));
}

// 硬断开：failure.test.ts 里 store 指向死端口，ioredis 会永远重连下去。
// `private _redis` 只是 TS 编译期的私有，运行时就是个普通字段 —— 测试里
// 伸手进去 disconnect()，免得重连定时器把测试进程吊住。
export function hardDisconnect(store: unknown): void {
  const r = (store as { _redis?: { disconnect?: () => void } })._redis;
  try {
    r?.disconnect?.();
  } catch {
    /* ignore */
  }
}

// 找一个「确定没人监听」的端口：先占住再放掉，拿到的端口号在测试期间
// 几乎不可能被别人抢走 → 连过去必定 ECONNREFUSED，比硬编码端口可靠。
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export const uniqKey = (prefix: string): string =>
  `test:${prefix}:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// REDIS_URL 里带密码吗（CI 带，本地可能不带）。NOAUTH 用例据此决定跑不跑。
export function urlHasPassword(): boolean {
  if (!hasRedis) return false;
  try {
    return new URL(REDIS_URL).password.length > 0;
  } catch {
    return false;
  }
}
