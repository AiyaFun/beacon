-- TopicIdea.angleShape ——2026-08-12 新增，**生产需手动执行一次**。
--
-- 选题精排现在会判定切入角的答案结构（definition | comparison | list | process | judgment，
-- 口径见 lib/topic/scoring.ts）并落库。生产库缺这一列时，**所有 TopicIdea 查询直接报 42703**，
-- 选题页整页打不开——不是少一个字段，是整页挂掉，因为 Prisma 的 SELECT 会带上所有已声明列。
--
-- 为什么单独给一份 SQL 而不是让人跑 db-init-supabase.sh：那个脚本会 `prisma db push`
-- 整个 schema，任何一处本地与生产的漂移都会被一起推上去。加一列就只加这一列。
--
-- 用法（在能连到生产库的机器上，或 `docker compose exec web`）：
--   DATABASE_URL="postgresql://beacon_app:<PWD>@<HOST>:<PORT>/postgres?schema=beacon&sslmode=require" \
--     npx prisma db execute --schema prisma/schema.postgres.prisma --file prisma/postgres/04-angle-shape.sql
--
-- 幂等：IF NOT EXISTS，重复跑安全。
--
-- 可空、无默认值，对存量行安全：老数据留 NULL 即「没判定过」，而不是被塞进某个默认形状——
-- 空着比按一个错标签便宜（同 schema 里那条注释）。
-- 不需要 RLS 处理：这是给已有表加列，TopicIdea 的行级策略不因新增列而变。

SET search_path TO beacon, extensions, public;

ALTER TABLE "TopicIdea" ADD COLUMN IF NOT EXISTS "angleShape" TEXT;
