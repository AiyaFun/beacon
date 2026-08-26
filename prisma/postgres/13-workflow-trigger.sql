-- 13 · 工作流运行记来源（2026-08-19 · 运行中心要分得清手动/定时/AI 派的）
--
-- 【为什么要】同一条模板现在有三条触发路径：页面手点、定时计划、AI 助手在对话里派。
-- 运行中心把它们混在一起列，用户看到一条失败的运行却不知道该去哪儿处理——
-- 定时跑失败意味着「那条计划可能正在连续失败、快被自动停用了」，手点失败只是这一次的事。
--
-- 缺省 'manual'：存量行全部产生于加这个字段之前，那时唯一的路径就是页面手点。
-- 幂等：IF NOT EXISTS。
ALTER TABLE "WorkflowRun" ADD COLUMN IF NOT EXISTS "trigger" TEXT NOT NULL DEFAULT 'manual';

-- 运行记录的到期清理（lib/legal/retention.ts）按 (status, updatedAt) 扫全库。
-- 这两张表只增不减、定时智能体还会每天往里写，没有这条索引一大就是全表扫。
CREATE INDEX IF NOT EXISTS "AgentRun_status_updatedAt_idx" ON "AgentRun"("status", "updatedAt");
CREATE INDEX IF NOT EXISTS "WorkflowRun_status_updatedAt_idx" ON "WorkflowRun"("status", "updatedAt");
