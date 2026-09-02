-- 2026-09-01：BotIntegration 加 agentTemplateId——「为渠道选一个智能体」。
-- 群里 @机器人 的对话以绑定智能体的职责说明作身份，派活优先派它；空 = 原通用助手行为。
ALTER TABLE beacon."BotIntegration" ADD COLUMN IF NOT EXISTS "agentTemplateId" TEXT;
