// 运维告警出口：把「生产出事了」推到**你已经在用的那个群**（飞书/钉钉/企微/Slack 机器人 webhook）。
//
// 为什么不是 Sentry：Sentry 要额外注册账号、配 DSN、再养一个没人每天看的看板；
// 而这套产品本来就有机器人推送能力，复用同一个群，配一个 webhook 就完事（`BEACON_OPS_WEBHOOK`）。
// 邮件通道 2026-07-30 已整体下线，所以这是**唯一**的外发告警腿——它挂了就只剩服务器日志。
//
// ⚠️ 这里**故意不复用 lib/bot 的 sendVia**：本模块会被 instrumentation.ts 引到，
// 而 instrumentation 连 edge runtime 也要打包一份；lib/bot → lib/crypto → `node:crypto`
// 在 edge 下直接构建失败（真踩过：`UnhandledSchemeError: node:crypto`）。
// 告警只是发一条纯文本，自己 POST 更便宜，也不需要签名（群机器人的 webhook 本身就是凭证）。
//
// 三条硬规矩（都是「告警系统自己把自己搞挂」的经典形态）：
//   ① 同一个错误指纹在冷却窗口内只发一条：崩溃循环时不能把群刷爆、也不能把 webhook 频控打死。
//   ② 每小时总量封顶：多个不同错误一起爆时同理。
//   ③ 发送失败**绝不能抛**：告警链路自己出错不许影响主流程（这是旁路，不是业务）。

export type OpsAlertLevel = 'error' | 'warn' | 'info';

// 出口二：复用**用户已经配好的机器人集成**（设置页 → 机器人集成），不另外要一个 webhook。
// 由 node 侧在启动时注册（lib/ops/bot-target.ts）——它要查库 + 解密密钥，
// 依赖 `node:crypto`，而本文件会被 instrumentation 带进 edge 打包，直接 import 会构建失败。
// 没注册（edge 运行时）或没配机器人 → 返回 false，本模块如实记「没发出去」，绝不假装发了。
type OpsBotSender = (text: string) => Promise<boolean>;
let botSender: OpsBotSender | null = null;

export function setOpsBotSender(fn: OpsBotSender | null): void {
  botSender = fn;
}

export function hasOpsBotSender(): boolean {
  return !!botSender;
}

const COOLDOWN_MS = 10 * 60_000; // 同指纹 10 分钟
const HOURLY_CAP = 12;

const lastSentAt = new Map<string, number>();
let windowStart = 0;
let sentInWindow = 0;

/** 从 webhook 域名推断服务商；推不出来按「两种最常见形状各发一次」处理（见 payloadsFor）。 */
export function providerOfWebhook(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('dingtalk.com')) return 'dingtalk';
  if (u.includes('qyapi.weixin.qq.com')) return 'wecom';
  if (u.includes('feishu.cn') || u.includes('larksuite.com')) return 'feishu';
  if (u.includes('hooks.slack.com')) return 'slack';
  return 'unknown';
}

/** 该服务商要的报文形状。unknown 时发两种最常见的，收得到哪条算哪条（与 cron-backup.sh 同策略）。 */
export function payloadsFor(provider: string, text: string): unknown[] {
  const feishu = { msg_type: 'text', content: { text } };
  const dingLike = { msgtype: 'text', text: { content: text } };
  switch (provider) {
    case 'feishu':
      return [feishu];
    case 'dingtalk':
    case 'wecom':
      return [dingLike];
    case 'slack':
      return [{ text }];
    default:
      return [feishu, dingLike];
  }
}

export function opsWebhook(): string | null {
  return process.env.BEACON_OPS_WEBHOOK?.trim() || null;
}

/** 有出口就算启用：显式 webhook，或已注册的「复用机器人集成」发送器。 */
export function opsAlertConfigured(): boolean {
  return !!opsWebhook() || !!botSender;
}

/** 测试用：清掉冷却与配额计数。 */
export function resetOpsAlertState(): void {
  lastSentAt.clear();
  windowStart = 0;
  sentInWindow = 0;
}

/** 冷却 + 配额判定。返回 false = 这条不发（正常抑制，不是错误）。 */
export function allowOpsAlert(fingerprint: string, now = Date.now()): boolean {
  const prev = lastSentAt.get(fingerprint);
  if (prev !== undefined && now - prev < COOLDOWN_MS) return false;

  if (now - windowStart > 3600_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= HOURLY_CAP) return false;

  sentInWindow++;
  lastSentAt.set(fingerprint, now);
  // 冷却表按指纹增长，长跑进程要有上界；超了就整体清空（最坏后果只是少抑制一轮）
  if (lastSentAt.size > 500) lastSentAt.clear();
  return true;
}

const LEVEL_ICON: Record<OpsAlertLevel, string> = { error: '🔴', warn: '🟠', info: '🔵' };

/**
 * 推一条运维告警。
 * @param fingerprint 去重键——**必须稳定**（用错误类型+消息，别把时间戳/请求 id 拼进去，
 *                    否则每条都是新指纹，冷却等于没有）。
 */
export async function sendOpsAlert(params: {
  level: OpsAlertLevel;
  title: string;
  lines: string[];
  fingerprint: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const url = opsWebhook();
  // 两个出口都没有 = 这套部署没打算收告警，如实返回（不是错误）。
  if (!url && !botSender) return { sent: false, reason: 'not_configured' };
  if (!allowOpsAlert(params.fingerprint)) return { sent: false, reason: 'throttled' };

  const env = process.env.BEACON_ENV ?? 'unknown';
  const service = process.env.BEACON_SERVICE ?? 'web';
  const text = [
    `${LEVEL_ICON[params.level]} 烽火台运维告警 · ${params.title}`,
    ...params.lines,
    `环境 ${env} · 进程 ${service}`,
  ].join('\n');

  // 没配显式 webhook 就走「用户已配的机器人」。这条路的失败同样不抛。
  if (!url) {
    try {
      const ok = await botSender!(text);
      return ok ? { sent: true } : { sent: false, reason: 'bot_send_failed' };
    } catch (e) {
      return { sent: false, reason: (e as Error).message };
    }
  }

  try {
    let ok = false;
    let lastErr = '';
    for (const body of payloadsFor(providerOfWebhook(url), text)) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) ok = true;
      else lastErr = `HTTP ${res.status}`;
    }
    return ok ? { sent: true } : { sent: false, reason: lastErr || 'send_failed' };
  } catch (e) {
    // 告警发不出去只能认了：这里再抛就成了「监控把业务弄挂」
    return { sent: false, reason: (e as Error).message };
  }
}
