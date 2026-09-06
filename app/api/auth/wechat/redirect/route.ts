import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl, generateState, getWechatConfig } from '@/lib/wechat-auth';
import { authCookieSecure } from '@/lib/auth-constants';
import { normalizeReferralCode } from '@/lib/growth/referral';
import { safeNextPath } from '@/lib/auth/safe-next';

const STATE_COOKIE = 'beacon_wx_state';
const MODE_COOKIE = 'beacon_wx_mode';
// 邀请码与「登录后回到哪一页」：微信授权要跳出站再回来，只能靠短命 cookie 带过去（5 分钟，同 state）
const REF_COOKIE = 'beacon_wx_ref';
const NEXT_COOKIE = 'beacon_wx_next';

export async function GET(req: NextRequest) {
  const { enabled } = getWechatConfig();
  if (!enabled) return NextResponse.json({ error: '微信登录未启用' }, { status: 503 });

  const ua = req.headers.get('user-agent') ?? '';
  const inWechat = /MicroMessenger/i.test(ua);

  const siteUrl = process.env.BEACON_SITE_URL || `${req.nextUrl.protocol}//${req.nextUrl.host}`;
  const redirectUri = `${siteUrl}/api/auth/wechat/callback`;

  const state = generateState();

  const authUrl = buildAuthUrl(redirectUri, state, inWechat);

  // mode=bind：已登录用户在设置页发起「绑定微信」。callback 据此把 openid
  // 写到当前登录账号（bindWechatToMember），而不是走登录/自动建号。
  const bindMode = req.nextUrl.searchParams.get('mode') === 'bind';

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: authCookieSecure(),
    path: '/',
    maxAge: 300,
  };
  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, state, cookieOpts);
  if (bindMode) res.cookies.set(MODE_COOKIE, 'bind', cookieOpts);
  else res.cookies.delete(MODE_COOKIE);
  const ref = normalizeReferralCode(req.nextUrl.searchParams.get('ref'));
  if (ref) res.cookies.set(REF_COOKIE, ref, cookieOpts);
  else res.cookies.delete(REF_COOKIE);
  const next = safeNextPath(req.nextUrl.searchParams.get('next'));
  if (next) res.cookies.set(NEXT_COOKIE, next, cookieOpts);
  else res.cookies.delete(NEXT_COOKIE);
  return res;
}
