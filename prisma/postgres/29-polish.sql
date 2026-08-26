-- 批 6：打磨
--
-- 一列。定向通知：这条只给某个人看吗。

BEGIN;

-- NULL = 工作区里人人可见（旧行为）；有值 = 只给这个人。
--
-- 【为什么需要】「等你确认」只有发起人点得动，而红点是工作区级的——
-- 不定向的话，同事也会为一件他推不动的事看到红点。
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "memberId" TEXT;

COMMIT;

-- 【无需回填】存量通知 memberId 留 NULL = 人人可见，与它们原本的行为一致。
-- 【RLS】没有新表，02-rls.sql 无需重跑。
