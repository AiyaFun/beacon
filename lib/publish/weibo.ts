import { decryptKey, encryptKey } from '../crypto';
import { prisma } from '../db';
import { readMediaBytes } from '../media/store';
import { createLogger } from '../logger';
import { siteUrl } from '../site-url';
import { WEIBO_MAX_CHARS } from './capability';

const log = createLogger({ module: 'weibo-publish' });

// ── 微博官方接口直发（statuses/share）────────────────────────────────────────
//
// 【为什么是这个接口】微博是大陆这批平台里**唯一**有个人开发者拿得到的发布接口：
// statuses/share 标着「访问级别：普通接口」，个人应用建完就能调。
// 老的 statuses/update（纯发博文、无链接要求）早就收进高级权限，个人申请不到，别去试。
//
// 【微博定的三条硬规则，我们只能如实传达，不能绕】
//   ① 正文 ≤140 个汉字；
//   ② 单张配图（pic，≤5M）；
//   ③ **正文里必须包含一条「你自己应用绑定域名」下的链接**，否则微博直接拒。
// 第③条是这条链路最反直觉的地方：它意味着每条微博都会带一条链接。所以回链地址由用户自己填
// （PublishCredential.linkUrl），我们不塞自己的域名进去——那等于拿用户的微博给我们打广告。
//
// 【授权链路】OAuth2：/oauth2/authorize → code → /oauth2/access_token → access_token(+uid)。
// token 有有效期，过期只能重新授权（微博个人应用没有 refresh_token）。
// 回调地址固定是本站的 /api/auth/weibo/callback，用户要把它填进自己应用的「授权回调页」。

const API = 'https://api.weibo.com';
const OAUTH = 'https://api.weibo.com/oauth2';

export type WbError = { ok: false; error: string; code?: number };
export type WbResult<T> = ({ ok: true } & T) | WbError;

// 正文上限定义在 capability.ts（client-safe），这里只 re-export，保持调用方两边都能取
export { WEIBO_MAX_CHARS } from './capability';

/**
 * 授权 state 的 cookie 名。
 *
 * 放在这里而不是 route.ts：Next 的 route 文件只允许导出 HTTP 方法与几个约定配置，
 * 顺手导出个常量会在构建期被拦（本项目在机器人回调那条路上踩过一次）。
 */
export const WEIBO_STATE_COOKIE = 'beacon_weibo_state';

export function weiboRedirectUri(): string {
  return `${siteUrl()}/api/auth/weibo/callback`;
}

export function weiboAuthorizeUrl(appKey: string, state: string): string {
  const p = new URLSearchParams({
    client_id: appKey,
    redirect_uri: weiboRedirectUri(),
    response_type: 'code',
    state,
    // 只要发博文这一项权限。多要一项就是多一份用户要担的心事。
    scope: 'statuses_update',
  });
  return `${OAUTH}/authorize?${p.toString()}`;
}

function humanizeWbError(code: number | undefined, msg: string | undefined): string {
  // 微博的错误码是「大类_子码」两级，这里只翻译真正会撞上的那几个。
  switch (code) {
    case 21327:
    case 21332:
      return '微博授权已过期，需要重新授权（微博个人应用没有自动续期，过期只能再点一次「授权」）。';
    case 21315:
    case 21314:
      return '微博的 AppKey / AppSecret 不对，或这个应用没通过审核。到微博开放平台核对一遍。';
    case 20019:
      return '微博拒绝了：这条内容与你刚发过的重复。改几个字再发。';
    case 20016:
    case 20017:
      return '发博太频繁，被微博限流了。等一会儿再试。';
    case 20032:
      return '微博拒绝了这条链接：正文里的链接必须是你应用「安全域名」下的地址。到微博开放平台核对安全域名，或改一下回链地址。';
    case 10023:
      return '这个应用的接口调用次数用完了（微博按应用给日配额）。明天再试，或到开放平台申请提额。';
    default:
      return `微博接口返回错误 ${code ?? '未知'}：${msg ?? ''}`.trim();
  }
}

async function wbFetch<T>(url: string, init?: RequestInit): Promise<WbResult<T>> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const data = (await res.json()) as { error?: string; error_code?: number } & T;
    if (data.error_code || data.error) {
      return { ok: false, error: humanizeWbError(data.error_code, data.error), code: data.error_code };
    }
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: `连不上微博接口：${(err as Error).message.slice(0, 120)}` };
  }
}

export type WeiboToken = { accessToken: string; expiresAt: Date; uid: string };

