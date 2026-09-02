-- 2026-09-02：BotConversation 加「会话画像」五列——渠道卡上的「用户 / 群聊」真数与「机器人在哪些群」列表。
-- 此前这张表只在对话轮追加或绑账号时才写，只发斜杠命令的群没有行；现在每条入站消息 touch 一次。
ALTER TABLE beacon."BotConversation" ADD COLUMN IF NOT EXISTS "chatType" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE beacon."BotConversation" ADD COLUMN IF NOT EXISTS "chatName" TEXT;
ALTER TABLE beacon."BotConversation" ADD COLUMN IF NOT EXISTS "msgCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE beacon."BotConversation" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3);
ALTER TABLE beacon."BotConversation" ADD COLUMN IF NOT EXISTS "senders" TEXT NOT NULL DEFAULT '[]';
