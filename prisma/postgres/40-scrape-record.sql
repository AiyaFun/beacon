-- 2026-08-29 采集配方抓到的数。
--
-- 在这张表之前，两条采集路抓到的值都是原地丢掉的：定时扫描只拿 values 数了个长度用来判
-- 配方好没好；插件连传都没传（POST 里只有 {kind:'result', ok:true}）。也就是说
-- 「每 6 小时把配方跑一遍」实质是**配方健康检查**，不是采集——用户以为数据在积累，
-- 库里一个字都没有。
--
-- RLS 由 02-rls.sql 按名单统一建（名单已加 'ScrapeRecord'），这里只建表。
-- ⚠️ 改完这份要**重跑 02-rls.sql**，否则新表没有行级隔离。
--
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."ScrapeRecord" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES beacon."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recipeId"    TEXT NOT NULL,
  "url"         TEXT NOT NULL,
  "values"      TEXT NOT NULL DEFAULT '{}',
  "rows"        TEXT NOT NULL DEFAULT '[]',
  "rowCount"    INTEGER NOT NULL DEFAULT 0,
  "got"         INTEGER NOT NULL DEFAULT 0,
  "want"        INTEGER NOT NULL DEFAULT 0,
  "channel"     TEXT NOT NULL,
  "capturedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 「这个配方最近抓到的几条」是主查询，也是留存清理的扫描路径
CREATE INDEX IF NOT EXISTS "ScrapeRecord_workspaceId_recipeId_capturedAt_idx"
  ON beacon."ScrapeRecord" ("workspaceId", "recipeId", "capturedAt");
CREATE INDEX IF NOT EXISTS "ScrapeRecord_tenantId_capturedAt_idx"
  ON beacon."ScrapeRecord" ("tenantId", "capturedAt");

-- 配方的页面级选项（就绪选择器 / 滚几屏 / 列表行容器）。
-- 单独一列而不是塞进 rules：rules 是「每个字段怎么取」，这些是「整页怎么打开」，两回事。
ALTER TABLE beacon."ScrapeRecipe" ADD COLUMN IF NOT EXISTS "options" TEXT NOT NULL DEFAULT '{}';
