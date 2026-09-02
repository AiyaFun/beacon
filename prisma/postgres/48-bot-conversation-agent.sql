-- 2026-09-02：BotConversation 加「当前智能体」列——一个机器人可以在不同会话里切不同的智能体。
-- null = 用渠道默认（BotIntegration.agentTemplateId）。松引用不加外键。
ALTER TABLE beacon."BotConversation" ADD COLUMN IF NOT EXISTS "agentTemplateId" TEXT;
