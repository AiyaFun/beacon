import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { can } from '@/lib/edition';
import { authCookieSecure } from '@/lib/auth-constants';
import { siteUrl } from '@/lib/site-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'beacon_oa_state';

// 发起飞书网页授权。私有化版用（整机版走私聊机器人，见 lib/auth/oa.ts 文件头）。
//
// state 形如 `<32位随机>` 或 `<32位随机>.<邀请码>`：随机段用于回跳时比对防 CSRF，
// 邀请码段让「点邀请链接 → 授权 → 直接加入」一次走完。
// 邀请码放在 state 里而不是单独的 query，是因为**只有** state 会被原样带回来。
export async function GET(req: NextRequest) {
  if (!can('oaLogin')) return new NextResponse('Not Found', { status: 404 });

  const integration = await prisma.botIntegration.findFirst({
    where: { provider: 'feishu', enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { inboundKey: true },
  });
  if (!integration?.inboundKey) {
    return NextResponse.redirect(`${siteUrl()}/login?err=${encodeURIComponent('这台实例还没有配置飞书企业应用')}`);
  }

  const invite = (req.nextUrl.searchParams.get('invite') ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const state = crypto.randomBytes(16).toString('hex') + (invite ? `.${invite}` : '');
  const redirectUri = `${siteUrl()}/api/auth/oa/feishu/callback`;

  const authUrl =
    'https://open.feishu.cn/open-apis/authen/v1/authorize' +
    `?app_id=${encodeURIComponent(integration.inboundKey)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: authCookieSecure(),
    path: '/',
    maxAge: 600, // 10 分钟够走完授权；留太久等于给 CSRF 更大的窗口
  });
  return res;
}
