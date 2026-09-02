import crypto from 'node:crypto';
import { createLogger } from '../logger';
import { splitWechatText } from './wechat-text';

const log = createLogger({ module: 'bot-wechat-ilink' });

// 微信官方 iLink 机器人接口（2026-09-02）。
//
// 【这是什么】微信 2026 年面向智能体开放的**个人号机器人**接口（微信 ClawBot / OpenClaw 插件
// `@tencent-weixin/openclaw-weixin` 底下就是它），纯 HTTP/JSON，域名 ilinkai.weixin.qq.com。
// 用户在微信里扫一次码，机器人就成了他微信里的一个联系人；他给机器人发消息，这里收到并回复。
// Accio「微信 ClawBot · 扫码绑定」与 LightVela「微信 · 扫码授权连接」都是这一套——**不经企业微信**。
//
// 【四个动作】get_bot_qrcode（拿码）→ get_qrcode_status（等扫码，回 bot_token）
//           → getupdates（长轮询收消息，服务端最多 hold 35 秒）→ sendmessage（回复，必须带 context_token）。
//
// 【三条硬口径】
//   ① 只答不推：回复必须带入站消息的 context_token，没有「主动给用户发一条」这回事——
//      lib/bot/types.ts 把 wechat 列进 REPLY_ONLY_PROVIDERS，出站分发一律拒。
//   ② 一个 bot 只有一个收信者：getupdates 的游标 get_updates_buf 是**消费性**的，两个进程同时拉
//      同一个 token 会互相吞消息——长轮询只在 lib/bot/wechat-ilink-poller.ts 的监督者里跑，
//      SaaS 在 worker 进程、整机版在 web 进程（BEACON_QUEUE=local），不在请求处理里拉。
//   ③ ret=-14 = 登录态过期：清游标、标 expired、停轮询，等用户重新扫码。不重试——重试只会一直 -14。
//
// 【微信方的约束，原文】「我们保留决定哪些第三方 AI 服务可以接入、接入范围、消息发送规模或频率的权利，
// 并可能基于安全评估进行过滤、拦截或阻断。」——所以这条通道的可用性不由我们保证，界面上要说破。

export const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.2';
/** 单条文本上限约 2000 字符，留余量按 1500 拆段（拆段规则见 lib/bot/wechat-text.ts） */
export const ILINK_TEXT_MAX = 1500;
/** getupdates 服务端最多 hold 35 秒，客户端超时要比它长 */
const LONGPOLL_TIMEOUT_MS = 45_000;

function baseOf(base?: string): string {
  return (base || ILINK_BASE).replace(/\/+$/, '');
}

/** 每个请求都要带一个随机 uint32 的 base64（协议的防重放位） */
function uinHeader(): string {
  return Buffer.from(String(crypto.randomInt(0, 0xffffffff))).toString('base64');
}

