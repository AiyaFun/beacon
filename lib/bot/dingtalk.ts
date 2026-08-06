import crypto from 'crypto';
import type { PushMessage, SendResult } from './types';

// 钉钉适配器：群自定义机器人 webhook + 企业内部应用（工作通知）。
// webhook 文档：https://open.dingtalk.com/document/robots/custom-robot-access
// 工作通知文档：https://open.dingtalk.com/document/orgapp/asynchronous-sending-of-enterprise-session-messages

const FETCH_TIMEOUT_MS = 8000;

function buildDingtalkBody(message: PushMessage): unknown {
  if (message.kind === 'text') {
    return { msgtype: 'text', text: { content: message.text } };
  }
  const lines = message.lines.map((l) => `- ${l}`).join('\n');
  let mdText = `### ${message.title}\n\n${lines}`;
  if (message.link) {
    mdText += `\n\n[${message.link.text}](${message.link.url})`;
  }
  return { msgtype: 'markdown', markdown: { title: message.title, text: mdText } };
}

// 剥掉入站文本开头连续的「@昵称 」。
// 钉钉群机器人只在被 @ 时回调，但 content 里会留下 @ 的原文；不剥掉的话
// 「@烽火台 /热点」会被当成普通文本收录成选题（斜杠命令必须顶格）。
// 昵称里不含空格，以空白收尾即可切干净。
export function stripDingtalkAtPrefix(raw: string): string {
  let t = (raw ?? '').trim();
  while (/^@[^\s@]+\s+/.test(t)) t = t.replace(/^@[^\s@]+\s+/, '').trim();
  return t;
}

// ── 自建应用：获取 access_token（旧版 API，工作通知需要）──
export async function getDingtalkAccessToken(appKey: string, appSecret: string): Promise<{ token: string | null; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`, { signal: ctrl.signal });
    const data = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) return { token: null, error: data.errmsg ?? `errcode ${data.errcode}` };
    return { token: data.access_token ?? null };
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : '网络异常' };
  } finally {
    clearTimeout(t);
  }
}

// ── 自建应用：通过工作通知 API 发送消息到全员 ──
export async function sendDingtalkApp(appKey: string, appSecret: string, agentId: string, message: PushMessage): Promise<SendResult> {
  const { token, error: tokenErr } = await getDingtalkAccessToken(appKey, appSecret);
  if (!token) return { ok: false, error: `获取钉钉 access_token 失败：${tokenErr || '请检查 AppKey 和 AppSecret'}` };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, to_all_user: true, msg: buildDingtalkBody(message) }),
      signal: ctrl.signal,
    });
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) return { ok: false, error: `钉钉工作通知失败 ${data.errcode}: ${data.errmsg ?? ''}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '发送失败' };
  } finally {
    clearTimeout(t);
  }
}

// ── 入站：机器人回调签名验证（HMAC-SHA256）──
// 钉钉机器人 outgoing webhook 在 header 带 timestamp+sign，用 appSecret 验。
export function dingtalkVerifySign(timestamp: string, appSecret: string, sign: string): boolean {
  const stringToSign = `${timestamp}\n${appSecret}`;
  const expected = crypto.createHmac('sha256', appSecret).update(stringToSign).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(sign || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── 入站：通过 sessionWebhook 回复文本到群 ──
export async function dingtalkReplyViaSession(sessionWebhook: string, text: string): Promise<SendResult> {
  if (!sessionWebhook) return { ok: false, error: '无 sessionWebhook' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sessionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '回复失败' };
  } finally {
    clearTimeout(t);
  }
}

export async function sendDingtalkWebhook(
  webhookUrl: string,
  signSecret?: string,
  message?: PushMessage
): Promise<SendResult> {
  if (!webhookUrl) return { ok: false, error: '未配置钉钉 webhook 地址' };
  if (!message) return { ok: false, error: '消息内容为空' };

  let finalUrl = webhookUrl.trim();

  // 如果配置了加签密钥
  if (signSecret && signSecret.trim()) {
    const timestamp = Date.now();
    const secret = signSecret.trim();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
    const encodedSign = encodeURIComponent(sign);
    const connector = finalUrl.includes('?') ? '&' : '?';
    finalUrl = `${finalUrl}${connector}timestamp=${timestamp}&sign=${encodedSign}`;
  }

  const body = buildDingtalkBody(message);

  try {
    const res = await fetch(finalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: `钉钉 HTTP ${res.status}` };
    }
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) {
      return { ok: false, error: `钉钉错误 ${data.errcode}: ${data.errmsg ?? ''}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `钉钉请求网络异常：${msg}` };
  }
}
