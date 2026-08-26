-- 批 5：一键任务与定时派发
--
-- 一张新表 + ScheduledAgent 三处改动。

BEGIN;

-- 一键任务：预先设定好的「目标 + 让谁干 + 授权到什么程度」。
-- 它同时是定时的载体：到点了派一条预设任务，就是无人值守的 AI 任务。
CREATE TABLE IF NOT EXISTS "TaskPreset" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "goal"        TEXT NOT NULL,
  -- 让哪个智能体干（NULL = 通用助手）。松引用不加外键：模板删了这张卡还在，
  -- 派的时候会如实说「那个智能体已经不在了」
  "agentTemplateId" TEXT,
  "authMode"    TEXT NOT NULL DEFAULT 'confirm_each',
  "preauthorizedTools" TEXT NOT NULL DEFAULT '[]',
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "sort"        INTEGER NOT NULL DEFAULT 0,
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskPreset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "TaskPreset_workspaceId_enabled_sort_idx"
  ON "TaskPreset"("workspaceId", "enabled", "sort");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TaskPreset_workspaceId_fkey') THEN
    ALTER TABLE "TaskPreset"
      ADD CONSTRAINT "TaskPreset_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 定时现在能指两种东西
ALTER TABLE "ScheduledAgent" ADD COLUMN IF NOT EXISTS "targetKind" TEXT NOT NULL DEFAULT 'workflow';
ALTER TABLE "ScheduledAgent" ADD COLUMN IF NOT EXISTS "taskPresetId" TEXT;
-- targetKind='task' 时没有模板，这一列必须可空
ALTER TABLE "ScheduledAgent" ALTER COLUMN "templateId" DROP NOT NULL;

-- 定时派出去的 AI 执行是**异步**的，派发那一刻拿不到结局。
-- 连败自停闸靠这一列在运行到终态时回写——不记的话 failStreak 永远不累加，
-- 一条配坏的定时会每天准点烧配额且永不自动停用。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "scheduledAgentId" TEXT;

COMMIT;

-- ⚠️ 【建了新表 → 必须补 RLS】跑完这份之后幂等重跑一次 02-rls.sql：
--   psql "$DATABASE_URL" -f prisma/postgres/02-rls.sql
-- 不补的话 TaskPreset 对所有租户都是敞开的。
-- （tests/rls-coverage.test.ts 会拦住漏网的表——这张表就是它抓出来的。）
