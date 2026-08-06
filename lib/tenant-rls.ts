import { PrismaClient } from '@prisma/client';
import { prisma } from './db';

// RLS 会话上下文：生产 Postgres 下，每个请求把当前租户写入会话变量 app.current_tenant，
// 配合 prisma/postgres/02-rls.sql 的 FORCE ROW LEVEL SECURITY 做行级隔离。dev(sqlite) 下 no-op。
//
// 策略设计：app_current_tenant() IS NULL → 全量放行（worker/cron/回调等无租户上下文的路径）；
// 非 NULL → 严格按租户过滤。用户请求通过本模块设上下文后走受限路径。

export type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

function isPostgres() {
  return (process.env.DATABASE_URL || '').startsWith('postgres');
}

export async function withTenant<T>(tenantId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  if (!isPostgres()) return fn(prisma as unknown as TxClient);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantId);
    return fn(tx);
  });
}
