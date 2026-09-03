import crypto from 'node:crypto';
import type { PushMessage, SendResult } from './types';

// 飞书 / Lark adapter。
//  出站：群自定义机器人 webhook（签名校验用 HmacSHA256）。
//  入站：事件订阅回调的验签（X-Lark-Signature）+ 解密（Encrypt Key / AES-256-CBC）+ 回消息（tenant_access_token）。
// 全部零第三方依赖，用 node:crypto + 全局 fetch。

const FETCH_TIMEOUT_MS = 8000;

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────── 出站：群自定义机器人 webhook ───────────────────────

// 飞书签名：stringToSign = `${timestamp}\n${secret}`，再以它为 HMAC key、空串为 data，SHA256 → base64。
export function feishuSign(secret: string, timestamp: number): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', stringToSign).update('').digest('base64');
}

// PushMessage → 飞书消息体。text 走 text；card 走 interactive（飞书卡片）。
export function feishuWebhookBody(message: PushMessage, secret?: string): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    base.timestamp = String(timestamp);
    base.sign = feishuSign(secret, timestamp);
  }
  if (message.kind === 'text') {
    return { ...base, msg_type: 'text', content: { text: message.text } };
  }
  // interactive 卡片
  const elements: unknown[] = message.lines.map((l) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: l },
  }));
  if (message.link) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: message.link.text },
          url: message.link.url,
          type: 'primary',
        },
      ],
    });
  }
  return {
    ...base,
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: message.title }, template: 'blue' },
      elements,
    },
  };
}

