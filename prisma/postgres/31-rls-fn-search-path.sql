-- 2026-08-26 生产事故修复：RLS 辅助函数 pin search_path。
--
-- 症状：人设页的账号清单/合并/删除预览（所有 lib/tenant-rls.ts 包的事务）一律 500，
--   Prisma 报「The table `CreatorAccount` does not exist in the current database」。
-- 根因：应用连接 search_path = "$user",public；Prisma 生成的 SQL 全限定所以平时没事，
--   但 RLS 策略调用的这三个 SQL 函数体内是未限定表名，按会话 search_path 去 public 找表。
--   没设租户上下文时策略在 IS NULL 处短路不执行函数，所以只有 tenant-rls 事务踩中。
-- 生产已于当日以同等 ALTER 热修（web 容器内执行）；本文件供其它环境 / 整机版执行，幂等。
--
-- ⚠️ 02-rls.sql 的 CREATE FUNCTION 已同步加 `SET search_path FROM CURRENT`——
--   两份必须一起在：只跑本文件、之后重跑 02-rls 会把 pin 冲掉。

ALTER FUNCTION beacon.app_current_tenant() SET search_path = beacon, pg_temp;
ALTER FUNCTION beacon.app_tenant_workspaces() SET search_path = beacon, pg_temp;
ALTER FUNCTION beacon.app_tenant_accounts() SET search_path = beacon, pg_temp;
