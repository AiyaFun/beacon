import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl, generateState, getWechatConfig } from '@/lib/wechat-auth';

const STATE_COOKIE = 'beacon_wx_state';
const MODE_COOKIE = 'beacon_wx_mode';

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
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 300,
  };
  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, state, cookieOpts);
  if (bindMode) res.cookies.set(MODE_COOKIE, 'bind', cookieOpts);
  else res.cookies.delete(MODE_COOKIE);
  return res;
}
