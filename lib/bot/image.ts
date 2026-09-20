import type { BotProvider, BotSecrets, SendResult } from './types';
import { getWecomAccessToken } from './wecom';
import { feishuTenantAccessToken } from './feishu';
import { getDingtalkAccessToken } from './dingtalk';

// 机器人**发图**（2026-09-17）。
//
// ─────────────── 为什么单开一条路，不塞进 PushMessage ───────────────
// PushMessage（text | card）流过推送编排、体检、通知去重、各 provider 的 switch 十几处。
// 加一个 kind 意味着每一处都要改，而其中大半（推送事件、周报）永远不会发图。
// 发图目前只有一个用途：**把执行器卡住的那一页私发给派活的人**（登录二维码）。
// 所以它走自己的入口，用途一清二楚，也不会让别的链路多一个要处理的分支。
//
// ─────────────── 一条安全线：二维码就是凭证 ───────────────
// 平台的登录二维码扫一下就是**以他的身份登录**。所以这条路只做**私聊**：
// 收图的人必须是发起这次采集的那个人（由 lib/bot/login-help.ts 认定），
// 群聊接口在这里根本不提供——不给「顺手发到群里」留任何入口。
// 群里那条只会是一句文字：「需要登录，二维码已私发给你」。
//
// ─────────────── 能力边界（如实降级，不假装发出去了）───────────────
// 私聊必须走**自建应用**（飞书/企微/钉钉）或 Telegram 的 bot token：
// 群 webhook 只能往那一个群发、没有「发给某个人」的语义。
// 缺凭据时返回 unsupported，由上层改走文字 + 站内通知，并告诉用户缺什么。

export type BotImage = { data: Buffer; mime: string };

/** 上限 2MB：企微图片消息的硬限制，其余几家都比它宽，取最小的那个当统一口径 */
export const MAX_BOT_IMAGE_BYTES = 2 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20000;

export type DmImageInput = {
  provider: BotProvider | string;
  secrets: BotSecrets;
  /** 自建应用的「入站标识」：飞书=AppID，钉钉=AppKey，企微=CorpID（见 lib/bot/index.ts 的选路） */
  inboundKey: string | null;
  /** Telegram 的 webhook 地址里带着 bot token */
  webhookUrl: string | null;
  /** 收图的人在该 provider 里的 id（飞书 open_id / 企微 userid / 钉钉 userid / Telegram chat_id） */
  userId: string;
  image: BotImage;
  caption: string;
};

export type DmImageResult = SendResult & { unsupported?: boolean };

/**
 * 私聊发一张图。发不了就如实说为什么（unsupported=true 表示「这个配置法发不了图」，
 * 上层据此降级成文字，而不是当成一次网络失败去重试）。
 */
export async function dmImage(input: DmImageInput): Promise<DmImageResult> {
  if (!input.userId) return { ok: false, unsupported: true, error: '不知道该私发给谁（这次采集没有记录发起人的企业应用身份）' };
  if (input.image.data.length > MAX_BOT_IMAGE_BYTES) {
    return { ok: false, error: `图片 ${Math.round(input.image.data.length / 1024)}KB，超过 ${MAX_BOT_IMAGE_BYTES / 1024}KB 上限` };
  }
  const s = input.secrets;
  switch (input.provider as BotProvider) {
    case 'feishu': {
      if (!input.inboundKey || !s.appSecret) return { ok: false, unsupported: true, error: '飞书要配成自建应用（App ID + App Secret）才能私聊发图' };
      return feishuDmImage(input.inboundKey, s.appSecret, input.userId, input.image, input.caption);
    }
    case 'wecom': {
      if (!s.corpId || !s.appSecret || !s.agentId) return { ok: false, unsupported: true, error: '企业微信要配成自建应用（CorpID + Secret + AgentID）才能私聊发图' };
      return wecomDmImage(s.corpId, s.appSecret, s.agentId, input.userId, input.image, input.caption);
    }
    case 'dingtalk': {
      if (!input.inboundKey || !s.appSecret || !s.agentId) return { ok: false, unsupported: true, error: '钉钉要配成自建应用（AppKey + AppSecret + AgentId）才能私聊发图' };
      return dingtalkDmImage(input.inboundKey, s.appSecret, s.agentId, input.userId, input.image, input.caption);
    }
    case 'telegram': {
      const token = telegramTokenOf(input.webhookUrl);
      if (!token) return { ok: false, unsupported: true, error: 'Telegram 的 bot token 读不出来（webhook 地址里应包含 /botXXX）' };
      return telegramDmPhoto(token, input.userId, input.image, input.caption);
    }
    default:
      return { ok: false, unsupported: true, error: `${input.provider} 暂不支持私聊发图` };
  }
}

