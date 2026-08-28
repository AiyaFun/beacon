-- 2026-08-27 OA 群机器人派任务：AgentRun 加 botChatRef 列。
--
-- 群里 /派 /执行 派出的 AI 执行记下「从哪个群来的」：`<provider>:<integrationId>:<chatId>`。
-- 用途：① 终态/等确认时把回执发回那个群（lib/bot/dispatch.ts 的 echoRunToChat，
-- 挂在状态迁移咽喉 afterTransition 上）；② 群里 /任务 /终止 只圈定**本群派出的**运行，
-- 群成员不能碰站内或别的群派的任务。
-- 站内/API/定时派的运行此列为 NULL，行为不变。
--
-- 幂等，可重复执行。

ALTER TABLE beacon."AgentRun" ADD COLUMN IF NOT EXISTS "botChatRef" TEXT;
