import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, bindWechatToMember, getMemberByToken, loginByWechat } from '@/lib/auth';
import { AUTH_COOKIE_MAX_AGE_S, authCookieSecure } from '@/lib/auth-constants';
import { isDemoTenant } from '@/lib/demo/guard';
import { exchangeCodeForToken, getWechatUserInfo } from '@/lib/wechat-auth';
import { log } from '@/lib/logger';

const STATE_COOKIE = 'beacon_wx_state';
const MODE_COOKIE = 'beacon_wx_mode';

// 反代后 req.nextUrl 是容器内部地址（0.0.0.0:3000），跳转必须用站点外部地址。
function siteBase(req: NextRequest): string {
  return process.env.BEACON_SITE_URL || `${req.nextUrl.protocol}//${req.nextUrl.host}`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const savedState = req.cookies.get(STATE_COOKIE)?.value;
  // 绑定模式由 redirect 路由发起时落 cookie（不能信 query：state cookie 才是防伪源）
  const bindMode = req.cookies.get(MODE_COOKIE)?.value === 'bind';

  if (!code || !state || !savedState || state !== savedState) {
    return bindMode
      ? redirectToSettings(req, { error: '微信授权失败，请重试' })
      : redirectToLogin(req, '微信授权失败，请重试');
  }

  try {
    const tokenResult = await exchangeCodeForToken(code);

    if (bindMode) {
      // 绑定：openid 归到当前登录账号，不建新号、不签发新会话。
      const current = await getMemberByToken(req.cookies.get(AUTH_COOKIE)?.value);
      if (!current) return redirectToLogin(req, '登录状态已失效，请先登录再绑定微信');
      if (isDemoTenant(current.tenantId)) {
        return redirectToSettings(req, { error: '演示账号不支持绑定，请注册后使用' });
      }
      const bind = await bindWechatToMember(current.memberId, tokenResult.openid);
      return redirectToSettings(req, bind.ok ? { ok: true } : { error: bind.message ?? '绑定失败，请重试' });
    }

    const userInfo = await getWechatUserInfo(tokenResult.access_token, tokenResult.openid);

    const ua = req.headers.get('user-agent') ?? undefined;
    const result = await loginByWechat(tokenResult.openid, userInfo.nickname, ua, true);

    if (!result.ok || !result.token) {
      return redirectToLogin(req, result.message ?? '登录失败');
    }

    const res = NextResponse.redirect(new URL('/', siteBase(req)));

    res.cookies.set(AUTH_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: authCookieSecure(),
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE_S,
    });
    clearFlowCookies(res);

    return res;
  } catch (err) {
    log.error('WeChat login callback error', { error: String(err) });
    return bindMode
      ? redirectToSettings(req, { error: '微信授权异常，请稍后重试' })
      : redirectToLogin(req, '微信登录异常，请稍后重试');
  }
}

function clearFlowCookies(res: NextResponse) {
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(MODE_COOKIE);
}

function redirectToLogin(req: NextRequest, message: string) {
  const url = new URL(`/login?wx_error=${encodeURIComponent(message)}`, siteBase(req));
  const res = NextResponse.redirect(url);
  clearFlowCookies(res);
  return res;
}

function redirectToSettings(req: NextRequest, outcome: { ok?: boolean; error?: string }) {
  const query = outcome.ok ? 'wx_bind=ok' : `wx_bind_error=${encodeURIComponent(outcome.error ?? '绑定失败')}`;
  const url = new URL(`/settings?${query}`, siteBase(req));
  const res = NextResponse.redirect(url);
  clearFlowCookies(res);
  return res;
}
