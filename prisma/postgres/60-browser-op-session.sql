-- 2026-09-17 AI 在用户日常浏览器里操作页面：会话表。
--
-- 它刻意不长得像 BrowserTask：没有 attempts / leaseUntil / expiresAt（那些是「无人值守、可重试」
-- 的语义），只有 lastSeenAt——烽火台页面每次轮询都刷新它，页面一关就不再刷新，会话随即作废。
-- 「用户还在不在」不靠承诺，靠这个时间戳。
--
-- 幂等，可重复执行。建表后必须幂等重跑 02-rls.sql（名单里已加 BrowserOpSession）补 RLS 策略。

CREATE TABLE IF NOT EXISTS beacon."BrowserOpSession" (
  "id"           TEXT PRIMARY KEY,
  "workspaceId"  TEXT NOT NULL,
  "createdBy"    TEXT NOT NULL,
  "origin"       TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'active',
  "pendingStep"  TEXT,
  "stepResult"   TEXT,
  "awaitConfirm" TEXT,
  "steps"        INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "log"          TEXT NOT NULL DEFAULT '[]',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrowserOpSession_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 页面轮询的主路径：本工作区、这个人发起的、还活着的那一条
CREATE INDEX IF NOT EXISTS "BrowserOpSession_workspaceId_createdBy_status_idx"
  ON beacon."BrowserOpSession" ("workspaceId", "createdBy", "status");
