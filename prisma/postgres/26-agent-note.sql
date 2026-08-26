-- 批 3-4：追问与续跑 + 产物清单
--
-- 两张新表。AgentRunNote：跑着跑着用户又说的那句话（追问、补充要求、确认时的附言）。
--
-- 【为什么是表不是 AgentRun 上的 JSON 列】那一列会有两个写入方——
-- web 请求（用户打字）与后台循环（消费掉它）。JSON 列只能读-改-写，
-- 两边同时来必丢话，而且丢得无声无息。insert-only 的子表天然没有这个问题。

BEGIN;

CREATE TABLE IF NOT EXISTS "AgentRunNote" (
  "id"         TEXT NOT NULL,
  "runId"      TEXT NOT NULL,
  "text"       TEXT NOT NULL,
  -- 什么时候被送进模型的对话里。NULL = 还没送达（界面上要标出来）
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentRunNote_pkey" PRIMARY KEY ("id")
);

-- 排干时按「这次运行还没消费的」查
CREATE INDEX IF NOT EXISTS "AgentRunNote_runId_consumedAt_idx" ON "AgentRunNote"("runId", "consumedAt");

-- 运行记录被到期清理删掉时，附言跟着走（它单独留着没有任何意义）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentRunNote_runId_fkey'
  ) THEN
    ALTER TABLE "AgentRunNote"
      ADD CONSTRAINT "AgentRunNote_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 这次执行做出了什么东西（草稿、版本、图、发布计划…）。
--
-- 确认闸管的是动作**之前**，这张表管的是**之后**——预授权跑完的那些没有前一道，
-- 更需要后一道。refId **松引用不加外键**：产物表各式各样，而且产物被用户删掉之后
-- 这条记录仍有价值（「它当时做了这个，现在没了」）。
CREATE TABLE IF NOT EXISTS "AgentArtifact" (
  "id"        TEXT NOT NULL,
  "runId"     TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "refId"     TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentArtifact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AgentArtifact_runId_createdAt_idx" ON "AgentArtifact"("runId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgentArtifact_runId_fkey') THEN
    ALTER TABLE "AgentArtifact"
      ADD CONSTRAINT "AgentArtifact_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;

-- ⚠️ 【建了新表 → 必须补 RLS】
-- 跑完这份之后**幂等重跑一次 02-rls.sql**（那份文件已经把 AgentRunNote 的策略加进去了）：
--   psql "$DATABASE_URL" -f prisma/postgres/02-rls.sql
-- 不补的话**这两张表**（AgentRunNote / AgentArtifact）对所有租户都是敞开的。
-- tests/rls-coverage 会拦住漏网的表，但生产上要靠这一步真的执行。
