-- 2026-08-29 AI 爬虫来访计数。
--
-- 【为什么要它】GEO 这条链上最大的病灶是「评分与真实被引用率零校准」——
-- 量表打得很细，却从来没有一条真实反馈进来过。这张表是第一条反馈：
-- AI 爬虫到底来没来、来的是谁、爬的哪一页。
--
-- 【全局表，不启用 RLS】它记的是**这个部署自己的站**被谁爬了，不属于任何租户。
-- 与 HotItem / CrawledPost 同类（见 02-rls.sql 开头那段），因此**不进 02-rls.sql 的名单**。
--
-- 幂等，可重复执行。

CREATE TABLE IF NOT EXISTS beacon."AiCrawlerHit" (
  "id"      TEXT PRIMARY KEY,
  "agent"   TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "path"    TEXT NOT NULL,
  "day"     TEXT NOT NULL,
  "count"   INTEGER NOT NULL DEFAULT 1,
  "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 同一个（爬虫, 路径, 天）只有一行，重复来访只加计数。
-- 唯一键是 upsert 的落点：没有它，并发来访会写出一堆重复行，聚合就白做了。
CREATE UNIQUE INDEX IF NOT EXISTS "AiCrawlerHit_agent_path_day_key"
  ON beacon."AiCrawlerHit" ("agent", "path", "day");
CREATE INDEX IF NOT EXISTS "AiCrawlerHit_day_idx" ON beacon."AiCrawlerHit" ("day");