/** 用授权码换 token。**只在 OAuth 回调里调**。 */
export async function weiboExchangeToken(
  appKey: string,
  appSecret: string,
  code: string,
  now = Date.now(),
): Promise<WbResult<{ token: WeiboToken }>> {
  const body = new URLSearchParams({
    client_id: appKey,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: weiboRedirectUri(),
    code,
  });
  const r = await wbFetch<{ access_token?: string; expires_in?: number; uid?: string }>(
    `${OAUTH}/access_token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
  );
  if (!r.ok) return r;
  if (!r.access_token) return { ok: false, error: '微博没有返回 access_token（检查回调地址与应用配置是否一致）' };
  return {
    ok: true,
    token: {
      accessToken: r.access_token,
      // 微博给的是剩余秒数；缺省按 30 天算（个人应用的常见有效期），宁可早提示重授权也不晚
      expiresAt: new Date(now + (r.expires_in ?? 30 * 86_400) * 1000),
      uid: r.uid ?? '',
    },
  };
}

/** 正文整形：截到上限并把回链接在末尾。回链是微博的硬要求，不是我们加的营销链接。 */
export function composeWeiboText(content: string, linkUrl: string, max = WEIBO_MAX_CHARS): string {
  const link = (linkUrl ?? '').trim();
  const body = content.replace(/\s+/g, ' ').trim();
  const room = Math.max(0, max - (link ? link.length + 1 : 0));
  const head = body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body;
  return link ? `${head} ${link}`.trim() : head;
}

export type WeiboPublishInput = {
  workspaceId: string;
  accountId: string;
  content: string;
  /** 配图（MediaAsset id）。微博 share 只收一张，多的我们不偷偷丢——调用方只传一张。 */
  coverAssetId?: string | null;
  /** 调用方 IP。微博要求带真实用户 IP（rip），拿不到就不传，微博会按服务端 IP 记。 */
  ip?: string | null;
};

/**
 * 发一条微博。
 *
 * 没配凭证 / 没授权 / token 过期 → 如实返回错误，**绝不静默降级成「已发布」**。
 */
export async function publishToWeibo(
  input: WeiboPublishInput,
  now = Date.now(),
): Promise<WbResult<{ mid: string; url: string | null }>> {
  const cred = await prisma.publishCredential.findUnique({
    where: { accountId_platform: { accountId: input.accountId, platform: 'weibo' } },
  });
  if (!cred) {
    return { ok: false, error: '这个账号还没配置微博接口凭证。到「接入与密钥 · 发布通道」填 AppKey / AppSecret。' };
  }
  if (!cred.tokenEnc) {
    return { ok: false, error: '还没有授权微博账号。到「接入与密钥 · 发布通道」点一次「授权微博」。' };
  }
  if (cred.tokenExpiresAt && cred.tokenExpiresAt.getTime() <= now) {
    return { ok: false, error: '微博授权已过期，需要重新授权（微博个人应用不支持自动续期）。' };
  }
  if (!cred.linkUrl) {
    return {
      ok: false,
      error:
        '微博要求正文里必须带一条你「安全域名」下的链接（这是微博的规则）。到「接入与密钥 · 发布通道」把回链地址填上再发。',
    };
  }

  const token = decryptKey(cred.tokenEnc);
  const status = composeWeiboText(input.content, cred.linkUrl);

  const form = new FormData();
  form.append('access_token', token);
  form.append('status', status);
  if (input.ip) form.append('rip', input.ip);
  if (input.coverAssetId) {
    const pic = await readMediaBytes(input.workspaceId, input.coverAssetId).catch(() => null);
    if (pic) {
      form.append('pic', new Blob([pic.bytes], { type: pic.mime }), 'cover.jpg');
    }
  }

  const r = await wbFetch<{ id?: number; idstr?: string; mid?: string; user?: { profile_url?: string } }>(
    `${API}/2/statuses/share.json`,
    { method: 'POST', body: form },
  );
  if (!r.ok) {
    await prisma.publishCredential.update({
      where: { id: cred.id },
      data: { status: 'failed', lastError: r.error.slice(0, 300) },
    });
    return r;
  }
  const mid = r.mid ?? r.idstr ?? (r.id != null ? String(r.id) : '');
  if (!mid) {
    log.warn('微博返回里没有博文 id', {});
    return { ok: false, error: '微博没有返回博文 ID（内容可能已经发出去了，去微博确认一下再决定要不要重发）' };
  }
  await prisma.publishCredential.update({ where: { id: cred.id }, data: { status: 'ok', lastError: null } });
  return { ok: true, mid, url: `https://weibo.com/detail/${mid}` };
}

/** 存 token（授权回调用）。token 与 AppSecret 同等对待：加密落库。 */
export async function saveWeiboToken(credId: string, token: WeiboToken): Promise<void> {
  await prisma.publishCredential.update({
    where: { id: credId },
    data: {
      tokenEnc: encryptKey(token.accessToken),
      tokenExpiresAt: token.expiresAt,
      externalUid: token.uid || null,
      status: 'ok',
      lastError: null,
    },
  });
}
