import { decryptKey } from '../crypto';
import { prisma } from '../db';
import { readMediaDataUri } from '../media/store';
import { createLogger } from '../logger';

const log = createLogger({ module: 'wechat-mp' });

// ── 微信公众号官方接口（图文草稿箱 / 发布）───────────────────────────────────
//
// 【为什么默认只到草稿箱】群发（freepublish/submit）是**不可撤销**的对外动作，
// 订阅号每天只有一次群发机会。替用户按下那个按钮，一旦内容有问题，他今天就没有第二次了。
// 所以默认写进草稿箱，界面上另给一个显式开关（默认关）让用户选择是否一并提交发布。
//
// 【常见失败都要翻成人话】这条链路上 90% 的失败是两件事：IP 不在白名单（40164）、
// 凭证不对（40001/40125）。原样把 errcode 抛给用户等于让他自己去搜，必须翻译。

const API = 'https://api.weixin.qq.com';

export type WxError = { ok: false; error: string; code?: number };
export type WxOk<T> = { ok: true } & T;
export type WxResult<T> = WxOk<T> | WxError;

// access_token 有效期 7200s，且**同一个 appId 全局唯一**：频繁刷新会把上一枚顶掉，
// 让另一处正在用的调用突然失效。所以按 appId 缓存并提前 5 分钟过期。
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function resetWxTokenCache(): void {
  tokenCache.clear();
}

function humanizeWxError(errcode: number | undefined, errmsg: string | undefined): string {
  switch (errcode) {
    case 40164:
      return '公众号拒绝了这次调用：服务器 IP 不在白名单里。到公众号后台「设置与开发 → 基本配置 → IP 白名单」把服务器出口 IP 加进去。';
    case 40001:
    case 40125:
      return 'AppSecret 不对（或刚重置过）。到公众号后台重新复制一次，在「设置 · 发布通道」更新。';
    case 40013:
      return 'AppID 不对，检查是不是填成了开放平台/小程序的 AppID。';
    case 45009:
      return '公众号接口调用被限频了，等一会儿再试。';
    case 48001:
      return '这个公众号没有这项接口权限（未认证的订阅号拿不到草稿箱/发布接口）。';
    case 53400:
      return '发布被拒：内容里可能有平台不允许的元素（外链、诱导关注等），改完再发。';
    default:
      return `公众号接口返回错误 ${errcode ?? '未知'}：${errmsg ?? ''}`.trim();
  }
}

async function wxJson<T>(url: string, init?: RequestInit): Promise<WxResult<T>> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const data = (await res.json()) as { errcode?: number; errmsg?: string } & T;
    // 微信的成功响应有的带 errcode:0，有的干脆不带这个字段，两种都算成功
    if (data.errcode && data.errcode !== 0) {
      return { ok: false, error: humanizeWxError(data.errcode, data.errmsg), code: data.errcode };
    }
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: `连不上公众号接口：${(err as Error).message.slice(0, 120)}` };
  }
}

export async function wxAccessToken(appId: string, appSecret: string, now = Date.now()): Promise<WxResult<{ token: string }>> {
  const hit = tokenCache.get(appId);
  if (hit && hit.expiresAt > now) return { ok: true, token: hit.token };

  const r = await wxJson<{ access_token?: string; expires_in?: number }>(
    `${API}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`,
  );
  if (!r.ok) return r;
  if (!r.access_token) return { ok: false, error: '公众号没有返回 access_token' };
  tokenCache.set(appId, { token: r.access_token, expiresAt: now + ((r.expires_in ?? 7200) - 300) * 1000 });
  return { ok: true, token: r.access_token };
}

/** 纯文本正文 → 公众号能接受的 HTML。编辑器是纯文本（这是项目既定契约），这里只做最小转换。 */
export function textToWxHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
}

