-- 批 2：授权三档与调用预算
--
-- 四列，全部带默认值 —— 存量运行自动落到「每一步都问你」这个最保守的档，
-- 与它们此前的实际行为完全一致，无需回填。

BEGIN;

-- 授权档：confirm_each（缺省，= 旧行为）| preauthorized | unattended
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "authMode" TEXT NOT NULL DEFAULT 'confirm_each';

-- JSON string[]：派发时用户勾定的工具名。只在 preauthorized 档有意义。
-- **只由发起人的页面动作写入**——模型在对话里说什么都不算数。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "preauthorizedTools" TEXT NOT NULL DEFAULT '[]';

-- 这次执行最多烧多少次模型调用。数的是**调用次数**不是轮数：
-- 一个 costly 工具内部可能一次就调十几次（十几席会诊、八条选题精排），按轮数封顶等于没封顶。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "callBudget" INTEGER NOT NULL DEFAULT 30;

-- 谁发起的：manual | preset | schedule | api。
-- api 那种在服务端强制回 confirm_each（防「模型 A 起草、模型 B 代签」换个皮再来一次）。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'manual';

COMMIT;

-- 【无需回填】默认值就是旧行为：存量运行 authMode='confirm_each'、白名单为空、
-- 预算 30 次、origin='manual'。
-- 【RLS】没有新表，02-rls.sql 无需重跑。