/**
 * 表单里的那个文件字段。
 *
 * 用 **Blob + 三参 append**（`append(name, blob, filename)`）而不是 `new File(...)`：
 * `File` 是 Node 20 才进全局的，而整机/私有化是用户自己装的 Node，18 上跑一样常见——
 * 那里 `new File` 直接 ReferenceError，而这条路只在「采集卡住、正等着救」时才跑，
 * 是最不该在那一刻才炸的地方。Blob 从 Node 18 就有。
 * 用 Uint8Array 而不是 Buffer 本身：避免 ArrayBufferLike 的类型分歧。
 */
function fileOf(image: BotImage, name = 'shot'): { blob: Blob; filename: string } {
  const ext = image.mime.includes('png') ? 'png' : image.mime.includes('webp') ? 'webp' : 'jpg';
  return { blob: new Blob([new Uint8Array(image.data)], { type: image.mime || 'image/jpeg' }), filename: `${name}.${ext}` };
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms = FETCH_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

// ── 飞书：上传 image_key → 发 msg_type=image 给 open_id ──
// 需要权限：im:resource（上传图片）与 im:message:send_as_bot。
export async function feishuDmImage(appId: string, appSecret: string, openId: string, image: BotImage, caption: string): Promise<DmImageResult> {
  const { token, error } = await feishuTenantAccessToken(appId, appSecret);
  if (!token) return { ok: false, error: `获取 tenant_access_token 失败：${error ?? ''}` };
  try {
    const key = await withTimeout(async (signal) => {
      const form = new FormData();
      form.append('image_type', 'message');
      const f = fileOf(image);
      form.append('image', f.blob, f.filename);
      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, signal,
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok || json?.code !== 0) throw new Error(json?.msg || `上传图片 HTTP ${res.status}`);
      return String(json?.data?.image_key ?? '');
    });
    if (!key) return { ok: false, error: '飞书没有返回 image_key' };
    // 先发说明文字，再发图：图在下面，用户一眼看到的是「这是干什么用的」
    if (caption) await feishuSendToOpenId(token, openId, 'text', JSON.stringify({ text: caption }));
    return feishuSendToOpenId(token, openId, 'image', JSON.stringify({ image_key: key }));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '飞书发图失败' };
  }
}

async function feishuSendToOpenId(token: string, openId: string, msgType: string, content: string): Promise<SendResult> {
  return withTimeout(async (signal) => {
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: openId, msg_type: msgType, content }),
      signal,
    });
    const json: any = await res.json().catch(() => null);
    if (res.ok && json?.code === 0) return { ok: true };
    return { ok: false, error: json?.msg || `HTTP ${res.status}` };
  });
}

