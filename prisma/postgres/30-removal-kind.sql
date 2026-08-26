-- 抓取合规审查（2026-08-24）：数据移除申请增加「申请人是谁」
--
-- 两列。原来这张表只服务一类申请人——被监控账号的权利人。
-- 现在评论者本人也能主张删掉自己那一条评论（《个保法》第 27 条拒绝权 / 第 47 条删除权），
-- 而这两类申请**执行的动作完全不同**，必须在数据层就分开。

BEGIN;

-- account（默认）= 被监控账号的权利人 → 停采该账号 + 删它名下全部数据
-- comment        = 在别人作品下留言的读者本人 → 只删他那一条评论正文
--
-- ⚠️ comment 类**绝不能**进停采闸。评论者填的 handle 是**作品作者**的账号，不是他自己的；
-- 放进闸里等于「张三删掉自己在李四视频下的一条评论」→ 全平台停采李四并删光李四的档案。
-- 拿一个人的权利去伤害另一个人，比不执行这个权利更坏。
-- 执行侧的对应改动在 lib/legal/removal.ts 的 isRemovalRequested。
ALTER TABLE "DataRemovalRequest" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'account';

-- kind=comment 时申请人填的评论原文，用于精确定位要删的那一行 ReaderComment
ALTER TABLE "DataRemovalRequest" ADD COLUMN IF NOT EXISTS "commentText" TEXT;

CREATE INDEX IF NOT EXISTS "DataRemovalRequest_kind_status_idx"
  ON "DataRemovalRequest" ("kind", "status");

COMMIT;

-- 【无需回填】DEFAULT 'account' 已把存量行填成原语义——它们本来就都是账号权利人的申请，
-- 行为与加列前完全一致（停采闸查 kind='account'，存量行全部命中）。
-- 【RLS】没有新表。DataRemovalRequest 是全局表（公开入口写入、超管台读），本来就不做 RLS，
-- 02-rls.sql 无需重跑。
