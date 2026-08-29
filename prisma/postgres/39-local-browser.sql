-- 2026-08-29 本机浏览器驱动：Workspace 加 CDP 端点。
--
-- 为空 = 关闭。不再单设布尔开关——「没有端点」本身就是最清楚的关闭状态，
-- 少一个能和实际状态对不上的字段。
--
-- SaaS 生产库照样加这一列（schema 要同构），但那边能力矩阵恒 false，永远走不到。
--
-- 幂等，可重复执行。

ALTER TABLE beacon."Workspace" ADD COLUMN IF NOT EXISTS "browserCdpUrl" TEXT;
