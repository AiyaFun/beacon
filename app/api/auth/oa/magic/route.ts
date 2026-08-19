import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE_S, authCookieSecure } from '@/lib/auth-constants';
import { consumeOaLoginTicket } from '@/lib/auth/oa';
import { can } from '@/lib/edition';
import { checkRateLimit, getClientIp, ipKey } from '@/lib/ratelimit';
import { siteUrl } from '@/lib/site-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 一次性登录链接的落地端点：机器人私聊发来的 `?t=<票据>` 在这里换成会话 cookie。
//
// 为什么是 GET 而不是表单 POST：用户是在聊天软件里**点链接**过来的，那只能是 GET。
// 代价是票据会进浏览器历史，所以票据一次性 + 5 分钟过期 + 换到 cookie 后立刻 302 掉查询串
// （留在地址栏里会被截图/分享带走）。

const LIMIT = { limit: 30, windowMs: 600_000 };

export async function GET(req: NextRequest) {
  // 形态闸：SaaS 走短信/微信登录，没有这条通道。
  if (!can('oaLogin')) return new NextResponse('Not Found', { status: 404 });

  const rl = await checkRateLimit(ipKey('oa:magic', getClientIp(req.headers)), LIMIT);
  if (!rl.ok) return NextResponse.redirect(`${siteUrl()}/login?err=${encodeURIComponent('尝试过于频繁，请稍后再试')}`);

  const ticket = req.nextUrl.searchParams.get('t') ?? '';
  const r = await consumeOaLoginTicket(ticket, req.headers.get('user-agent') ?? undefined);
  if (!r.ok) {
    return NextResponse.redirect(`${siteUrl()}/login?err=${encodeURIComponent(r.message)}`);
  }

  // 302 到首页（不带任何查询串）——票据不能留在地址栏里。
  const res = NextResponse.redirect(siteUrl() + '/');
  res.cookies.set(AUTH_COOKIE, r.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: authCookieSecure(),
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_S,
  });
  return res;
}
