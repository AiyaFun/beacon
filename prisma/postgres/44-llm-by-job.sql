-- 2026-08-30 LlmCallLog 增加 byJob：这次调用是不是定时任务替用户跑的。
--
-- ── 为什么 ──
-- 退款政策用「本单生效窗口内有没有真实 AI 调用」判断用户消耗没消耗
--（lib/pay/order.ts consumedCountForOrder → lib/pay/refund-amount.ts）。
-- 而它数的是租户名下**所有**非 Mock 调用，包括用户碰都没碰的定时任务：
--   daily_recommend(05:00) / replenish_evergreen(05:20) / optimize_memory(05:30) /
--   generate_reviews(09:00) / weekly_review(周一 08:00) / run_scheduled_agents(每 10 分钟)
--
-- 后果：用户 23:00 买了 ¥2999 永久买断去睡觉，05:00 系统替他跑了一轮推荐，
-- 早上他想退款 —— 已经「消耗」了，自助全额退款变成「请联系客服」。
-- 他什么都没做，是我们自己替他花掉的。
--
-- ── 存量行 ──
-- 一律为 NULL（= 按「用户消耗」算）。**不猜着回填**：分不出哪些是定时任务跑的，
-- 猜错的方向是「多退钱」，而那比少退更难收场。这一列上线后的新单都是准的。
--
-- 幂等，可重复执行。

ALTER TABLE beacon."LlmCallLog" ADD COLUMN IF NOT EXISTS "byJob" TEXT;

-- 退款判据要按 (tenantId, byJob, createdAt) 过滤，给它一条部分索引：
-- 只索引 byJob IS NULL 的行（那正是要数的那一批），比全列索引小得多。
CREATE INDEX IF NOT EXISTS "LlmCallLog_tenant_user_calls_idx"
  ON beacon."LlmCallLog" ("tenantId", "createdAt")
  WHERE "byJob" IS NULL;
