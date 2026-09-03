-- 2026-09-03 读者原声加来源列：comment（评论区）| danmaku（B 站弹幕）
ALTER TABLE beacon."ReaderComment" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'comment';
