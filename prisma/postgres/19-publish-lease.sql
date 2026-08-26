-- 19 · 发布任务加租约：同一篇稿子不许被两个执行体各填一遍（2026-08-21）
--
-- 【它修的是什么】/api/publish/tasks 曾经是**无锁广播**：任何持采集令牌的执行体
-- GET 一次就看到这个工作区全部待办。用户既装了浏览器插件、又在 Mac mini 上跑着
-- 本机执行体时，同一篇稿子会被各填一遍——而如果他还开了「代点发布」，那就是发两次。
-- 发布是不可撤销的对外动作，这不是「体验问题」。
--
-- 【为什么租约比浏览器任务长一倍】BrowserTask 是 15 分钟，这里是 30 分钟：
-- 这一步**人在环里**——用户要看一眼填得对不对再点发布。按机器的节奏计时，
-- 会把他正在看的那一条从眼皮底下抢走。
--
-- 【为什么不改成 POST /claim】插件已经发布出去了，协议一变旧版本全废。
-- 领活做成「GET 时顺手租下」对插件完全透明，一行插件代码都不用动。
--
-- 两列都可空：NULL = 没人在做，正是存量行的真实状态。幂等：IF NOT EXISTS。
ALTER TABLE "PublishTask" ADD COLUMN IF NOT EXISTS "claimedBy" TEXT;
ALTER TABLE "PublishTask" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
