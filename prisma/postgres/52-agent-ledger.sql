-- 2026-09-05：智能体台账 AgentLedger——按「工作区 × 智能体」隔离的小型状态（盯单/已见清单/进度）。
-- 学的是 Grok Bot 的「工作状态放文件不放记忆」：情报员靠 seen 做到同一条不报两次，
-- 复盘官靠 kv 记住上次复盘到哪。与 MemoryEntry 分表：记忆是「关于用户」的事实，台账是某个 bot 自己的进度。
CREATE TABLE IF NOT EXISTS beacon."AgentLedger" (
  "id"          TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "botSlug"     TEXT NOT NULL,
  "kind"        TEXT NOT NULL DEFAULT 'kv',
  "key"         TEXT NOT NULL,
  "value"       TEXT NOT NULL DEFAULT '',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "AgentLedger_workspaceId_botSlug_kind_key_key"
  ON beacon."AgentLedger"("workspaceId", "botSlug", "kind", "key");
CREATE INDEX IF NOT EXISTS "AgentLedger_workspaceId_botSlug_kind_updatedAt_idx"
  ON beacon."AgentLedger"("workspaceId", "botSlug", "kind", "updatedAt");

-- RLS：与 02-rls.sql 的 workspaceId 组同口径（那份名单里也加了它，重跑 02 会覆盖成同一条策略）
ALTER TABLE beacon."AgentLedger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE beacon."AgentLedger" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON beacon."AgentLedger";
CREATE POLICY tenant_isolation ON beacon."AgentLedger" FOR ALL
  USING (beacon.app_current_tenant() IS NULL OR "workspaceId" IN (SELECT beacon.app_tenant_workspaces()));
