-- 2026-08-29 任意站点采集配方。
--
-- 与 ParserIncident 的分工：那套治「已知平台的已知字段改版失效」（指纹 platform+scope+field），
-- 学不了新站点；这张表管「用户自己指的站点」——给网址、说要抓什么，学一次存成配方。
--
-- RLS 由 02-rls.sql 按名单统一建（名单已加 'ScrapeRecipe'），这里只建表。
--
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."ScrapeRecipe" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name"        TEXT NOT NULL,
  "origin"      TEXT NOT NULL,
  "pathPattern" TEXT,
  "fields"      TEXT NOT NULL DEFAULT '[]',
  "rules"       TEXT NOT NULL DEFAULT '[]',
  "version"     INTEGER NOT NULL DEFAULT 1,
  "status"      TEXT NOT NULL DEFAULT 'learning',
  "failCount"   INTEGER NOT NULL DEFAULT 0,
  "lastOkAt"    TIMESTAMP(3),
  "lastFailAt"  TIMESTAMP(3),
  "createdBy"   TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "ScrapeRecipe_tenantId_workspaceId_idx" ON beacon."ScrapeRecipe" ("tenantId", "workspaceId");
CREATE INDEX IF NOT EXISTS "ScrapeRecipe_workspaceId_origin_idx"   ON beacon."ScrapeRecipe" ("workspaceId", "origin");
