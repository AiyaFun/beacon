-- 2026-09-01：LlmCallLog 加 degraded 列。
-- mocked=true 的两种成因（选路落 Mock vs 真实调用失败被兜底）此前在账本里完全同形，
-- 只能靠 source='mock' 一个被改写过的信号，排查 daily_recommend 夜批失败时无从分辨。
-- 与 TopicIdea.degraded 同一口径。
ALTER TABLE beacon."LlmCallLog" ADD COLUMN IF NOT EXISTS "degraded" BOOLEAN NOT NULL DEFAULT false;
