-- 批 0：执行器止血（状态迁移收口 / 额度挂起 / 真轮数 / 单次执行成本归因）
--
-- 对应 lib/agent/run.ts 的 transition()、waiting_quota 状态、rounds 计数与 LlmCallLog.runId。
-- 全部是加列，**不动任何现有数据**，可在旧代码仍在跑的时候先执行（新列有默认值/可空）。
--
-- 【顺序】先跑这份 SQL，再切新代码。反过来的话：
--   · 新代码写 rounds → 生产 42703 column does not exist，整条执行链路 500。

BEGIN;

-- ① 执行到底跑了几轮模型。steps 保留原义（步骤流水条数 / AgentStep.seq 来源）。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "rounds" INTEGER NOT NULL DEFAULT 0;

-- ② 撞到日额度时挂起到什么时候（北京时间次日 0 点）。
--    月度/平台预算超限不写这里——那两种一律如实判 failed，不挂僵尸。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "quotaResumeAt" TIMESTAMP(3);

-- ③ 这次模型调用属于哪一次 AI 执行。**松引用不加外键**：
--    账本是只增不减的事实记录，不该被运行记录的 90 天清理级联带走。
ALTER TABLE "LlmCallLog" ADD COLUMN IF NOT EXISTS "runId" TEXT;
CREATE INDEX IF NOT EXISTS "LlmCallLog_runId_idx" ON "LlmCallLog"("runId");

COMMIT;

-- 【无需回填】
-- rounds 存量行留 0：那些运行早就结束了，封顶判据只对还在跑的有意义。
-- runId 存量行留 NULL：历史调用确实无从归因，猜一个比空着更糟。
--
-- 【RLS】没有新表，02-rls.sql 无需重跑（AgentRun/LlmCallLog 的策略早已就位）。
