-- 2026-09-05 增长缺口整改：漏斗事件 + 邀请奖励 + 租户邀请码。
--
-- 【FunnelEvent 是站点级表，不启用 RLS】写入方多半是还没注册的匿名访客，只供运维台读。
-- 与 41-ai-crawler-hit.sql 同类，理由写在 tests/rls-coverage.test.ts 的 EXEMPT 里。
-- 【ReferralGrant 无外键、无 RLS 归属键】它是对账用的历史事实（谁邀请了谁、给了几天），
-- 任一方注销后仍要留着；只经服务端邀请流程写、运维台读。
--
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."FunnelEvent" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "path"      TEXT NOT NULL DEFAULT '',
  "meta"      TEXT NOT NULL DEFAULT '',
  "visitorId" TEXT,
  "tenantId"  TEXT,
  "day"       TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "FunnelEvent_day_name_idx" ON beacon."FunnelEvent" ("day", "name");
CREATE INDEX IF NOT EXISTS "FunnelEvent_visitorId_idx" ON beacon."FunnelEvent" ("visitorId");
CREATE INDEX IF NOT EXISTS "FunnelEvent_tenantId_idx" ON beacon."FunnelEvent" ("tenantId");

CREATE TABLE IF NOT EXISTS beacon."ReferralGrant" (
  "id"              TEXT PRIMARY KEY,
  "inviterTenantId" TEXT NOT NULL,
  "inviteeTenantId" TEXT NOT NULL,
  "days"            INTEGER NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralGrant_inviteeTenantId_key" ON beacon."ReferralGrant" ("inviteeTenantId");
CREATE INDEX IF NOT EXISTS "ReferralGrant_inviterTenantId_createdAt_idx" ON beacon."ReferralGrant" ("inviterTenantId", "createdAt");

-- Tenant 加两列：邀请码（唯一）与「由谁邀请来」
ALTER TABLE beacon."Tenant" ADD COLUMN IF NOT EXISTS "referralCode" TEXT;
ALTER TABLE beacon."Tenant" ADD COLUMN IF NOT EXISTS "referredBy" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_referralCode_key" ON beacon."Tenant" ("referralCode");
