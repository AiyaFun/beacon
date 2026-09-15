-- 2026-09-09 AI 自写工具：模型用现有内置工具拼出来的新工具，在 node:vm 沙箱里跑。
--
-- 与 ProcedureSkill（做法技能：只是系统提示里的引导 + 工具白名单）刻意分表：
-- 这里存的是**会被执行的代码**。起草落 draft，只有页面上的人看过代码点「启用」才 enabled；
-- write/costly/contract 由 uses（声明要调的内置工具）的并集推出，不由模型自报。
-- SaaS 上这张表可以为空：lib/edition.ts aiAuthoredTools 在多租户形态恒关。
--
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."AgentToolDef" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name"            TEXT NOT NULL,
  "label"           TEXT NOT NULL,
  "description"     TEXT NOT NULL,
  "params"          TEXT NOT NULL DEFAULT '{"type":"object","properties":{}}',
  "uses"            TEXT NOT NULL DEFAULT '[]',
  "code"            TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'draft',
  "write"           BOOLEAN NOT NULL DEFAULT false,
  "costly"          BOOLEAN NOT NULL DEFAULT false,
  "contract"        BOOLEAN NOT NULL DEFAULT false,
  "authoredByRunId" TEXT,
  "createdBy"       TEXT NOT NULL,
  "usedCount"       INTEGER NOT NULL DEFAULT 0,
  "lastError"       TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);

-- 索引名用 Prisma 的默认命名，否则 migrate diff 每次都报「要改名」
CREATE INDEX IF NOT EXISTS "AgentToolDef_tenantId_workspaceId_status_idx"
  ON beacon."AgentToolDef" ("tenantId", "workspaceId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "AgentToolDef_workspaceId_name_key"
  ON beacon."AgentToolDef" ("workspaceId", "name");

-- RLS 不在这里写：02-rls.sql 是权威（'AgentToolDef' 已加进 workspaceId 那份名单）。建完表记得重跑 02-rls.sql。
