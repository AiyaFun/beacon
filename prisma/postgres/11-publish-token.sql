-- 11 · 发布凭证补 OAuth 字段（2026-08-19 · 微博接口直发）
--
-- 公众号那条链路用 AppID+AppSecret 现换 access_token，不需要存 token；
-- 微博走 OAuth：token 是用户授权换来的、有有效期、换不回来只能重新授权，必须落库。
--
-- 幂等：IF NOT EXISTS。四列全部可空 —— 存量的公众号凭证一列都不填，行为不变。
ALTER TABLE "PublishCredential" ADD COLUMN IF NOT EXISTS "tokenEnc" TEXT;
ALTER TABLE "PublishCredential" ADD COLUMN IF NOT EXISTS "tokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "PublishCredential" ADD COLUMN IF NOT EXISTS "externalUid" TEXT;
ALTER TABLE "PublishCredential" ADD COLUMN IF NOT EXISTS "linkUrl" TEXT;