// ── 企微：media/upload(type=image) 拿 media_id → msgtype=image 发给 touser ──
// ⚠️ 临时素材 media_id 只有 3 天有效期，但我们上传完立刻就发，不留存。
export async function wecomDmImage(corpId: string, secret: string, agentId: string, userId: string, image: BotImage, caption: string): Promise<DmImageResult> {
  const { token, error } = await getWecomAccessToken(corpId, secret);
  if (!token) return { ok: false, error: `获取企微 access_token 失败：${error ?? ''}` };
  try {
    const mediaId = await withTimeout(async (signal) => {
      const form = new FormData();
      const f = fileOf(image);
      form.append('media', f.blob, f.filename);
      const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`, {
        method: 'POST', body: form, signal,
      });
      const json: any = await res.json().catch(() => null);
      if (json?.errcode) throw new Error(`上传素材 ${json.errcode}: ${json.errmsg ?? ''}`);
      return String(json?.media_id ?? '');
    });
    if (!mediaId) return { ok: false, error: '企微没有返回 media_id' };
    const send = async (body: unknown) => withTimeout(async (signal) => {
      const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      });
      const json: any = await res.json().catch(() => null);
      if (json?.errcode) return { ok: false as const, error: `企微消息 ${json.errcode}: ${json.errmsg ?? ''}` };
      return { ok: true as const };
    });
    const agent = parseInt(agentId, 10);
    if (caption) await send({ touser: userId, msgtype: 'text', agentid: agent, text: { content: caption } });
    return send({ touser: userId, msgtype: 'image', agentid: agent, image: { media_id: mediaId } });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '企微发图失败' };
  }
}

// ── 钉钉：media/upload(type=image) 拿 media_id → 工作通知 msgtype=image ──
export async function dingtalkDmImage(appKey: string, appSecret: string, agentId: string, userId: string, image: BotImage, caption: string): Promise<DmImageResult> {
  const { token, error } = await getDingtalkAccessToken(appKey, appSecret);
  if (!token) return { ok: false, error: `获取钉钉 access_token 失败：${error ?? ''}` };
  try {
    const mediaId = await withTimeout(async (signal) => {
      const form = new FormData();
      form.append('type', 'image');
      const f = fileOf(image);
      form.append('media', f.blob, f.filename);
      const res = await fetch(`https://oapi.dingtalk.com/media/upload?access_token=${token}&type=image`, {
        method: 'POST', body: form, signal,
      });
      const json: any = await res.json().catch(() => null);
      if (json?.errcode) throw new Error(`上传素材 ${json.errcode}: ${json.errmsg ?? ''}`);
      return String(json?.media_id ?? '');
    });
    if (!mediaId) return { ok: false, error: '钉钉没有返回 media_id' };
    const send = async (msg: unknown) => withTimeout(async (signal) => {
      const res = await fetch(`https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, userid_list: userId, msg }),
        signal,
      });
      const json: any = await res.json().catch(() => null);
      if (json?.errcode) return { ok: false as const, error: `钉钉消息 ${json.errcode}: ${json.errmsg ?? ''}` };
      return { ok: true as const };
    });
    if (caption) await send({ msgtype: 'text', text: { content: caption } });
    return send({ msgtype: 'image', image: { media_id: mediaId } });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '钉钉发图失败' };
  }
}

/** Telegram 的 webhook 地址形如 https://api.telegram.org/bot<token>/sendMessage */
export function telegramTokenOf(webhookUrl: string | null | undefined): string | null {
  const m = /\/bot([^/]+)\//.exec(webhookUrl ?? '');
  return m ? m[1] : null;
}

export async function telegramDmPhoto(botToken: string, chatId: string, image: BotImage, caption: string): Promise<DmImageResult> {
  try {
    return await withTimeout(async (signal) => {
      const form = new FormData();
      form.append('chat_id', chatId);
      if (caption) form.append('caption', caption.slice(0, 1000));
      const f = fileOf(image);
      form.append('photo', f.blob, f.filename);
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form, signal });
      const json: any = await res.json().catch(() => null);
      if (res.ok && json?.ok) return { ok: true };
      return { ok: false, error: json?.description || `HTTP ${res.status}` };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Telegram 发图失败' };
  }
}
