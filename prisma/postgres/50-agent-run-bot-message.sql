-- 2026-09-03：AgentRun 加「群里进度卡消息 id」列——飞书派出的任务每一步就地更新那张卡。
ALTER TABLE beacon."AgentRun" ADD COLUMN IF NOT EXISTS "botMessageId" TEXT;
