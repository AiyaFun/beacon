-- 15 · 浏览器任务队列（2026-08-19 · 让 AI 能把活派给采集插件）
--
-- 【为什么需要一张表】插件是浏览器扩展，服务端**推不动它**：没有长连接、没有推送通道，
-- 用户的浏览器还可能整天关着。所以方向只能反过来——服务端把活排进队列，
-- 插件醒来时（chrome.alarms）自己来领。这张表就是那个队列。
--
-- 【三个字段解释三件事】
--   · leaseUntil：领了不还是常态（关标签页/关机/崩溃），到期放回池子；
--   · expiresAt：排了没人领的活会过期——三天前让采的数据现在采回来也没意义；
--   · attempts：重试上限，别让一个死任务把插件的每一轮都占掉。
--
-- 幂等：IF NOT EXISTS。
CREATE TABLE IF NOT EXISTS "BrowserTask" (
  "id"          TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "accountId"   TEXT,
  "kind"        TEXT NOT NULL,
  "payload"     TEXT NOT NULL DEFAULT '{}',
  "status"      TEXT NOT NULL DEFAULT 'pending',
  "origin"      TEXT NOT NULL DEFAULT 'agent',
  "claimedBy"   TEXT,
  "claimedAt"   TIMESTAMP(3),
  "leaseUntil"  TIMESTAMP(3),
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "result"      TEXT,
  "error"       TEXT,
  "createdBy"   TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BrowserTask_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 插件领活的主路径：按 workspace 找 pending 且没过期的
CREATE INDEX IF NOT EXISTS "BrowserTask_workspaceId_status_expiresAt_idx"
  ON "BrowserTask"("workspaceId", "status", "expiresAt");
-- 租约回收扫的是这条
CREATE INDEX IF NOT EXISTS "BrowserTask_status_leaseUntil_idx"
  ON "BrowserTask"("status", "leaseUntil");

-- RLS：与 02-rls.sql 里「直接带 workspaceId」那一批同一套策略。
ALTER TABLE "BrowserTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BrowserTask" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "BrowserTask";
CREATE POLICY tenant_isolation ON "BrowserTask" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));
