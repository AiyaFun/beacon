import type { PushMessage, SendResult } from './types';

// Telegram Bot 推送适配器
// 官方文档：https://core.telegram.org/bots/api#sendmessage
export async function sendTelegramWebhook(
  webhookUrl: string,
  message?: PushMessage
): Promise<SendResult> {
  if (!webhookUrl) return { ok: false, error: '未配置 Telegram Bot webhook/API 地址' };
  if (!message) return { ok: false, error: '消息内容为空' };

  let targetUrl = webhookUrl.trim();

  let body: unknown;
  if (message.kind === 'text') {
    body = {
      text: message.text,
      parse_mode: 'Markdown',
    };
  } else {
    const lines = message.lines.map((l) => `• ${l}`).join('\n');
    let mdText = `*${message.title}*\n\n${lines}`;
    if (message.link) {
      mdText += `\n\n[${message.link.text}](${message.link.url})`;
    }
    body = {
      text: mdText,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    };
  }

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: `Telegram HTTP ${res.status}` };
    }
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (data.ok === false) {
      return { ok: false, error: `Telegram 错误: ${data.description ?? ''}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Telegram 请求网络异常：${msg}` };
  }
}
