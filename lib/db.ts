import { PrismaClient } from '@prisma/client';

// 连接策略：所有连接参数都走 DATABASE_URL 查询串，这里不做任何拼接 ——
// Prisma 原生解析 URL 里的 sslmode / connection_limit / pool_timeout / connect_timeout / pgbouncer。
//   · dev：DATABASE_URL=file:./dev.db（SQLite），本文件逻辑与之无关，不受影响。
//   · 生产（火山引擎 Supabase 版）：标准直连 Postgres，**没有** Supabase 那种 6543 事务级 pooler，
//     因此**不需要** ?pgbouncer=true（加了反而会关掉 prepared statement，白白降速）。
//     连接数收敛、SSL 等全部在 .env.production 的 DATABASE_URL 上加参数，代码零改动。
//     参数清单与理由见 docs/火山Supabase迁移.md。

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.BEACON_ENV === 'dev' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * 裸 SQL（$queryRaw / $queryRawUnsafe）里的表名必须**自己带 schema 限定**。
 *
 * 连接串的 `?schema=beacon` 只作用于 **Prisma 自己生成的 SQL**（它总是显式写 `"beacon"."Tenant"`）；
 * 裸 SQL 走的是数据库原生 `search_path`，而生产连接的 search_path 里没有 beacon。
 * 于是 `SELECT 1 FROM "Tenant"` 在生产上必然 `42P01 relation "Tenant" does not exist`。
 *
 * 🩸 2026-07-28 真实事故：兑现事务里的行锁 `SELECT 1 FROM "Tenant" … FOR UPDATE` 正是这么写的，
 * 导致**用户付了钱、回调一路验签解密都通过、却在最后一步兑现时抛错**（微信收到 5xx 反复重发）。
 * 测试全绿也测不到它：dev/CI 跑 SQLite，那行被 `file:` 判断整条跳过 ——
 * 「只在生产分支执行的裸 SQL」是测试覆盖的天然盲区，写这类代码时必须手工核 schema。
 */
export function qualifiedTable(table: string): string {
  const m = /[?&]schema=([^&]+)/.exec(process.env.DATABASE_URL ?? '');
  const schema = m ? decodeURIComponent(m[1]) : 'public';
  // schema 名来自 env、要拼进 SQL：只允许合法标识符，不合法就炸，绝不带着可疑串去拼语句
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    throw new Error(`DATABASE_URL 的 schema=${schema} 不是合法标识符，拒绝拼进 SQL`);
  }
  return `"${schema}"."${table}"`;
}
