-- 2026-08-27 个人创作者小站·本机密码登录：Member 加 passwordHash 列。
--
-- 只有 appliance/private 形态会用到（MATRIX.passwordLogin；SaaS 上登录页不渲染、动作被
-- 能力闸拦截）。SaaS 生产也要跑这条：schema 双轨必须一致，否则部署闸门 2/3 拦构建。
-- scrypt 格式 `scrypt:N:r:p:<saltB64>:<hashB64>`，实现见 lib/auth/password.ts。
--
-- 幂等，可重复执行。

ALTER TABLE beacon."Member" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
