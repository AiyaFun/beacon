-- 2026-08-29 AI 引用回执。
--
-- 【和 41-ai-crawler-hit 的分工】那张记「有没有被看见」（爬虫来过没有），
-- 这张记「有没有被用上」（AI 的回答里真的引了你）。
--
-- 【这张**要** RLS】它带 workspaceId，是租户自己的数据（不同于 AiCrawlerHit
-- 那张记录本部署自身被谁爬、属于全局）。名单已加 'AiCitation'。
-- ⚠️ 跑完这份要**重跑 02-rls.sql**。
--
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."AiCitation" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL,
  "workspaceId"      TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "engine"           TEXT NOT NULL,
  "answerUrl"        TEXT NOT NULL,
  "question"         TEXT NOT NULL DEFAULT '',
  "sourceUrl"        TEXT NOT NULL,
  "sourceTitle"      TEXT NOT NULL DEFAULT '',
  "platform"         TEXT NOT NULL DEFAULT '',
  "platformItemId"   TEXT NOT NULL DEFAULT '',
  "isMine"           BOOLEAN NOT NULL DEFAULT false,
  "matchedRecordId"  TEXT,
  "matchedAccountId" TEXT,
  "capturedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "AiCitation_workspaceId_capturedAt_idx"
  ON beacon."AiCitation" ("workspaceId", "capturedAt");
CREATE INDEX IF NOT EXISTS "AiCitation_workspaceId_isMine_idx"
  ON beacon."AiCitation" ("workspaceId", "isMine");
