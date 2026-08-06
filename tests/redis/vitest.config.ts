import { defineConfig } from 'vitest/config';
import path from 'node:path';

// tests/redis/ 专用配置。只在手里有**真** Redis 时用：
//   REDIS_URL="redis://:pw@127.0.0.1:6379" npm run test:redis
//
// 为什么必须单独一份配置，而不是复用根 vitest.config.ts：
//   1. 根配置的 setupFiles（tests/setup/per-file.ts）会 `delete process.env.REDIS_URL`。
//      那是「dev 态零基础设施可跑」这条铁律的护栏 —— 保证默认单测永远走进程内实现。
//      这里要的恰恰相反：要的就是 Redis 路径，所以不能挂那个 setup。
//   2. 这批用例不碰 Prisma（只压 lib/ratelimit.ts 的 store 层，Lua 就住在那儿），
//      省掉 globalSetup 建库的开销。
//
// 默认 `npm test` 仍会收集到 tests/redis/*.test.ts —— 但那时 REDIS_URL 已被
// per-file.ts 删掉，用例整体 skip。本机无 Redis 不会因此变红。
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '../../') },
  },
  test: {
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname, '../../'),
    include: ['tests/redis/**/*.test.ts'],
    // 这条独立入口不加载根 setupFiles（tests/setup/per-file.ts），所以那份「零网络」
    // 护栏不覆盖它。显式钉死 60s 离线开关，保证这批用例也不发任何真实热榜请求。
    // （只加这两个开关，绝不动 REDIS_URL —— 本入口的存在意义就是打真 Redis。）
    env: { BEACON_HOT60S: '0', BEACON_60S_DISABLED: '1' },
    isolate: true,
    // 并发压测 + 真实等待窗口滚动（不能用 fake timers，Redis 是真 I/O）
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // forks 池：failure.test.ts 会故意把 ioredis 指向死端口，留下重连定时器；
    // 子进程池能干净收场，不会卡住主进程退出。
    pool: 'forks',
    // 多个文件打同一个 Redis 实例。key 已经随机化了不会串，但顺序跑更好定位问题。
    fileParallelism: false,
  },
});
