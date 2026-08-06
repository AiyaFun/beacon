-- 行级安全（RLS）——多租户数据隔离的兜底防线（PRD §10）。
-- 应用层已按 tenantId/workspaceId 过滤（第一防线）；RLS 是 defense-in-depth。
-- 使用方式：每个请求/事务开头 SET LOCAL app.current_tenant = '<tenantId>'（见 lib/tenant-rls.ts）。
-- 全局共享表（CompetitorAccount / CrawledPost / HotItem / TopicCluster / SensitiveWord(全局部分)）不启用 RLS。
-- 系统级表（WxPayNotifyLog / LlmCallLog / JobRun）同样不启用：由无租户上下文的系统路径写入，见文末。

-- 帮助函数：取当前租户。
--
-- ⚠️ `nullif(..., '')` 不是防御性冗余，它修的是一个**会导致生产静默故障**的真 bug（2026-07-22 实测发现）：
-- 自定义 GUC 一旦被 `set_config(..., is_local => true)` 设过，**事务提交后并不会回到 NULL，而是变成空字符串**。
-- 在连接池下这意味着：
--   1) 用户请求经 lib/tenant-rls.ts 走了一次 withTenant，连接归还池中，GUC 残留 ''；
--   2) worker / cron / 支付回调稍后拿到**同一条连接**，不设租户上下文，本以为会命中「NULL 放行」；
--   3) 实际拿到的是 ''，`'' IS NULL` 为假 → 走进 `"tenantId" = ''` → **一行都读不到**。
-- 现象是「定时任务时灵时不灵、支付回调偶尔查不到订单」，取决于抽到哪条连接，极难定位。
-- 归一化放在这一个函数里，所有策略的 `IS NULL` 判断一次性全部修好。
-- 实测矩阵见 VERIFICATION.md。
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text AS $$
  SELECT nullif(current_setting('app.current_tenant', true), '');
$$ LANGUAGE sql STABLE;

-- 直接带 tenantId 的表
-- FORCE：表 owner（beacon_app）也必须过 RLS，不再默认绕过。
-- NULL 放行：app_current_tenant() IS NULL 时全量通过——worker/cron/支付回调等无登录态的路径
-- 不设 tenant 上下文，自然拿到全量数据；用户请求经 lib/tenant-rls.ts 设上下文后受限。
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Workspace','Member','Invite','ModelProvider','PaymentOrder'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_current_tenant() IS NULL OR "tenantId" = app_current_tenant());', t);
  END LOOP;
END $$;

-- 经 workspace 间接归属租户的表：CreatorAccount / WatchlistItem / MemoryEntry / TaskItem
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CreatorAccount','WatchlistItem','MemoryEntry','TaskItem'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT id FROM "Workspace" WHERE "tenantId" = app_current_tenant()));', t);
  END LOOP;
END $$;

-- ── 归属链辅助函数 ──────────────────────────────────────────────────────────
-- 下面还有 22 张租户表，归属链最深要绕三层（如 DraftVersion → Draft → CreatorAccount → Workspace）。
-- 每条策略里手写三层嵌套 IN 既难读又容易把列名写错，抽两个 STABLE 函数出来。
--
-- 这两个函数本身读的是 RLS 保护下的表（Workspace / CreatorAccount），且是 SECURITY INVOKER，
-- 所以它们**自己也受同一套策略约束**——这不是循环，而是保证「租户看不见别人的工作区」这一条
-- 在函数内外是同一个口径。
CREATE OR REPLACE FUNCTION app_tenant_workspaces() RETURNS SETOF text AS $$
  SELECT id FROM "Workspace" WHERE "tenantId" = app_current_tenant();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_tenant_accounts() RETURNS SETOF text AS $$
  SELECT id FROM "CreatorAccount" WHERE "workspaceId" IN (SELECT app_tenant_workspaces());
$$ LANGUAGE sql STABLE;

