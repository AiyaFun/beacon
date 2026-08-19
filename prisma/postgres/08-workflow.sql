-- 工作流模板与模板市场 —— 2026-08-18 新增，**生产需手动执行一次**。
--
--   DATABASE_URL="..." npx prisma db execute --schema prisma/schema.postgres.prisma \
--     --file prisma/postgres/08-workflow.sql
--
-- 幂等：全部 IF NOT EXISTS。

SET search_path TO beacon, extensions, public;

CREATE TABLE IF NOT EXISTS "WorkflowTemplate" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT,
  "slug"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "emoji"       TEXT NOT NULL DEFAULT '🧩',
  "category"    TEXT NOT NULL DEFAULT 'general',
  "steps"       TEXT NOT NULL DEFAULT '[]',
  "isBuiltin"   BOOLEAN NOT NULL DEFAULT false,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkflowTemplate_slug_key" ON "WorkflowTemplate"("slug");

CREATE TABLE IF NOT EXISTS "WorkflowInstall" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "templateId"  TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowInstall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkflowInstall_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkflowInstall_tenantId_templateId_key" ON "WorkflowInstall"("tenantId", "templateId");

CREATE TABLE IF NOT EXISTS "WorkflowRun" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "templateId"  TEXT NOT NULL,
  "draftId"     TEXT,
  "status"      TEXT NOT NULL DEFAULT 'running',
  "stepIndex"   INTEGER NOT NULL DEFAULT 0,
  "log"         TEXT NOT NULL DEFAULT '[]',
  "error"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkflowRun_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WorkflowRun_workspaceId_createdAt_idx" ON "WorkflowRun"("workspaceId", "createdAt");

-- RLS：安装与运行按租户/工作区隔离；模板表本身**不隔离**（内置模板是全局的，
-- 租户自建部分由应用层按 tenantId 过滤，与 ContentSkill 同一口径）。
ALTER TABLE "WorkflowInstall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowInstall" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "WorkflowInstall";
CREATE POLICY tenant_isolation ON "WorkflowInstall" FOR ALL
  USING (app_current_tenant() IS NULL OR "tenantId" = app_current_tenant());

ALTER TABLE "WorkflowRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "WorkflowRun";
CREATE POLICY tenant_isolation ON "WorkflowRun" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));
