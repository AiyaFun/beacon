import crypto from 'node:crypto';

// 微信开放平台 OAuth 登录。
// 支持两种场景：PC 浏览器（QR 扫码）和微信内置浏览器（静默/授权登录）。

const OAUTH_QR_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const OAUTH_MP_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize';
const TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const USERINFO_URL = 'https://api.weixin.qq.com/sns/userinfo';

export function getWechatConfig() {
  const appId = process.env.BEACON_WECHAT_APPID ?? '';
  const secret = process.env.BEACON_WECHAT_SECRET ?? '';
  return { appId, secret, enabled: !!(appId && secret) };
}

export function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function buildAuthUrl(redirectUri: string, state: string, inWechat: boolean): string {
  const { appId } = getWechatConfig();
  const base = inWechat ? OAUTH_MP_URL : OAUTH_QR_URL;
  const scope = inWechat ? 'snsapi_userinfo' : 'snsapi_login';
  const params = new URLSearchParams({
    appid: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
  });
  return `${base}?${params.toString()}#wechat_redirect`;
}

export type WechatTokenResult = {
  access_token: string;
  openid: string;
  unionid?: string;
};

export async function exchangeCodeForToken(code: string): Promise<WechatTokenResult> {
  const { appId, secret } = getWechatConfig();
  const params = new URLSearchParams({
    appid: appId,
    secret,
    code,
    grant_type: 'authorization_code',
  });
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`);
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`WeChat token error: ${data.errcode} ${data.errmsg}`);
  }
  return { access_token: data.access_token, openid: data.openid, unionid: data.unionid };
}

export type WechatUserInfo = {
  openid: string;
  nickname: string;
  headimgurl: string;
  unionid?: string;
};

export async function getWechatUserInfo(accessToken: string, openid: string): Promise<WechatUserInfo> {
  const params = new URLSearchParams({ access_token: accessToken, openid, lang: 'zh_CN' });
  const res = await fetch(`${USERINFO_URL}?${params.toString()}`);
  const data = await res.json();
  if (data.errcode) {
    throw new Error(`WeChat userinfo error: ${data.errcode} ${data.errmsg}`);
  }
  return { openid: data.openid, nickname: data.nickname, headimgurl: data.headimgurl, unionid: data.unionid };
}