-- ── 第二批：其余租户表（2026-07-22 补齐）──────────────────────────────────────
-- 此前只有上面 9 张表有策略，其余租户数据（选题/草稿/发布/复盘/智囊团/素材/通知…）全部裸奔。
-- 这不是设计如此，是**新表加了没人补策略**——`InspirationItem` / `TopicVote` 就是这么漏进来的。
-- 所以除了补齐，还加了一条**静态守卫测试**（tests/rls-coverage.test.ts）：
-- 以后任何人往 schema 里加租户表却不补策略，测试直接变红。补齐比守卫重要，守卫比补齐持久。
--
-- 全部沿用第一批的 NULL 放行语义：worker/cron/回调等无登录态路径不设 app.current_tenant，
-- 拿到全量数据；用户请求经 lib/tenant-rls.ts 设上下文后受限。

-- 直接带 tenantId
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ComplianceFeedback','SkillInstall'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_current_tenant() IS NULL OR "tenantId" = app_current_tenant());', t);
  END LOOP;
END $$;

-- 直接带 workspaceId
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BotIntegration','BotConversation','InspirationItem','Notification','CollectionRun','IngestToken'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));', t);
  END LOOP;
END $$;

-- 经 CreatorAccount 归属
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AccountDailyStat','AdvisorPersona','AdvisorSession','AudienceProfile','Draft',
    'Material','OwnPost','PersonaVersion','PublishRecord','ReviewReport','TopicIdea'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_current_tenant() IS NULL OR "accountId" IN (SELECT app_tenant_accounts()));', t);
  END LOOP;
END $$;

-- 经 Member 归属（登录会话、团队投票）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AuthSession','TopicVote'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_current_tenant() IS NULL OR "memberId" IN (SELECT id FROM "Member" WHERE "tenantId" = app_current_tenant()));', t);
  END LOOP;
END $$;

-- 二级归属（靠父表外键，没有自己的归属键）
-- DraftVersion / ComplianceCheck → Draft
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DraftVersion','ComplianceCheck'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (app_current_tenant() IS NULL OR "draftId" IN (SELECT id FROM "Draft" WHERE "accountId" IN (SELECT app_tenant_accounts())));', t);
  END LOOP;
END $$;

-- PerformanceSnapshot → PublishRecord（一次性，不必套 DO 块）
ALTER TABLE "PerformanceSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PerformanceSnapshot" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PerformanceSnapshot";
CREATE POLICY tenant_isolation ON "PerformanceSnapshot" FOR ALL
  USING (app_current_tenant() IS NULL OR "publishId" IN (
    SELECT id FROM "PublishRecord" WHERE "accountId" IN (SELECT app_tenant_accounts())));

-- AdvisorOpinion → AdvisorSession
ALTER TABLE "AdvisorOpinion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdvisorOpinion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AdvisorOpinion";
CREATE POLICY tenant_isolation ON "AdvisorOpinion" FOR ALL
  USING (app_current_tenant() IS NULL OR "sessionId" IN (
    SELECT id FROM "AdvisorSession" WHERE "accountId" IN (SELECT app_tenant_accounts())));

-- 说明：beacon_app 的 rolbypassrls=false（已确认），配合 FORCE 使 RLS 对所有连接生效。
-- 管理/迁移用 supabase_admin（superuser，天然绕过）。

-- ── 支付路径与 RLS（已解决）──────────────────────────────────────────────────
-- PaymentOrder 走上面第一组策略（直接 tenantId），保护用户侧读自己的订单列表。
-- 以下路径无租户上下文：
--   1) 微信支付回调 /api/wxpay/notify —— 不设 app.current_tenant → NULL → 策略放行。
--   2) 关单 / 到期降级 / 查单兜底 job —— 同理，NULL 自动全量放行。
-- NULL 放行的安全前提：这些路径都是服务器内部代码，不经用户输入路由。
--
-- WxPayNotifyLog 不启用 RLS：它是系统级去重日志，写入方永远是无登录态的回调路由。
