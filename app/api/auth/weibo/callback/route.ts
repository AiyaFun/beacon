import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { decryptKey } from '@/lib/crypto';
import { weiboExchangeToken, saveWeiboToken, WEIBO_STATE_COOKIE } from '@/lib/publish/weibo';
import { siteUrl } from '@/lib/site-url';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 微博授权第二步：拿 code 换 token 存库。
//
// ⚠️ 对外 302 一律用 BEACON_SITE_URL，**不要用 req.nextUrl**：宿主 nginx 反代后
// nextUrl 的 host 是容器内部地址（微信登录那次真机踩过，跳到了 https://0.0.0.0:3000）。
function back(q: string) {
  return NextResponse.redirect(`${siteUrl()}/settings/keys?weibo=${q}`);
}

export async function GET(req: NextRequest) {
  const s = await getSession();
  requireRole(s, 'byok.manage');

  const code = req.nextUrl.searchParams.get('code') ?? '';
  const state = req.nextUrl.searchParams.get('state') ?? '';
  const store = await cookies();
  const expect = store.get(WEIBO_STATE_COOKIE)?.value ?? '';
  store.delete(WEIBO_STATE_COOKIE); // 用完即焚，不管成不成功

  if (!code) return back('cancelled'); // 用户在微博那边点了取消
  if (!state || state !== expect) {
    log.warn('微博授权 state 不匹配', { hasState: !!state });
    return back('state-mismatch');
  }

  const cred = await prisma.publishCredential.findUnique({
    where: { accountId_platform: { accountId: s.accountId, platform: 'weibo' } },
  });
  if (!cred) return back('no-app');

  const r = await weiboExchangeToken(cred.appId, decryptKey(cred.appSecretEnc), code);
  if (!r.ok) {
    await prisma.publishCredential.update({
      where: { id: cred.id },
      data: { status: 'failed', lastError: r.error.slice(0, 300) },
    });
    return back('failed');
  }
  await saveWeiboToken(cred.id, r.token);
  return back('ok');
}
