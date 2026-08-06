import { isProd } from '../env';

// 运维短信告警：复用火山引擎 SMS 通道，向运维手机发关键告警。
//
// 前置条件（外部配置）：
// 1. 在火山 SMS 控制台新建一条「通知类」模板（非验证码类），含一个变量（如 {content}）
// 2. 配置 BEACON_ALERT_SMS_TEMPLATE / BEACON_ALERT_SMS_PARAM / BEACON_ALERT_PHONE

const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 5000;
const lastSent = new Map<string, number>();

function pruneStale(now: number) {
  if (lastSent.size <= MAX_ENTRIES) return;
  const cutoff = now - COOLDOWN_MS;
  for (const [k, t] of lastSent) if (t < cutoff) lastSent.delete(k);
}

export async function sendAlertSms(key: string, message: string): Promise<void> {
  const phone = process.env.BEACON_ALERT_PHONE?.trim();
  const templateId = process.env.BEACON_ALERT_SMS_TEMPLATE?.trim();
  if (!phone || !templateId) return;

  const now = Date.now();
  const last = lastSent.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;
  lastSent.set(key, now);
  pruneStale(now);

  if (!isProd()) {
    console.log(`[alert-sms] (dev skip) ${key}: ${message}`);
    return;
  }

  const ak = process.env.BEACON_VOLC_SMS_AK;
  const sk = process.env.BEACON_VOLC_SMS_SK;
  const sign = process.env.BEACON_VOLC_SMS_SIGN;
  if (!ak || !sk || !sign) {
    console.warn('[alert-sms] 缺少火山 SMS 凭证 (AK/SK/SIGN)，跳过发送');
    return;
  }

  try {
    const { VolcengineSmsProvider } = await import('./volcengine');
    const provider = new VolcengineSmsProvider({
      accessKeyId: ak,
      secretAccessKey: sk,
      sign,
      smsAccount: process.env.BEACON_VOLC_SMS_ACCOUNT || '1b6d4896',
      templateId,
      paramName: process.env.BEACON_ALERT_SMS_PARAM || 'content',
      region: process.env.BEACON_VOLC_SMS_REGION || 'cn-north-1',
    });
    await provider.sendCode(phone, message.slice(0, 70));
  } catch (e) {
    console.error(`[alert-sms] 发送失败: ${(e as Error).message}`);
  }
}
