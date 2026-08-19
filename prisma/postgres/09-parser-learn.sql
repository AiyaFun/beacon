-- 采集自学习（ParserIncident / ParserRule）—— 2026-08-18 新增，**生产需手动执行一次**。
--
--   DATABASE_URL="..." npx prisma db execute --schema prisma/schema.postgres.prisma \
--     --file prisma/postgres/09-parser-learn.sql
--
-- 幂等：全部 IF NOT EXISTS。

SET search_path TO beacon, extensions, public;

CREATE TABLE IF NOT EXISTS "ParserIncident" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "platform"    TEXT NOT NULL,
  "scope"       TEXT NOT NULL,
  "field"       TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'open',
  "skeleton"    TEXT NOT NULL DEFAULT '',
  "note"        TEXT NOT NULL DEFAULT '',
  "samples"     INTEGER NOT NULL DEFAULT 1,
  "fingerprint" TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ParserIncident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ParserIncident_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ParserIncident_platform_status_idx" ON "ParserIncident"("platform", "status");
CREATE INDEX IF NOT EXISTS "ParserIncident_workspaceId_createdAt_idx" ON "ParserIncident"("workspaceId", "createdAt");

CREATE TABLE IF NOT EXISTS "ParserRule" (
  "id"         TEXT NOT NULL,
  "platform"   TEXT NOT NULL,
  "field"      TEXT NOT NULL,
  "selectors"  TEXT NOT NULL DEFAULT '[]',
  "anchors"    TEXT NOT NULL DEFAULT '[]',
  "status"     TEXT NOT NULL DEFAULT 'candidate',
  "version"    INTEGER NOT NULL DEFAULT 1,
  "hitRate"    DOUBLE PRECISION,
  "source"     TEXT NOT NULL DEFAULT 'llm',
  "note"       TEXT NOT NULL DEFAULT '',
  "incidentId" TEXT,
  "reviewedBy" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ParserRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ParserRule_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "ParserIncident"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "ParserRule_platform_status_idx" ON "ParserRule"("platform", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "ParserRule_platform_field_version_key" ON "ParserRule"("platform", "field", "version");

-- RLS：事件按 workspaceId 隔离（运维台跨租户读时不设 tenant 上下文，走 NULL 放行）。
-- ParserRule 是**全局规则库**（与 SensitiveWord / AlgorithmRule 同性质），不做行级隔离。
ALTER TABLE "ParserIncident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ParserIncident" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ParserIncident";
CREATE POLICY tenant_isolation ON "ParserIncident" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));
