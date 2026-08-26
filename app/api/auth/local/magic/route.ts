import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, AUTH_COOKIE_MAX_AGE_S, authCookieSecure } from '@/lib/auth-constants';
import { consumeLocalLoginTicket } from '@/lib/auth/local-link';
import { edition } from '@/lib/edition';
import { checkRateLimit, getClientIp, ipKey } from '@/lib/ratelimit';
import { siteUrl } from '@/lib/site-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 本机一次性登录链接的落地端点：管理员生成的 `?t=<票据>` 在这里换成会话 cookie。
//
// 与 /api/auth/oa/magic 是同一套形状（GET + 一次性票据 + 5 分钟过期 + 换到 cookie 后
// 立刻 302 掉查询串），区别只在票据是**管理员在网页里生成的**，而不是机器人发的。
//
// 【形态闸：SaaS 上这条路不存在】SaaS 有短信与微信登录，不需要它；
// 而多开一条「拿到链接就能进」的通道，就是多一个可以被钓鱼的入口。
// 企业版（appliance / private）才有——那里客户可能压根没配企业应用机器人。

/**
 * 一次性登录链接的落地跳转**必须相对于「用户实际访问的那个地址」**，不能用 siteUrl()。
 *
 * 【真机撞到的】整机版安装脚本写的是 `BEACON_SITE_URL=http://localhost:<端口>`。
 * 装机那台机器上的人没事——localhost 就是他自己。但**局域网上的同事**
 * 打开 `http://192.168.1.20:3070/api/auth/local/magic?t=…` 之后会被 302 到
 * `http://localhost:3070`，那是**他自己的电脑**，上面没有烽火台。
 * 而企业版里这条链接是唯一的登录通道——等于除装机者外没人登得进来。
 *
 * 【为什么用 req.url 是安全的】它只把用户送回**他自己刚刚访问过的那个源**上的一个路径，
 * 不引入任何新的跳转目标。真正需要用配置地址的是微信/微博那种
 * 「回调地址必须与平台后台登记的一致」的 OAuth，那几条不动。
 */
const LIMIT = { limit: 30, windowMs: 600_000 };

export async function GET(req: NextRequest) {
  if (edition() === 'saas') return new NextResponse('Not Found', { status: 404 });

  const rl = await checkRateLimit(ipKey('local:magic', getClientIp(req.headers)), LIMIT);
  if (!rl.ok) {
    return NextResponse.redirect(new URL(`/login?err=${encodeURIComponent('尝试过于频繁，请稍后再试')}`, req.url));
  }

  const ticket = req.nextUrl.searchParams.get('t') ?? '';
  const r = await consumeLocalLoginTicket(ticket, req.headers.get('user-agent') ?? undefined);
  if (!r.ok) {
    return NextResponse.redirect(new URL(`/login?err=${encodeURIComponent(r.message)}`, req.url));
  }

  // 302 到首页且**不带任何查询串**——票据留在地址栏里会被截图或分享带走
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set(AUTH_COOKIE, r.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: authCookieSecure(),
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_S,
  });
  return res;
}