/** 摘要：公众号 digest 上限 120 字，超了会被截断，不如自己截干净。 */
export function wxDigest(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 上传封面为永久图片素材，拿 thumb_media_id（公众号图文必须有封面图）。 */
async function uploadThumb(token: string, workspaceId: string, assetId: string): Promise<WxResult<{ mediaId: string }>> {
  // 带 workspaceId 读：素材读取本身就按工作区过滤，绕过去等于允许跨租户拿别人的封面
  const dataUri = await readMediaDataUri(workspaceId, assetId).catch(() => null);
  if (!dataUri) return { ok: false, error: '封面图读不出来（可能已过保留期），请重新生成或换一张' };
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!m) return { ok: false, error: '封面图格式不对' };
  const [, mime, b64] = m;
  const bytes = Buffer.from(b64, 'base64');

  const form = new FormData();
  form.append('media', new Blob([bytes], { type: mime }), `cover.${mime.includes('png') ? 'png' : 'jpg'}`);
  const r = await wxJson<{ media_id?: string }>(
    `${API}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    { method: 'POST', body: form },
  );
  if (!r.ok) return r;
  if (!r.media_id) return { ok: false, error: '公众号没有返回素材 media_id' };
  return { ok: true, mediaId: r.media_id };
}

export type WxPublishInput = {
  workspaceId: string;
  accountId: string;
  title: string;
  content: string;
  /** 封面 MediaAsset id。公众号图文必须有封面，没有就没法发。 */
  coverAssetId?: string | null;
  author?: string;
  /** 是否在写进草稿箱后**立即提交发布**。默认 false —— 群发不可撤销。 */
  submitToPublish?: boolean;
};

export type WxPublishOutcome = {
  /** 草稿 media_id（公众号后台里能按它找到这篇） */
  mediaId: string;
  /** 提交发布后的任务 id（没提交则为 null） */
  publishId: string | null;
};

/**
 * 把一篇稿子写进公众号草稿箱（可选一并提交发布）。
 *
 * 没配凭证 / 凭证失效 → 如实返回错误，**绝不静默降级成「已发布」**。
 */
export async function publishToWechat(input: WxPublishInput): Promise<WxResult<WxPublishOutcome>> {
  const cred = await prisma.publishCredential.findUnique({
    where: { accountId_platform: { accountId: input.accountId, platform: 'wechat' } },
  });
  if (!cred) {
    return { ok: false, error: '这个账号还没配置公众号接口凭证。到「设置 · 发布通道」填 AppID / AppSecret。' };
  }
  const secret = decryptKey(cred.appSecretEnc);
  const tokenRes = await wxAccessToken(cred.appId, secret);
  if (!tokenRes.ok) {
    await prisma.publishCredential.update({
      where: { id: cred.id },
      data: { status: 'failed', lastError: tokenRes.error.slice(0, 300) },
    });
    return tokenRes;
  }
  const token = tokenRes.token;

  if (!input.coverAssetId) {
    return { ok: false, error: '公众号图文必须有封面图。先在「标题与封面」里生成或上传一张再发。' };
  }
  const thumb = await uploadThumb(token, input.workspaceId, input.coverAssetId);
  if (!thumb.ok) return thumb;

  const draftRes = await wxJson<{ media_id?: string }>(
    `${API}/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        articles: [
          {
            title: input.title.slice(0, 64),
            author: (input.author ?? '').slice(0, 8),
            digest: wxDigest(input.content),
            content: textToWxHtml(input.content),
            thumb_media_id: thumb.mediaId,
            need_open_comment: 1,
            only_fans_can_comment: 0,
          },
        ],
      }),
    },
  );
  if (!draftRes.ok) return draftRes;
  if (!draftRes.media_id) return { ok: false, error: '公众号没有返回草稿 media_id' };

  await prisma.publishCredential.update({ where: { id: cred.id }, data: { status: 'ok', lastError: null } });

  if (!input.submitToPublish) {
    return { ok: true, mediaId: draftRes.media_id, publishId: null };
  }

  const pub = await wxJson<{ publish_id?: string }>(
    `${API}/cgi-bin/freepublish/submit?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: draftRes.media_id }),
    },
  );
  if (!pub.ok) {
    // 草稿已经进去了，只是群发没成功——必须把这个区别说清楚，否则用户会以为整件事都失败了，
    // 于是再发一次，公众号后台里就多了一篇重复草稿。
    log.warn('公众号草稿已建但提交发布失败', { error: pub.error });
    return { ok: false, error: `草稿已经写进公众号后台了，但提交群发失败：${pub.error}` };
  }
  return { ok: true, mediaId: draftRes.media_id, publishId: pub.publish_id ?? null };
}
