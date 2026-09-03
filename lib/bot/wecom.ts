import crypto from 'node:crypto';
import type { PushMessage, SendResult } from './types';

// 企业微信适配器：群自定义机器人 webhook + 自建应用消息 + 入站回调。
// webhook 文档：https://developer.work.weixin.qq.com/document/path/91770
// 应用消息文档：https://developer.work.weixin.qq.com/document/path/90236
// 接收消息文档：https://developer.work.weixin.qq.com/document/path/90930

const FETCH_TIMEOUT_MS = 8000;

function buildWecomMarkdown(message: PushMessage): string {
  if (message.kind === 'text') return message.text;
  const lines = message.lines.map((l) => `> ${l}`).join('\n');
  let md = `<font color="info">**${message.title}**</font>\n${lines}`;
  if (message.link) md += `\n[${message.link.text}](${message.link.url})`;
  return md;
}

// ── 自建应用：获取 access_token ──
export async function getWecomAccessToken(corpId: string, secret: string): Promise<{ token: string | null; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`, { signal: ctrl.signal });
    const data = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) return { token: null, error: data.errmsg ?? `errcode ${data.errcode}` };
    return { token: data.access_token ?? null };
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : '网络异常' };
  } finally {
    clearTimeout(t);
  }
}

// ── 自建应用：通过应用消息 API 发送消息到全员 ──
export async function sendWecomApp(corpId: string, secret: string, agentId: string, message: PushMessage): Promise<SendResult> {
  const { token, error: tokenErr } = await getWecomAccessToken(corpId, secret);
  if (!token) return { ok: false, error: `获取企微 access_token 失败：${tokenErr || '请检查 CorpID 和 Secret'}` };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let body: unknown;
    if (message.kind === 'text') {
      body = { touser: '@all', msgtype: 'text', agentid: parseInt(agentId, 10), text: { content: message.text } };
    } else {
      body = { touser: '@all', msgtype: 'markdown', agentid: parseInt(agentId, 10), markdown: { content: buildWecomMarkdown(message) } };
    }
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) return { ok: false, error: `企微应用消息失败 ${data.errcode}: ${data.errmsg ?? ''}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '发送失败' };
  } finally {
    clearTimeout(t);
  }
}

// ── 入站：回调验签 SHA1(sort([token, timestamp, nonce, encrypt])) ──
export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const arr = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

// ── 入站：AES-256-CBC 解密（EncodingAESKey 43字符 → base64 解码 → 32字节 key，前 16B 为 IV） ──
export function wecomDecrypt(encodingAESKey: string, encrypt: string): string {
  const aesKey = Buffer.from(encodingAESKey + '=', 'base64');
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypt, 'base64'), decipher.final()]);
  const pad = decrypted[decrypted.length - 1];
  const unpadded = decrypted.subarray(0, decrypted.length - pad);
  const msgLen = unpadded.readUInt32BE(16);
  return unpadded.subarray(20, 20 + msgLen).toString('utf8');
}

// ── 入站：从 XML 中提取标签内容 ──
export function wecomExtractXml(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`));
  return m?.[1] ?? m?.[2] ?? '';
}

// ── 入站：回复文本到指定用户（通过应用消息 API） ──
//
// 企微应用文本消息上限 2048 字节（全中文约 680 字）。超长**拆段按序发**而不是截断：
// 此前直接整段塞，/竞对 8 条带链接、/分析 长文都会超，企微回 40058 整条丢掉，
// 用户什么都收不到。与微信两条通道同一份 splitWechatText（600 字/段 ≤5 段）。
export async function wecomReplyText(accessToken: string, agentId: string, userId: string, text: string): Promise<SendResult> {
  const { splitWechatText } = await import('./wechat-text');
  const parts = splitWechatText(text);
  if (parts.length === 0) return { ok: true };
  for (const content of parts) {
    const r = await wecomSendTextOnce(accessToken, agentId, userId, content);
    if (!r.ok) return r; // 后面的段没有前面的段没意义
  }
  return { ok: true };
}

async function wecomSendTextOnce(accessToken: string, agentId: string, userId: string, content: string): Promise<SendResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userId,
        msgtype: 'text',
        agentid: parseInt(agentId, 10),
        text: { content },
      }),
      signal: ctrl.signal,
    });
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) return { ok: false, error: `${data.errcode}: ${data.errmsg}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '回复失败' };
  } finally {
    clearTimeout(t);
  }
}

export async function sendWecomWebhook(
  webhookUrl: string,
  message?: PushMessage
): Promise<SendResult> {
  if (!webhookUrl) return { ok: false, error: '未配置企业微信 webhook 地址' };
  if (!message) return { ok: false, error: '消息内容为空' };

  let body: unknown;
  if (message.kind === 'text') {
    body = { msgtype: 'text', text: { content: message.text } };
  } else {
    body = { msgtype: 'markdown', markdown: { content: buildWecomMarkdown(message) } };
  }

  try {
    const res = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: `企微 HTTP ${res.status}` };
    }
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) {
      return { ok: false, error: `企微错误 ${data.errcode}: ${data.errmsg ?? ''}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `企微请求网络异常：${msg}` };
  }
}
