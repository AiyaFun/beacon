import type { PushMessage, SendResult } from './types';

// Slack Incoming Webhooks 推送适配器
// 官方文档：https://api.slack.com/messaging/webhooks
export async function sendSlackWebhook(
  webhookUrl: string,
  message?: PushMessage
): Promise<SendResult> {
  if (!webhookUrl) return { ok: false, error: '未配置 Slack Webhook 地址' };
  if (!message) return { ok: false, error: '消息内容为空' };

  let body: unknown;
  if (message.kind === 'text') {
    body = { text: message.text };
  } else {
    const lines = message.lines.map((l) => `• ${l}`).join('\n');
    let textContent = `*${message.title}*\n${lines}`;
    if (message.link) {
      textContent += `\n<${message.link.url}|${message.link.text}>`;
    }
    body = { text: textContent };
  }

  try {
    const res = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Slack HTTP ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Slack 请求网络异常：${msg}` };
  }
}
