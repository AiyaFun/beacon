-- 批 4 后半：自主智能体
--
-- 五列，全部带默认值或可空 —— 存量模板自动落到 pipeline（= 旧行为），无需回填。

BEGIN;

-- 这个智能体是哪一种：
--   pipeline（缺省）—— 一串定死的步骤，跑法完全可预期
--   autonomous     —— 给它目标和授权范围，它自己安排怎么做
ALTER TABLE "WorkflowTemplate" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'pipeline';

-- JSON，**只有 autonomous 用它**：{ systemPrompt?, tools[], callBudget?, defaultAuthMode? }
-- tools 是工具白名单，**只能收窄不能放宽**——派它时会与「当前用户自己有权用的」求交集。
ALTER TABLE "WorkflowTemplate" ADD COLUMN IF NOT EXISTS "agentConfig" TEXT;

-- 哪个自主智能体在跑这次执行（null = 通用助手）。松引用不加外键。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "agentTemplateId" TEXT;

-- 谁派出来的子运行（null = 用户自己派的）。**松引用不加外键**：
-- 父运行被到期清理删掉之后，子运行的记录本身还是有意义的。
-- 它非空即「我已经是子运行了」——那时再派自主智能体一律拒绝（嵌套只许一层）。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "parentRunId" TEXT;

-- 这次执行能用哪些工具（JSON 数组，空数组 = 不限，即通用助手的旧行为）。
--
-- 【为什么必须落库，不能只当参数传】自主智能体的白名单原来只影响系统提示词里印出来的
-- 名字，而主循环每一轮都重新算一遍工具表、**没带白名单**——送给模型的 tool schema
-- 仍然是全量的，它照样调得动。后台恢复（租约过期被别的进程接手）时更是连当初那个
-- 参数都拿不到。所以白名单跟着运行走，主循环从这一列读。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "toolAllowlist" TEXT NOT NULL DEFAULT '[]';

COMMIT;

-- 【无需回填】存量模板 mode='pipeline' 就是它们原本的行为；
-- 存量运行 parentRunId/agentTemplateId 留 NULL（它们确实不是谁派出来的）。
-- 【RLS】没有新表，02-rls.sql 无需重跑。
