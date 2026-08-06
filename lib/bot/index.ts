import { prisma } from '../db';
import { encryptKey, decryptKey } from '../crypto';
import { parseJson, toJson } from '../json';
import { log } from '../logger';
import { sendFeishuWebhook, sendFeishuApp } from './feishu';
import { sendDingtalkWebhook, sendDingtalkApp } from './dingtalk';
import { sendWecomWebhook, sendWecomApp } from './wecom';
import { sendTelegramWebhook } from './telegram';
import { sendSlackWebhook } from './slack';
import type { BotSecrets, PushEventType, PushMessage, SendResult, BotProvider } from './types';

// 机器人集成——出站推送编排层（需求③）。
// 入站收录/命令在 lib/bot/router.ts + /api/bot/feishu/events（需求④）。

// 公开访问地址（推送卡片里的跳转链接用）。生产在 .env 配 BEACON_PUBLIC_URL。
export function beaconUrl(path = ''): string {
  const base = (process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn').replace(/\/$/, '');
  if (!path) return base;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

// ── 密钥读写（整体加密成 secretsEnc）──
export function readBotSecrets(enc: string): BotSecrets {
  if (!enc) return {};
  const plain = decryptKey(enc);
  return parseJson<BotSecrets>(plain, {});
}
export function writeBotSecrets(s: BotSecrets): string {
  return encryptKey(toJson(s));
}

// ── 单集成推送：按 provider 分发（webhook 模式）──
// 导出给 lib/bot/diagnose.ts 复用（体检要走和真实推送完全相同的路径，否则测不出真问题）
export async function sendVia(provider: string, webhookUrl: string | null, secrets: BotSecrets, message: PushMessage): Promise<SendResult> {
  switch (provider as BotProvider) {
    case 'feishu':
      return sendFeishuWebhook(webhookUrl ?? '', secrets.signSecret, message);
    case 'dingtalk':
      return sendDingtalkWebhook(webhookUrl ?? '', secrets.signSecret, message);
    case 'wecom':
      return sendWecomWebhook(webhookUrl ?? '', message);
    case 'telegram':
      return sendTelegramWebhook(webhookUrl ?? '', message);
    case 'slack':
      return sendSlackWebhook(webhookUrl ?? '', message);
    default:
      return { ok: false, error: `provider ${provider} 暂不支持出站` };
  }
}

// ── 单集成推送：按 provider 分发（自建应用模式，通过 OpenAPI）──
async function sendViaApp(provider: string, inboundKey: string, secrets: BotSecrets, message: PushMessage): Promise<SendResult> {
  switch (provider as BotProvider) {
    case 'feishu':
      if (!secrets.appSecret) return { ok: false, error: '未配置 App Secret，无法发送' };
      return sendFeishuApp(inboundKey, secrets.appSecret, message);
    case 'dingtalk':
      if (!secrets.appSecret || !secrets.agentId) return { ok: false, error: '未配置 AppSecret 或 AgentId' };
      return sendDingtalkApp(inboundKey, secrets.appSecret, secrets.agentId, message);
    case 'wecom':
      if (!secrets.corpId || !secrets.appSecret || !secrets.agentId) return { ok: false, error: '未配置 CorpID、Secret 或 AgentID' };
      return sendWecomApp(secrets.corpId, secrets.appSecret, secrets.agentId, message);
    default:
      return { ok: false, error: `provider ${provider} 暂不支持自建应用推送` };
  }
}

// 自建应用模式所需凭据是否齐备（缺了就没法走 OpenAPI，只能退回 webhook）
function canUseApp(provider: string, secrets: BotSecrets): boolean {
  if (!secrets.appSecret) return false;
  if (provider === 'dingtalk') return !!secrets.agentId;
  if (provider === 'wecom') return !!(secrets.corpId && secrets.agentId);
  return true; // feishu 只需要 App ID + App Secret
}

// ── 选路：有 inboundKey 且凭据齐备就走自建应用，否则走 webhook ──
//
// ⚠️ 这里曾经是 `webhookUrl ? webhook : app`，webhook 无条件优先。后果：用户从「群 Webhook」
// 切到「自建应用」后，库里残留的旧 webhookUrl 继续被使用，自建应用配置形同虚设——
// 群机器人一旦被停用（19007 Bot Not Enabled），整条推送就断了，而界面上徽标还显示
// 「双向全能 (自建应用)」，排查时会被彻底带偏。现在的口径与那个徽标一致：
// 有 inboundKey 就是自建应用模式。
async function routeSend(
  it: { provider: string; webhookUrl: string | null; inboundKey: string | null },
  secrets: BotSecrets,
  message: PushMessage,
): Promise<SendResult> {
  if (it.inboundKey && canUseApp(it.provider, secrets)) {
    return sendViaApp(it.provider, it.inboundKey, secrets, message);
  }
  if (it.webhookUrl) return sendVia(it.provider, it.webhookUrl, secrets, message);
  if (it.inboundKey) return sendViaApp(it.provider, it.inboundKey, secrets, message); // 让它报出缺哪个凭据
  return { ok: false, error: '未配置 webhook 地址或自建应用凭据' };
}

// ── 事件推送：把一条消息推给某工作区中「订阅了该事件、启用了出站」的所有集成 ──
// 整体兜底：推送是旁路增强，任何失败都不许打断主流程（绝不向外 throw）。
//
// opts.integrationIds：只推给指定的几个集成。定时晨报用它——同一工作区的两个机器人
// 可以配不同的推送时刻（一个 09:00 一个 18:00），不限定就会在 09:00 把两个都推了。
export async function pushEvent(
  workspaceId: string,
  event: PushEventType,
  message: PushMessage,
  opts: { integrationIds?: string[] } = {},
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  try {
    const integrations = await prisma.botIntegration.findMany({
      where: {
        workspaceId,
        enabled: true,
        ...(opts.integrationIds ? { id: { in: opts.integrationIds } } : {}),
      },
    });
    for (const it of integrations) {
      if (!it.webhookUrl && !it.inboundKey) continue;
      const events = parseJson<string[]>(it.pushEvents, []);
      if (!events.includes(event)) continue;
      const secrets = readBotSecrets(it.secretsEnc);
      const r = await routeSend(it, secrets, message);
      if (r.ok) {
        sent++;
        await prisma.botIntegration.update({ where: { id: it.id }, data: { lastOutboundAt: new Date(), lastError: null } }).catch(() => {});
      } else {
        failed++;
        await prisma.botIntegration.update({ where: { id: it.id }, data: { lastError: `推送失败：${r.error ?? ''}` } }).catch(() => {});
        log.warn('机器人推送失败', { workspaceId, event, provider: it.provider, error: r.error });
      }
    }
  } catch (e) {
    log.warn('机器人推送异常', { workspaceId, event, err: e });
  }
  return { sent, failed };
}

// ── 测试发送：设置页「测试发送」按钮用 ──
export async function testPush(integrationId: string, workspaceId: string): Promise<SendResult> {
  const it = await prisma.botIntegration.findFirst({ where: { id: integrationId, workspaceId } });
  if (!it) return { ok: false, error: '集成不存在' };
  if (!it.webhookUrl && !it.inboundKey) return { ok: false, error: '未配置 webhook 地址或自建应用凭据' };
  const secrets = readBotSecrets(it.secretsEnc);
  const message: PushMessage = {
    kind: 'card',
    title: '🔥 烽火台 · 连接成功',
    lines: [
      '这是一条测试消息，看到它说明机器人已接通。',
      '之后开启的事件（每日推荐 / 热点 / 合规告警 / 学习小结）会推到这里。',
    ],
    link: { text: '打开烽火台', url: beaconUrl() },
  };
  const r = await routeSend(it, secrets, message);
  await prisma.botIntegration
    .update({ where: { id: it.id }, data: r.ok ? { lastOutboundAt: new Date(), lastError: null } : { lastError: `测试失败：${r.error ?? ''}` } })
    .catch(() => {});
  return r;
}

export * from './types';
