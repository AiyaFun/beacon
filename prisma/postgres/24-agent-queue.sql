-- 批 1：任务队列与通知
--
-- 只加一列。`queued` 是 status 的新取值（那一列本来就是 TEXT，无需 DDL）。
-- 与 23 一样是纯加列，可在旧代码仍在跑的时候先执行。

BEGIN;

-- 激活段：这次运行被「叫起来跑」的第几回合，通知去重键的一部分。
-- 现在恒为 0；追问/接着跑（批 3）做出来之后才会递增。
-- 先加它是为了让去重键从一开始就对——只按 (runId, status) 去重的话，
-- 将来同一条运行第二次跑完会静默不通知，而追问的人恰恰最想知道「又跑完了」。
ALTER TABLE "AgentRun" ADD COLUMN IF NOT EXISTS "episode" INTEGER NOT NULL DEFAULT 0;

-- 提拔排队中的运行时按 (workspaceId, status) 找最老的一条；
-- 并发闸也按这两列数「正在跑几个」。现有索引是 (workspaceId, createdAt) 与 (status, updatedAt)，
-- 都不够窄。
CREATE INDEX IF NOT EXISTS "AgentRun_workspaceId_status_idx" ON "AgentRun"("workspaceId", "status");

COMMIT;

-- 【无需回填】存量行 episode 留 0 即可：它们要么早已结束，要么还没有过第二段。
-- 【RLS】没有新表，02-rls.sql 无需重跑。
