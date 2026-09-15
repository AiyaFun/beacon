-- 2026-09-11 审计加固（reports/2026-09-11-beacon-functional-implementation-audit-and-plan.html）：
--   ① AgentKnowledgeBinding 唯一键补 workspaceId（内置模板 id 全局，旧键会跨工作区撞）
--   ② WorkItemRun 关系表替代 ContentWorkItem.runIds JSON（读改写丢更新）
--   ③ WorkflowRun 加 memberId / providerId / waitingOn（接力持久等待，重启可续跑）
-- 幂等，可重复执行。

DROP INDEX IF EXISTS beacon."AgentKnowledgeBinding_templateId_sourceType_sourceId_key";
-- 索引名按 Prisma 的截断规则（63 字符，保留 _key 后缀）写，否则 migrate diff 每次都报 RenameIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentKnowledgeBinding_workspaceId_templateId_sourceType_sou_key"
  ON beacon."AgentKnowledgeBinding" ("workspaceId", "templateId", "sourceType", "sourceId");

CREATE TABLE IF NOT EXISTS beacon."WorkItemRun" (
  "id"         TEXT PRIMARY KEY,
  "workItemId" TEXT NOT NULL REFERENCES beacon."ContentWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "runId"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "WorkItemRun_workItemId_runId_key" ON beacon."WorkItemRun" ("workItemId", "runId");
CREATE INDEX IF NOT EXISTS "WorkItemRun_runId_idx" ON beacon."WorkItemRun" ("runId");
-- 老 JSON 列里的关系先搬进表再删列（生产上这列今天才建，多半是空的；搬一遍不吃亏）
DO $$
DECLARE r RECORD; rid TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='beacon' AND table_name='ContentWorkItem' AND column_name='runIds') THEN
    FOR r IN SELECT "id", "runIds" FROM beacon."ContentWorkItem" WHERE "runIds" IS NOT NULL AND "runIds" <> '[]' LOOP
      FOR rid IN SELECT jsonb_array_elements_text(r."runIds"::jsonb) LOOP
        INSERT INTO beacon."WorkItemRun" ("id", "workItemId", "runId") VALUES (md5(r."id" || rid), r."id", rid) ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
    ALTER TABLE beacon."ContentWorkItem" DROP COLUMN "runIds";
  END IF;
END $$;

ALTER TABLE beacon."WorkflowRun" ADD COLUMN IF NOT EXISTS "memberId"   TEXT;
ALTER TABLE beacon."WorkflowRun" ADD COLUMN IF NOT EXISTS "providerId" TEXT;
ALTER TABLE beacon."WorkflowRun" ADD COLUMN IF NOT EXISTS "waitingOn"  TEXT;
CREATE INDEX IF NOT EXISTS "WorkflowRun_waitingOn_idx" ON beacon."WorkflowRun" ("waitingOn");

-- RLS：WorkItemRun 走二级归属（02-rls.sql 已加）。建完表重跑 02-rls.sql。
