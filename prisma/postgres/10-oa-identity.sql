-- 企业/私有化版的 OA 登录身份列 —— 2026-08-19 新增，**生产需手动执行一次**。
--
-- 用法（同 06~09）：
--   docker compose exec -T web sh -c 'npx prisma db execute --url "$DATABASE_URL" --file /tmp/10-oa-identity.sql'
--
-- 为什么单独一份：三形态那一轮只改了两份 schema，没配套 SQL。
-- 新装（appliance/private）走 `prisma db push` 拿得到这一列，而 SaaS 生产库**永远不 db push**
-- （会 DROP 手工加的 pgvector 列），只认 prisma/postgres/NN-*.sql 这条路——漏了它，
-- 私聊机器人登录在生产直接报「列不存在」。
--
-- oaIdentity = `<平台>:<该平台的用户唯一标识>`（如 feishu:ou_xxx），全局唯一：
-- 一个 OA 账号只能绑一个成员，否则「登录」这条指令不知道该把谁放进来。
-- 可空：SaaS 用户用手机号/微信登录，这一列一直是 NULL。
--
-- 幂等：IF NOT EXISTS，重复跑安全。

SET search_path TO beacon, extensions, public;

ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "oaIdentity" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Member_oaIdentity_key" ON "Member"("oaIdentity");
