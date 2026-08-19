-- 多平台一键发布（PublishPlan / PublishTask / PublishCredential）—— 2026-08-18 新增，
-- **生产需手动执行一次**。
--
--   DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" \
--     npx prisma db execute --schema prisma/schema.postgres.prisma --file prisma/postgres/07-publish.sql
--
-- 幂等：全部 IF NOT EXISTS，重复跑安全。

SET search_path TO beacon, extensions, public;

CREATE TABLE IF NOT EXISTS "PublishPlan" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "accountId"     TEXT NOT NULL,
  "draftId"       TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'open',
  "aigcConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "createdBy"     TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublishPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublishPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PublishPlan_workspaceId_createdAt_idx" ON "PublishPlan"("workspaceId", "createdAt");
CREATE INDEX IF NOT EXISTS "PublishPlan_draftId_idx" ON "PublishPlan"("draftId");

CREATE TABLE IF NOT EXISTS "PublishTask" (
  "id"             TEXT NOT NULL,
  "planId"         TEXT NOT NULL,
  "platform"       TEXT NOT NULL,
  "channel"        TEXT NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "title"          TEXT NOT NULL,
  "content"        TEXT NOT NULL,
  "extra"          TEXT NOT NULL DEFAULT '{}',
  "coverAssetId"   TEXT,
  "error"          TEXT,
  "publishedUrl"   TEXT,
  "platformItemId" TEXT,
  "externalRef"    TEXT,
  "filledAt"       TIMESTAMP(3),
  "publishedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublishTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublishTask_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PublishPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PublishTask_planId_idx" ON "PublishTask"("planId");
CREATE INDEX IF NOT EXISTS "PublishTask_status_updatedAt_idx" ON "PublishTask"("status", "updatedAt");

CREATE TABLE IF NOT EXISTS "PublishCredential" (
  "id"           TEXT NOT NULL,
  "accountId"    TEXT NOT NULL,
  "platform"     TEXT NOT NULL,
  "appId"        TEXT NOT NULL,
  "appSecretEnc" TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'untested',
  "lastError"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublishCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublishCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CreatorAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "PublishCredential_accountId_platform_key" ON "PublishCredential"("accountId", "platform");

-- RLS：计划按 workspaceId、任务靠父表、凭证按 accountId（与 02-rls.sql 同一套 NULL 放行语义）
ALTER TABLE "PublishPlan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishPlan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PublishPlan";
CREATE POLICY tenant_isolation ON "PublishPlan" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));

ALTER TABLE "PublishTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishTask" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PublishTask";
CREATE POLICY tenant_isolation ON "PublishTask" FOR ALL
  USING (app_current_tenant() IS NULL OR "planId" IN (SELECT id FROM "PublishPlan" WHERE "workspaceId" IN (SELECT app_tenant_workspaces())));

ALTER TABLE "PublishCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishCredential" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PublishCredential";
CREATE POLICY tenant_isolation ON "PublishCredential" FOR ALL
  USING (app_current_tenant() IS NULL OR "accountId" IN (SELECT app_tenant_accounts()));