// 发送到 webhook。secret 为空时不带签名（用户没开签名校验的情况）。
export async function sendFeishuWebhook(url: string, secret: string | undefined, message: PushMessage): Promise<SendResult> {
  if (!url) return { ok: false, error: '未配置 webhook 地址' };
  try {
    const { status, json } = await postJson(url, feishuWebhookBody(message, secret));
    // 飞书成功：{ code:0 } 或旧格式 { StatusCode:0 }
    const code = json?.code ?? json?.StatusCode;
    if (status === 200 && (code === 0 || code === undefined)) return { ok: true };
    return { ok: false, error: json?.msg || json?.StatusMessage || `HTTP ${status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '发送失败' };
  }
}

// ─────────────────────── 入站：事件订阅验签 / 解密 / 回消息 ───────────────────────

// 事件回调验签：sha256hex(timestamp + nonce + encryptKey + rawBody) === X-Lark-Signature。
export function feishuVerifySignature(opts: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  rawBody: string;
  signature: string;
}): boolean {
  const h = crypto.createHash('sha256');
  h.update(opts.timestamp + opts.nonce + opts.encryptKey + opts.rawBody);
  const digest = h.digest('hex');
  // 定长比较防时序侧信道
  const a = Buffer.from(digest);
  const b = Buffer.from(opts.signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 事件解密（开了 Encrypt Key）：key=sha256(encryptKey)，data=base64(encrypt)，前 16B 为 IV，AES-256-CBC。
export function feishuDecrypt(encryptKey: string, encrypt: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const data = Buffer.from(encrypt, 'base64');
  const iv = data.subarray(0, 16);
  const ciphertext = data.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// 取 tenant_access_token（回消息、调开放接口用）。
// 返回 { token, error }：失败时带上飞书原文错误码/文案——否则用户只能看到「获取失败」猜不出原因。
export async function feishuTenantAccessToken(appId: string, appSecret: string): Promise<{ token: string | null; error?: string }> {
  try {
    const { json } = await postJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: appId,
      app_secret: appSecret,
    });
    if (json?.tenant_access_token) return { token: json.tenant_access_token };
    return { token: null, error: json?.msg ? `${json.msg}（code ${json.code}）` : '飞书未返回 token' };
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : '网络异常' };
  }
}

// 列出机器人加入的所有群聊（自建应用模式发消息前需要知道发到哪些群）。
// 需要 im:chat / im:chat:readonly 等群信息权限——缺权限时飞书报 99991672，
// 必须把它和「真的没进群」区分开，否则会误导用户一直去拉机器人进群。
export async function feishuListBotChats(token: string): Promise<{ chatIds: string[]; chats: { id: string; name: string }[]; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/chats?user_id_type=open_id', {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || json?.code !== 0) {
      const detail = json?.msg ? `${json.msg}（code ${json.code}）` : `HTTP ${res.status}`;
      return { chatIds: [], chats: [], error: detail };
    }
    // 名字一起带出来：渠道卡「机器人在哪些群」就靠这一份（消息事件里没有群名）
    const chats = (json?.data?.items ?? [])
      .filter((c: any) => c?.chat_id)
      .map((c: any) => ({ id: String(c.chat_id), name: String(c.name ?? '') }));
    return { chatIds: chats.map((c: { id: string }) => c.id), chats };
  } catch (e) {
    return { chatIds: [], chats: [], error: e instanceof Error ? e.message : '网络异常' };
  } finally {
    clearTimeout(t);
  }
}

// 机器人自己的 open_id。群里判断「这条消息是不是在 @ 我」要用它：
// mentions 里躺着的可能是别的同事，不核对就会在别人互相 @ 的时候插嘴。
//
// 进程内缓存 1 小时：这个值一个应用一辈子不变，每条消息都去问一次纯属浪费（还拖慢回复）。
const botOpenIdCache = new Map<string, { openId: string; at: number }>();
const BOT_INFO_TTL_MS = 3_600_000;

export async function feishuBotOpenId(token: string, appId: string, now = Date.now()): Promise<string | null> {
  const hit = botOpenIdCache.get(appId);
  if (hit && now - hit.at < BOT_INFO_TTL_MS) return hit.openId;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => null);
    const openId = json?.bot?.open_id;
    if (!openId) return null;
    botOpenIdCache.set(appId, { openId, at: now });
    return openId;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── 群里的 @ 闸 ──
//
// 群聊必须 @ 到机器人才应答。默认权限下飞书本来就只在被 @ 时推事件，但一旦应用申请了
// 「接收群聊中所有消息」，不设这道闸机器人会对群里每一句话都回一遍——那是能把它被踢出群的噪声。
// 单聊（chat_type='p2p'）不需要 @：说的每句话本来就是对它说的。

export type FeishuMention = { key?: string; id?: { open_id?: string }; name?: string };

/** 第一道（纯函数、零开销）：群消息里有没有任何 @。false = 直接忽略这条消息。 */
export function feishuPassesMentionGate(message: { chat_type?: string; mentions?: unknown }): boolean {
  if (message?.chat_type !== 'group') return true;
  return Array.isArray(message?.mentions) && message.mentions.length > 0;
}

/**
 * 第二道：这些 @ 里有没有机器人自己（群里 @ 的可能是别的同事，不核对就会在别人对话里插嘴）。
 * 取不到机器人 open_id（没配 App Secret / 接口失败）时返回 true：
 * 宁可多答一句，也不要因为一次网络抖动让 @它 的人以为机器人挂了。
 */
export async function feishuMentionsBot(
  mentions: FeishuMention[],
  appId: string,
  appSecret: string | undefined,
): Promise<boolean> {
  if (!appSecret) return true;
  const { token } = await feishuTenantAccessToken(appId, appSecret);
  if (!token) return true;
  const botOpenId = await feishuBotOpenId(token, appId);
  if (!botOpenId) return true;
  return mentions.some((m) => m.id?.open_id === botOpenId);
}

// 通过 OpenAPI 发送 PushMessage 到指定群（自建应用模式主动推送用；支持 text + interactive 卡片）。
/** 卡片/文本 → 飞书消息体（msg_type + content）。发送与编辑共用同一份，免得两处各画一版卡。 */
export function feishuMessageBody(message: PushMessage): { msgType: string; content: string } {
  if (message.kind === 'text') return { msgType: 'text', content: JSON.stringify({ text: message.text }) };
  const elements: unknown[] = message.lines.map((l) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: l },
  }));
  if (message.link) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: message.link.text },
        url: message.link.url,
        type: 'primary',
      }],
    });
  }
  return {
    msgType: 'interactive',
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: message.title }, template: 'blue' },
      elements,
    }),
  };
}

export async function feishuSendToChat(token: string, chatId: string, message: PushMessage): Promise<SendResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const { msgType, content } = feishuMessageBody(message);
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => null);
    // message_id 带回去：群里的任务进度卡靠它就地编辑（feishuUpdateCard）
    if (res.ok && json?.code === 0) return { ok: true, messageId: json?.data?.message_id || undefined };
    return { ok: false, error: json?.msg || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '发送失败' };
  } finally {
    clearTimeout(t);
  }
}

// 自建应用模式高层级推送：获取 token → 列群 → 逐群发送。
export async function sendFeishuApp(appId: string, appSecret: string, message: PushMessage): Promise<SendResult> {
  const { token, error: tokenErr } = await feishuTenantAccessToken(appId, appSecret);
  if (!token) {
    return { ok: false, error: `获取 tenant_access_token 失败：${tokenErr ?? ''}。请检查 App ID / App Secret，并确认已在飞书开放平台「应用功能」中启用「机器人」能力并发布版本` };
  }
  const { chatIds, error: chatsErr } = await feishuListBotChats(token);
  if (chatsErr) {
    // 权限没开是最常见原因（99991672 / permission denied），单独给可执行的指引
    const isPerm = /99991672|permission|权限/i.test(chatsErr);
    return {
      ok: false,
      error: isPerm
        ? `读取群列表被拒：${chatsErr}。请在飞书开放平台「权限管理」开通「获取群组信息」(im:chat:readonly)，然后重新发布版本`
        : `读取群列表失败：${chatsErr}`,
    };
  }
  if (chatIds.length === 0) return { ok: false, error: '机器人未加入任何群聊，请先将自建应用机器人添加到飞书群中' };
  let lastError = '';
  let sent = 0;
  for (const cid of chatIds) {
    const r = await feishuSendToChat(token, cid, message);
    if (r.ok) sent++;
    else lastError = r.error ?? '';
  }
  if (sent > 0) return { ok: true };
  return { ok: false, error: lastError || '发送失败' };
}

// 下载消息里的图片/文件资源。
// 注意路径要的是 message_id + file_key（image_key 只在「上传图片」接口里用），
// 群消息里的图片必须走这个接口取——直接拿 image_key 去图片接口会 403。
// 需要权限：im:resource（获取与上传图片或文件资源）。
export async function feishuDownloadResource(
  token: string,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file' = 'image',
): Promise<{ ok: true; data: Buffer; mime: string } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
    if (!res.ok) {
      // 失败时飞书回的是 JSON 错误体，不是二进制
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${detail.slice(0, 160)}` };
    }
    const mime = res.headers.get('content-type') ?? 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: '下载到空文件' };
    return { ok: true, data: buf, mime };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '下载失败' };
  } finally {
    clearTimeout(t);
  }
}

// 回复文本消息到指定会话（chatId）。用于 ChatOps 把执行结果发回群。
export async function feishuReplyText(token: string, chatId: string, text: string): Promise<SendResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => null);
    if (res.ok && json?.code === 0) return { ok: true };
    return { ok: false, error: json?.msg || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '回复失败' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 就地更新一张已发出的卡片（PATCH /im/v1/messages/:message_id，只对 interactive 卡有效）。
 * 群里派任务的进度卡用它：一条卡从「排队中」改到「正在跑 · 已走 N 步」再改到「跑完了」，
 * 而不是每一步都往群里丢一条新消息。
 */
export async function feishuUpdateCard(token: string, messageId: string, message: PushMessage): Promise<SendResult> {
  if (message.kind !== 'card') return { ok: false, error: '只有卡片能就地更新' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const { content } = feishuMessageBody(message);
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => null);
    if (res.ok && json?.code === 0) return { ok: true, messageId };
    return { ok: false, error: json?.msg || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '更新失败' };
  } finally {
    clearTimeout(t);
  }
}
