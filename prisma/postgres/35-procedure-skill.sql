-- 2026-08-29 流程技能：把跑通过的一次任务提炼成可复用的做法。
--
-- 与 ContentSkill（提示词模板）刻意分表：那边写着「模板是数据不是代码」，
-- 而做法天然更靠近代码，混表会让那条约束失效。
--
-- toolAllowlist 是提炼时与来源运行求过交集的结果；重放时还要再与当前用户权限求一次交集。
-- 技能不能成为提权通道——谁都不能靠「存一个技能」用上本来没权限的工具。
--
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."ProcedureSkill" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name"          TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "goal"          TEXT NOT NULL,
  "steps"         TEXT NOT NULL DEFAULT '[]',
  "toolAllowlist" TEXT NOT NULL DEFAULT '[]',
  "sourceRunId"   TEXT,
  "createdBy"     TEXT NOT NULL,
  "usedCount"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL
);

-- 索引名用 Prisma 的默认命名（<Model>_<字段>_<字段>_idx），否则 migrate diff 每次都报「要改名」
CREATE INDEX IF NOT EXISTS "ProcedureSkill_tenantId_workspaceId_idx"
  ON beacon."ProcedureSkill" ("tenantId", "workspaceId");

-- RLS **不在这里写**：02-rls.sql 是权威，它按表名单统一建策略（本次已把
-- 'ProcedureSkill' 加进那份名单）。在这里另写一套策略，会和那边的 tenant_isolation
-- 重名/打架，而且日后改口径要改两处——2026-08-29 第一版就是这么写错的：
-- 我凭印象写了 beacon.current_tenant_id()，真实函数叫 app_current_tenant()，
-- 直接把整个建表脚本带崩。建完表**记得重跑 02-rls.sql**。
