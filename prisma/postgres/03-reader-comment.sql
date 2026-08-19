-- 读者原声表（ReaderComment）——2026-08-11 新增，**生产需手动执行一次**。
--
-- 为什么单独给一份 SQL 而不是让人跑 db-init-supabase.sh：那个脚本会 `prisma db push`
-- 整个 schema，任何一处本地与生产的漂移都会被一起推上去。加一张表就只加这一张。
--
-- 用法（在能连到生产库的机器上，或 `docker compose exec web`）：
--   DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" \
--     npx prisma db execute --schema prisma/schema.postgres.prisma --file prisma/postgres/03-reader-comment.sql
--
-- 幂等：全部 IF NOT EXISTS + DO 块判存在，重复跑安全。
--
-- ⚠️ 索引名与 Prisma 的命名规则严格一致（Table_field1_field2_key / _idx）。
--    名字对不上，下次谁跑 db push 时 Prisma 会认为索引缺失并重建一遍。

SET search_path TO beacon, extensions, public;

CREATE TABLE IF NOT EXISTS "ReaderComment" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "accountId"   TEXT,
  "platform"    TEXT NOT NULL,
  "scope"       TEXT NOT NULL,
  -- 作品**作者**的 handle，不是评论者的。本表没有任何指向评论者的列。
  "author"      TEXT,
  "workKey"     TEXT NOT NULL DEFAULT 'unknown',
  "workTitle"   TEXT,
  "text"        TEXT NOT NULL,
  "kind"        TEXT NOT NULL DEFAULT 'other',
  "textHash"    TEXT NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReaderComment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReaderComment_workspaceId_platform_workKey_textHash_key"
  ON "ReaderComment" ("workspaceId", "platform", "workKey", "textHash");
CREATE INDEX IF NOT EXISTS "ReaderComment_workspaceId_scope_collectedAt_idx"
  ON "ReaderComment" ("workspaceId", "scope", "collectedAt");
CREATE INDEX IF NOT EXISTS "ReaderComment_workspaceId_platform_workKey_idx"
  ON "ReaderComment" ("workspaceId", "platform", "workKey");
-- 保留期清理按时间扫全表，不带 workspaceId
CREATE INDEX IF NOT EXISTS "ReaderComment_collectedAt_idx"
  ON "ReaderComment" ("collectedAt");

-- 外键：工作区删除时带走评论（ADD CONSTRAINT 没有 IF NOT EXISTS，判一下再加）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ReaderComment_workspaceId_fkey'
  ) THEN
    ALTER TABLE "ReaderComment"
      ADD CONSTRAINT "ReaderComment_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS：与 02-rls.sql 里「直接带 workspaceId」那一批同一套策略。
-- 这里重复一遍是刻意的——只跑本文件也必须把策略带上。
-- 新表加了没人补策略正是 InspirationItem / TopicVote 当年裸奔的原因。
ALTER TABLE "ReaderComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReaderComment" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ReaderComment";
CREATE POLICY tenant_isolation ON "ReaderComment" FOR ALL
  USING (app_current_tenant() IS NULL OR "workspaceId" IN (SELECT app_tenant_workspaces()));
