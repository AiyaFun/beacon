-- 2026-09-03：IngestToken 加「执行器会做哪些浏览器任务」列——领活时自报，派活前按它过滤。
ALTER TABLE beacon."IngestToken" ADD COLUMN IF NOT EXISTS "kinds" TEXT;
