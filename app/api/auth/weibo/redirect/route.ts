import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { weiboAuthorizeUrl, WEIBO_STATE_COOKIE } from '@/lib/publish/weibo';
import { siteUrl } from '@/lib/site-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 微博授权第一步：把用户送去微博的授权页。
//
// state 走 httpOnly cookie 比对（与公众号绑定那条路同款）：防的是别人拿一个 code 打我们的回调，
// 把**他的**微博绑到你的账号上。用完即焚。

export async function GET() {
  const s = await getSession();
  requireRole(s, 'byok.manage'); // 配发布凭证与配模型 Key 同权限：都是工作区级的接入配置

  const cred = await prisma.publishCredential.findUnique({
    where: { accountId_platform: { accountId: s.accountId, platform: 'weibo' } },
    select: { appId: true },
  });
  if (!cred?.appId) {
    // 没填 AppKey 就没什么可授权的。回设置页并说清楚，而不是把用户丢到微博的报错页
    return NextResponse.redirect(`${siteUrl()}/settings/keys?weibo=no-app`);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const store = await cookies();
  store.set(WEIBO_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: siteUrl().startsWith('https://'),
    path: '/',
    maxAge: 600, // 10 分钟够走完授权；久了就是白留一张票
  });
  return NextResponse.redirect(weiboAuthorizeUrl(cred.appId, state));
}
