-- 2026-09-11 按任务选模型：AgentRun / TaskPreset / ScheduledAgent 各加一列 providerId。
-- null/auto = 按功能路由（旧行为）；'platform' = 平台渠道；其它 = 本租户 ModelProvider.id（网关按租户校验）。
-- 幂等，可重复执行。
ALTER TABLE beacon."AgentRun"       ADD COLUMN IF NOT EXISTS "providerId" TEXT;
ALTER TABLE beacon."TaskPreset"     ADD COLUMN IF NOT EXISTS "providerId" TEXT;
ALTER TABLE beacon."ScheduledAgent" ADD COLUMN IF NOT EXISTS "providerId" TEXT;
