-- 2026-09-11 内容工单：选题 → 起稿 → 审校 → 待发布 → 已发布 → 复盘 的流程状态与关联。
-- 只做关联，不复制草稿正文 / 发布状态 / 成本。驳回必须带原因；返工只退阶段不覆盖旧交付。
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."ContentWorkItem" (
  "id"              TEXT PRIMARY KEY,
  "workspaceId"     TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "accountId"       TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "stage"           TEXT NOT NULL DEFAULT 'topic',
  "status"          TEXT NOT NULL DEFAULT 'open',
  "ownerMemberId"   TEXT,
  "agentTemplateId" TEXT,
  "dueAt"           TIMESTAMP(3),
  "inputs"          TEXT NOT NULL DEFAULT '',
  "acceptance"      TEXT NOT NULL DEFAULT '',
  "topicId"         TEXT,
  "draftId"         TEXT,
  "publishPlanId"   TEXT,
  "publishRecordId" TEXT,
  "runIds"          TEXT NOT NULL DEFAULT '[]',
  "rejectReason"    TEXT,
  "reworkCount"     INTEGER NOT NULL DEFAULT 0,
  "acceptedAt"      TIMESTAMP(3),
  "createdBy"       TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "ContentWorkItem_workspaceId_status_stage_idx" ON beacon."ContentWorkItem" ("workspaceId", "status", "stage");
CREATE INDEX IF NOT EXISTS "ContentWorkItem_workspaceId_agentTemplateId_idx" ON beacon."ContentWorkItem" ("workspaceId", "agentTemplateId");
CREATE INDEX IF NOT EXISTS "ContentWorkItem_draftId_idx" ON beacon."ContentWorkItem" ("draftId");

CREATE TABLE IF NOT EXISTS beacon."WorkItemEvent" (
  "id"         TEXT PRIMARY KEY,
  "workItemId" TEXT NOT NULL REFERENCES beacon."ContentWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind"       TEXT NOT NULL,
  "fromStage"  TEXT,
  "toStage"    TEXT,
  "note"       TEXT NOT NULL DEFAULT '',
  "refKind"    TEXT,
  "refId"      TEXT,
  "memberId"   TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "WorkItemEvent_workItemId_createdAt_idx" ON beacon."WorkItemEvent" ("workItemId", "createdAt");

-- RLS：02-rls.sql 是权威（'ContentWorkItem' 进 workspaceId 名单；WorkItemEvent 走二级归属）。建完表重跑 02-rls.sql。
