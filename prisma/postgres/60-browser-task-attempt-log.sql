-- 2026-09-15 BrowserTask 加 attemptLog：每次尝试的失败原因留档（JSON 数组，只追加，成功也不清）。
-- 真机：一次采集 11 分钟里前 10 分钟在等失败退避，事后 error 已被成功清空、可重试的失败又不通知、
-- 客户端也没日志——第一次为什么失败查不到。形状见 lib/browser-task/index.ts 的 BrowserTaskAttempt。
-- 幂等，可重复执行。RLS 不变（仍按 workspaceId 归属，02-rls.sql 已覆盖 BrowserTask）。

ALTER TABLE beacon."BrowserTask" ADD COLUMN IF NOT EXISTS "attemptLog" TEXT NOT NULL DEFAULT '[]';
