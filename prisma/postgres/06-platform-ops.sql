-- 平台运维台（/ops）所需的表与列 —— 2026-08-18 新增，**生产需手动执行一次**。
--
-- 用法（在能连到生产库的机器上，或 `docker compose exec web`）：
--   DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" \
--     npx prisma db execute --schema prisma/schema.postgres.prisma --file prisma/postgres/06-platform-ops.sql
--
-- 幂等：全部 IF NOT EXISTS，重复跑安全。
--
-- ⚠️ 三张表**都不启用 RLS**，这是刻意的：它们记录/承载的正是跨租户的平台侧动作与配置，
--    套上 tenant_isolation 只会让超管在自己租户上下文里读不到别人的数据（症状：运维台永远空白）。
--    它们的访问控制在应用层：lib/ops/admin.ts 的 requirePlatformAdmin() 是唯一入口。
--
-- ⚠️ 索引名与 Prisma 命名规则一致（Table_field1_field2_idx），名字对不上时
--    下次谁跑 db push，Prisma 会认为索引缺失并重建一遍。

SET search_path TO beacon, extensions, public;

-- 1) 平台超管标记。默认 false —— 升级后没有任何人自动变成超管，
--    首任管理员由 env BEACON_PLATFORM_ADMIN_PHONES 白名单授予（见 lib/ops/admin.ts）。
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "platformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- 2) 超管操作审计
CREATE TABLE IF NOT EXISTS "AdminAuditLog" (
  "id"            TEXT NOT NULL,
  "actorMemberId" TEXT NOT NULL,
  "actorName"     TEXT NOT NULL,
  "action"        TEXT NOT NULL,
  "targetType"    TEXT NOT NULL,
  "targetId"      TEXT NOT NULL,
  "targetLabel"   TEXT NOT NULL DEFAULT '',
  "detail"        TEXT NOT NULL DEFAULT '{}',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_actorMemberId_createdAt_idx" ON "AdminAuditLog"("actorMemberId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- 3) 平台级默认模型渠道（apiKeyEnc 与租户 BYOK 同一套 AES-256-GCM 加密，绝不明文）
CREATE TABLE IF NOT EXISTS "PlatformProvider" (
  "id"        TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "vendor"    TEXT NOT NULL,
  "baseUrl"   TEXT NOT NULL,
  "apiKeyEnc" TEXT NOT NULL,
  "model"     TEXT NOT NULL,
  "region"    TEXT NOT NULL DEFAULT 'cn',
  "routing"   TEXT NOT NULL DEFAULT '{}',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "status"    TEXT NOT NULL DEFAULT 'untested',
  "note"      TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformProvider_pkey" PRIMARY KEY ("id")
);

-- 4) 平台级键值配置（value 为 JSON 字符串）
CREATE TABLE IF NOT EXISTS "PlatformSetting" (
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- 5) 租户封禁开关（超管在 /ops 里改；判据在 lib/auth.ts 一处生效）
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "suspendReason" TEXT;

-- 6) LLM 账本记「这笔钱谁出的」。历史行留 'unknown'（不知道就说不知道，别拿猜的数当账）
ALTER TABLE "LlmCallLog" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'unknown';
CREATE INDEX IF NOT EXISTS "LlmCallLog_source_createdAt_idx" ON "LlmCallLog"("source", "createdAt");

-- 7) AI 全域调用（工具执行器）的运行与留痕
CREATE TABLE IF NOT EXISTS "AgentRun" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "accountId"   TEXT,
  "memberId"    TEXT NOT NULL,
  "goal"        TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'running',
  "messages"    TEXT NOT NULL DEFAULT '[]',
  "pending"     TEXT,
  "answer"      TEXT,
  "error"       TEXT,
  "steps"       INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AgentRun_workspaceId_createdAt_idx" ON "AgentRun"("workspaceId", "createdAt");

CREATE TABLE IF NOT EXISTS "AgentStep" (
  "id"        TEXT NOT NULL,
  "runId"     TEXT NOT NULL,
  "seq"       INTEGER NOT NULL,
  "kind"      TEXT NOT NULL,
  "tool"      TEXT NOT NULL DEFAULT '',
  "args"      TEXT NOT NULL DEFAULT '{}',
  "result"    TEXT NOT NULL DEFAULT '',
  "ok"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "AgentStep_runId_seq_idx" ON "AgentStep"("runId", "seq");

-- RLS：AgentRun 按 workspaceId 归属，AgentStep 靠父表 AgentRun 归属（二级）。
-- 与 02-rls.sql 同一套 NULL 放行语义（worker/cron 无租户上下文时全量放行）。
ALTER TABLE "AgentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentRun";
CREATE POLICY tenant_isolation ON "AgentRun" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));

ALTER TABLE "AgentStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentStep" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentStep";
CREATE POLICY tenant_isolation ON "AgentStep" FOR ALL
  USING (app_current_tenant() IS NULL OR "runId" IN (SELECT id FROM "AgentRun" WHERE "workspaceId" IN (SELECT app_tenant_workspaces())));
