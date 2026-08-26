-- 21 · 对外调用令牌（2026-08-21）
--
-- 【它补的是什么】跑在用户自己机器上的那台烽火台，要能被**别的程序**驱动：
-- 一个脚本、一个系统定时任务、或者 Claude 这样的 MCP 客户端。
-- 这是「像 OpenClaw 一样部署到 Mac mini 直接调用」缺的最后一块。
--
-- 【为什么不复用采集令牌】那一枚是工作区级的、**不绑成员**，回答不了
-- 「这次调用按谁的权限算」。而 AI 执行的每一步权限都按发起人算
-- （lib/agent/run.ts 的 contextForRun）——拿一枚不知道是谁的令牌去开执行，
-- 等于凭空造出一个没有主人的操作者。
--
-- 所以这一枚必须绑到人：token → Member，执行时按这个人的角色跑 RBAC。
-- 他被降权或移出团队，令牌立刻跟着失效，不需要额外做任何事（外键 CASCADE 也会带走行）。
--
-- 只有企业版（appliance / private）用得到；SaaS 形态下路由直接 404，
-- 这张表在 SaaS 上会一直是空的——留着它是为了三档形态共用同一份 schema。
CREATE TABLE IF NOT EXISTS "ApiToken" (
  "id"         TEXT PRIMARY KEY,
  "token"      TEXT NOT NULL,
  "memberId"   TEXT NOT NULL,
  "label"      TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  CONSTRAINT "ApiToken_memberId_fkey" FOREIGN KEY ("memberId")
    REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 唯一约束 = 鉴权时一次 findUnique 命中
CREATE UNIQUE INDEX IF NOT EXISTS "ApiToken_token_key" ON "ApiToken"("token");
CREATE INDEX IF NOT EXISTS "ApiToken_memberId_revokedAt_idx" ON "ApiToken"("memberId", "revokedAt");
