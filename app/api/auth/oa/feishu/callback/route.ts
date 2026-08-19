import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE_S, authCookieSecure } from '@/lib/auth-constants';
import { createSession } from '@/lib/auth';
import { can } from '@/lib/edition';
import { memberByOaIdentity, oaIdentity, joinByInvite } from '@/lib/auth/oa';
import { readBotSecrets } from '@/lib/bot';
import { feishuTenantAccessToken } from '@/lib/bot/feishu';
import { checkRateLimit, getClientIp, ipKey } from '@/lib/ratelimit';
import { siteUrl } from '@/lib/site-url';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger({ module: 'oa-web' });
const STATE_COOKIE = 'beacon_oa_state';
const LIMIT = { limit: 30, windowMs: 600_000 };

// 飞书网页授权回跳。**私有化版**用它——那边有公网域名和证书，
// 能在飞书后台把 redirect_uri 登记上去。
//
// 整机版走不了这条路：它跑在 http://localhost:<端口>，只有那台机器上的浏览器跳得回来，
// 局域网里的同事回跳直接断（所以整机版的主路径是私聊机器人，见 lib/auth/oa.ts 文件头）。
// 这个端点在整机版上仍然可用（管理员在本机操作时），只是不作为主推。
//
// 【state 必须比对】不比对就是 CSRF：攻击者构造一条带自己 code 的回跳链接骗受害者点开，
// 受害者的浏览器会被登录成**攻击者的账号**，此后受害者在里面写的东西全在攻击者账号下。
// 与 app/api/auth/wechat/callback 同一套做法。

function fail(msg: string) {
  return NextResponse.redirect(`${siteUrl()}/login?err=${encodeURIComponent(msg)}`);
}

export async function GET(req: NextRequest) {
  if (!can('oaLogin')) return new NextResponse('Not Found', { status: 404 });

  const rl = await checkRateLimit(ipKey('oa:web', getClientIp(req.headers)), LIMIT);
  if (!rl.ok) return fail('尝试过于频繁，请稍后再试');

  const code = req.nextUrl.searchParams.get('code') ?? '';
  const state = req.nextUrl.searchParams.get('state') ?? '';
  const cookieState = req.cookies.get(STATE_COOKIE)?.value ?? '';
  if (!code) return fail('授权失败：没有拿到 code');
  if (!state || state !== cookieState) return fail('授权状态校验失败，请重新发起登录');

  // state 里可以带一个邀请 token：`<随机串>.<邀请码>`，用于"点邀请链接 → 授权 → 直接加入"。
  const inviteToken = state.includes('.') ? state.slice(state.indexOf('.') + 1) : '';

  const integration = await prisma.botIntegration.findFirst({
    where: { provider: 'feishu', enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { inboundKey: true, secretsEnc: true },
  });
  if (!integration?.inboundKey) return fail('这台实例还没有配置飞书企业应用');
  const secrets = readBotSecrets(integration.secretsEnc);
  if (!secrets.appSecret) return fail('飞书应用缺少 App Secret，请到「机器人与通知」补齐');

  const { token: appToken, error } = await feishuTenantAccessToken(integration.inboundKey, secrets.appSecret);
  if (!appToken) {
    log.warn('飞书取 tenant_access_token 失败', { error });
    return fail('飞书鉴权失败，请稍后再试');
  }

  // code → 用户身份
  let openId = '';
  let displayName = '';
  try {
    const r = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const j = (await r.json()) as { code?: number; msg?: string; data?: { access_token?: string } };
    if (j.code !== 0 || !j.data?.access_token) {
      log.warn('飞书换 access_token 失败', { code: j.code, msg: j.msg });
      return fail('授权失败，请重新发起登录');
    }
    const ur = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${j.data.access_token}` },
    });
    const uj = (await ur.json()) as { code?: number; data?: { open_id?: string; name?: string } };
    if (uj.code !== 0 || !uj.data?.open_id) return fail('没能读到你的飞书身份');
    openId = uj.data.open_id;
    displayName = uj.data.name ?? '';
  } catch (e) {
    log.warn('飞书网页授权异常', { err: (e as Error).message });
    return fail('授权过程出错，请重新发起登录');
  }

  const identity = oaIdentity('feishu', openId);
  let member = await memberByOaIdentity(identity);

  // 还不是成员：带了邀请码就按邀请加入；没带就明说下一步（网页这条路不做自动加入 ——
  // 授权链接可以被转发到公司外，而私聊机器人那条路的对端一定是企业通讯录里的人）。
  if (!member) {
    if (!inviteToken) return fail('你还不是成员。请私聊企业应用里的机器人发「登录」，或找管理员要邀请链接。');
    const j = await joinByInvite(inviteToken, 'feishu', openId, displayName);
    if (!j.ok) return fail(j.message);
    member = await memberByOaIdentity(identity);
    if (!member) return fail('加入失败，请重试');
  }

  const token = await createSession(member.id, req.headers.get('user-agent') ?? undefined);
  const res = NextResponse.redirect(siteUrl() + '/');
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: authCookieSecure(), path: '/', maxAge: AUTH_COOKIE_MAX_AGE_S,
  });
  res.cookies.set(STATE_COOKIE, '', { path: '/', maxAge: 0 }); // state 用完即焚
  return res;
}
