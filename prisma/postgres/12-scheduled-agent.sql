-- 12 · 定时智能体（2026-08-19 · 让工作流模板能按时自己跑）
--
-- 【为什么是新表而不是复用 JobRun/automationConfig】
--   · JobRun 是**平台级**作业的记账（broadcast / batch_tenant），没有 workspaceId；
--   · automationConfig 是「这几条平台任务要不要对我生效」的布尔开关，表达不了
--     「每周一三五早上 9 点，用「小红书日更三件套」在 A 账号跑一遍」这种用户自定义计划。
--
-- 【三道闸都在应用层，不在这张表】表只负责记状态：
--   failStreak（连续失败到阈值自动停）、lastRunDay（防同一逻辑日重跑）、enabled。
--   每日次数上限与配额检查在 lib/workflow/schedule.ts。
--
-- 幂等：IF NOT EXISTS。
CREATE TABLE IF NOT EXISTS "ScheduledAgent" (
  "id"          TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "templateId"  TEXT NOT NULL,
  "atHour"      INTEGER NOT NULL DEFAULT 9,
  "atMinute"    INTEGER NOT NULL DEFAULT 0,
  "weekdays"    TEXT NOT NULL DEFAULT '[]',
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "failStreak"  INTEGER NOT NULL DEFAULT 0,
  "lastRunDay"  TEXT,
  "lastRunAt"   TIMESTAMP(3),
  "lastStatus"  TEXT,
  "lastError"   TEXT,
  "createdBy"   TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScheduledAgent_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ScheduledAgent_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 扫描器每 10 分钟按 (enabled, atHour) 捞一批，这个索引是它的主路径
CREATE INDEX IF NOT EXISTS "ScheduledAgent_enabled_atHour_idx" ON "ScheduledAgent"("enabled", "atHour");
CREATE INDEX IF NOT EXISTS "ScheduledAgent_workspaceId_idx" ON "ScheduledAgent"("workspaceId");

-- RLS：与 02-rls.sql 里「直接带 workspaceId」那一批同一套策略。
-- 新表加了不补策略 = 裸奔，tests/rls-coverage.test.ts 会把这种情况判红。
ALTER TABLE "ScheduledAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScheduledAgent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ScheduledAgent";
CREATE POLICY tenant_isolation ON "ScheduledAgent" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));
