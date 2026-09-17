-- 2026-09-15 内置平台配方：ScrapeRecipe 加 platformKey（微博/快手/知乎/头条/百家号五个平台
-- 没有手写解析器，竞对主页改由按工作区自动播种的配方采集；用户自建配方此列为 NULL）。
-- 幂等，可重复执行。RLS 不变（仍按 workspaceId 归属，02-rls.sql 已覆盖 ScrapeRecipe）。
-- 唯一索引对 NULL 不生效：用户配方随便建多少个都不受影响；内置的每个平台每个工作区只能有一份。

ALTER TABLE beacon."ScrapeRecipe" ADD COLUMN IF NOT EXISTS "platformKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "ScrapeRecipe_workspaceId_platformKey_key" ON beacon."ScrapeRecipe" ("workspaceId", "platformKey");