function headersOf(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uinHeader(),
    'iLink-App-ClientVersion': '1',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function readJson<T>(res: Response): Promise<T | null> {
  try { return (await res.json()) as T; } catch { return null; }
}

// ── 扫码绑定 ─────────────────────────────────────────────────────────────────

export type IlinkQr = { ok: boolean; qrcode?: string; qrUrl?: string; error?: string };

/** 拿一张登录码。qrUrl 是微信能识别的 URL（自己编成二维码图），qrcode 是轮询状态用的键。 */
export async function ilinkGetQr(base?: string): Promise<IlinkQr> {
  try {
    const res = await fetch(`${baseOf(base)}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      headers: headersOf(),
      signal: AbortSignal.timeout(15_000),
    });
    const d = await readJson<{ qrcode?: string; qrcode_img_content?: string; errmsg?: string; ret?: number }>(res);
    if (!res.ok || !d) return { ok: false, error: `iLink 返回 HTTP ${res.status}` };
    if (!d.qrcode || !d.qrcode_img_content) return { ok: false, error: d.errmsg ?? 'iLink 没返回二维码' };
    return { ok: true, qrcode: d.qrcode, qrUrl: d.qrcode_img_content };
  } catch (e) {
    return { ok: false, error: `连不上微信 iLink：${(e as Error).message}` };
  }
}

export type IlinkQrStatus = 'wait' | 'scaned' | 'confirmed' | 'expired';
export type IlinkStatusResult = {
  ok: boolean;
  status?: IlinkQrStatus;
  botToken?: string;
  botId?: string;
  userId?: string;
  baseUrl?: string;
  error?: string;
};

/** 每次查状态最多等这么久：微信那头会 hold 到状态变化或约 35 秒，但一个 server action 挂 35 秒
 *  会撞上代理/RSC 的超时（实测 21 秒那次把页面打回了首页）。到点没变化就当 wait 让前端再来一轮。 */
export const QR_STATUS_WAIT_MS = 12_000;

/** 查扫码状态。到 timeoutMs 没变化 = 还在等（status: wait），不是错误——调用方按序 await，别再叠 setInterval。 */
export async function ilinkQrStatus(qrcode: string, base?: string, timeoutMs = QR_STATUS_WAIT_MS): Promise<IlinkStatusResult> {
  try {
    const res = await fetch(`${baseOf(base)}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      headers: headersOf(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const d = await readJson<{
      status?: string; bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; errmsg?: string;
    }>(res);
    if (!res.ok || !d) return { ok: false, error: `iLink 返回 HTTP ${res.status}` };
    const status = (d.status ?? 'wait') as IlinkQrStatus;
    if (status === 'confirmed' && !d.bot_token) return { ok: false, error: '已确认但 iLink 没下发 bot_token' };
    return { ok: true, status, botToken: d.bot_token, botId: d.ilink_bot_id, userId: d.ilink_user_id, baseUrl: d.baseurl };
  } catch (e) {
    const err = e as Error & { name?: string };
    // 超时 = 微信那头还在 hold，没变化。按协议这就是 wait，不能报成错误让前端放弃
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: true, status: 'wait' };
    return { ok: false, error: err.message };
  }
}

// ── 收发 ────────────────────────────────────────────────────────────────────

export type IlinkItem = { type: number; text_item?: { text?: string } };
export type IlinkMsg = {
  seq?: number;
  message_id?: number | string;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  /** 1=用户发来；2=机器人自己发的（回执）——处理它会自嗨 */
  message_type?: number;
  message_state?: number;
  item_list?: IlinkItem[];
  session_id?: string;
};

export type IlinkUpdates = {
  ok: boolean;
  msgs: IlinkMsg[];
  cursor?: string;
  /** ret=-14：登录态过期，必须重新扫码 */
  expired?: boolean;
  error?: string;
};

/** 长轮询收消息。cursor 首次传空串；返回的 cursor 必须**先落库再处理**（宁漏答不重放）。 */
export async function ilinkGetUpdates(base: string | undefined, token: string, cursor: string): Promise<IlinkUpdates> {
  try {
    const res = await fetch(`${baseOf(base)}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: headersOf(token),
      body: JSON.stringify({ get_updates_buf: cursor ?? '', base_info: { channel_version: CHANNEL_VERSION } }),
      signal: AbortSignal.timeout(LONGPOLL_TIMEOUT_MS),
    });
    const d = await readJson<{ ret?: number; errcode?: number; errmsg?: string; msgs?: IlinkMsg[]; get_updates_buf?: string }>(res);
    if (!d) return { ok: false, msgs: [], error: `iLink 返回 HTTP ${res.status}` };
    const ret = d.ret ?? d.errcode ?? 0;
    if (ret === -14) return { ok: false, msgs: [], expired: true, error: '登录态过期（ret=-14）' };
    if (ret !== 0) return { ok: false, msgs: [], error: `getupdates ${ret}: ${d.errmsg ?? ''}` };
    return { ok: true, msgs: d.msgs ?? [], cursor: d.get_updates_buf ?? cursor };
  } catch (e) {
    return { ok: false, msgs: [], error: (e as Error).message };
  }
}

/** 一条消息里的文字（多段 text_item 合并）。图片/语音/文件没有文字，返回空串。 */
export function ilinkTextOf(m: IlinkMsg): string {
  return (m.item_list ?? [])
    .filter((it) => it.type === 1)
    .map((it) => it.text_item?.text ?? '')
    .join('\n')
    .trim();
}

/**
 * 回文本。context_token 必须是入站那条消息带来的——没有它消息挂不到会话上，微信端不显示。
 * 超长拆段按序发，每段独立 client_id、共用 context_token；任一段失败即停。
 */
export async function ilinkSendText(
  base: string | undefined,
  token: string,
  toUserId: string,
  contextToken: string,
  text: string,
): Promise<{ ok: boolean; error?: string; parts?: number }> {
  const parts = splitWechatText(text, ILINK_TEXT_MAX);
  if (parts.length === 0) return { ok: true, parts: 0 };
  const stamp = Date.now();
  try {
    for (let i = 0; i < parts.length; i++) {
      const res = await fetch(`${baseOf(base)}/ilink/bot/sendmessage`, {
        method: 'POST',
        headers: headersOf(token),
        body: JSON.stringify({
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `beacon-${stamp}-${i}-${crypto.randomBytes(4).toString('hex')}`,
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [{ type: 1, text_item: { text: parts[i] } }],
          },
          base_info: { channel_version: CHANNEL_VERSION },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const d = await readJson<{ ret?: number; errcode?: number; errmsg?: string }>(res);
      const ret = d?.ret ?? d?.errcode ?? 0;
      if (!res.ok || ret !== 0) return { ok: false, error: `sendmessage ${res.status}${ret ? ` ret=${ret}` : ''}: ${d?.errmsg ?? ''}`.trim() };
    }
    return { ok: true, parts: parts.length };
  } catch (e) {
    log.warn('微信 iLink 回复失败', { err: e });
    return { ok: false, error: (e as Error).message };
  }
}
