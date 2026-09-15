-- 2026-09-11 数字员工的知识范围：哪个模板可读哪些资料（InspirationItem / Material / MemoryEntry 的范围声明，不复制内容）。
-- 一个模板一条都没有 = 不收窄；有 ≥1 条 = 检索只在绑定范围内。引用记录写进 AgentStep(kind='citation')。
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."AgentKnowledgeBinding" (
  "id"          TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "templateId"  TEXT NOT NULL,
  "sourceType"  TEXT NOT NULL,
  "sourceId"    TEXT NOT NULL,
  "purpose"     TEXT NOT NULL DEFAULT '',
  "priority"    INTEGER NOT NULL DEFAULT 0,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "createdBy"   TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "AgentKnowledgeBinding_templateId_sourceType_sourceId_key"
  ON beacon."AgentKnowledgeBinding" ("templateId", "sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "AgentKnowledgeBinding_workspaceId_templateId_idx"
  ON beacon."AgentKnowledgeBinding" ("workspaceId", "templateId");

-- RLS：02-rls.sql 是权威（'AgentKnowledgeBinding' 已加进 workspaceId 那份名单）。建完表重跑 02-rls.sql。
