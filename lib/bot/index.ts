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
import { isReplyOnlyProvider } from './types';

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
  // 只答不推的渠道（微信客服 48h 窗口 / 扫码网关无广播收件人）：在这里就拒，
  // 不让它掉进 sendViaApp 的 default 分支报一句「暂不支持自建应用推送」——那句话对微信用户是谜语
  if (isReplyOnlyProvider(it.provider)) return { ok: false, error: '这条通道只能回复、不能主动推送' };
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

// ── 定点发送：把一条消息发给**指定的那一个**集成 ──
// 群里派任务的回执用它：那是对一次指令的**答复**，不是订阅制的事件广播——
// 走 pushEvent 会被「订阅了哪些事件」过滤掉，变成「派活的群要不要收回执
// 取决于管理员有没有勾某个推送事件」这种谁也想不到的暗联动。
export async function sendToIntegration(workspaceId: string, integrationId: string, message: PushMessage): Promise<SendResult> {
  const it = await prisma.botIntegration.findFirst({ where: { id: integrationId, workspaceId, enabled: true } });
  if (!it) return { ok: false, error: '集成不存在或已停用' };
  if (!it.webhookUrl && !it.inboundKey) return { ok: false, error: '未配置 webhook 地址或自建应用凭据' };
  const r = await routeSend(it, readBotSecrets(it.secretsEnc), message);
  await prisma.botIntegration
    .update({ where: { id: it.id }, data: r.ok ? { lastOutboundAt: new Date(), lastError: null } : { lastError: `回执发送失败：${r.error ?? ''}` } })
    .catch(() => {});
  return r;
}

// ── 定点到**某一个会话**：群里派出的任务回执用 ──
//
// 【为什么不能用 sendToIntegration】它是集成级：飞书自建应用会**逐群广播**、企微 @all、
// 钉钉全员——「你派的任务等你确认」会发到这个机器人所在的所有群。2026-09-02 盘查抓到：
// echoRunToChat 明明解析出了 chatId，却没有一条能把它送到发送层的路。
// 而且微信 iLink/客服是「只答不推」，集成级发送在 routeSend 就被拒，派出去的任务永远回不了「跑完了」。
// 这里按 provider 走各自的**会话级**接口——那本来就是入站回复用的同一套。
export async function sendToChat(workspaceId: string, integrationId: string, chatId: string, message: PushMessage): Promise<SendResult> {
  const it = await prisma.botIntegration.findFirst({ where: { id: integrationId, workspaceId, enabled: true } });
  if (!it) return { ok: false, error: '集成不存在或已停用' };
  if (!chatId) return { ok: false, error: '没有会话 id' };
  const secrets = readBotSecrets(it.secretsEnc);
  const r = await sendToChatVia(it.provider, it.inboundKey, secrets, chatId, message);
  await prisma.botIntegration
    .update({ where: { id: it.id }, data: r.ok ? { lastOutboundAt: new Date(), lastError: null } : { lastError: `回执发送失败：${r.error ?? ''}` } })
    .catch(() => {});
  return r;
}

/** 卡片在只有纯文本接口的渠道上的形态：标题 / 行 / 链接各占一行。 */
export function renderPlain(message: PushMessage): string {
  if (message.kind === 'text') return message.text;
  const lines = [message.title, ...message.lines];
  if (message.link) lines.push(`${message.link.text}：${message.link.url}`);
  return lines.filter(Boolean).join('\n');
}

async function sendToChatVia(provider: string, inboundKey: string | null, secrets: BotSecrets, chatId: string, message: PushMessage): Promise<SendResult> {
  switch (provider) {
    case 'feishu': {
      if (!inboundKey || !secrets.appSecret) return { ok: false, error: '飞书未配置自建应用凭据，回不到群里' };
      const { feishuTenantAccessToken, feishuSendToChat } = await import('./feishu');
      const { token, error } = await feishuTenantAccessToken(inboundKey, secrets.appSecret);
      if (!token) return { ok: false, error: `获取 tenant_access_token 失败：${error ?? ''}` };
      return feishuSendToChat(token, chatId, message);
    }
    case 'wecom': {
      if (!secrets.corpId || !secrets.appSecret || !secrets.agentId) return { ok: false, error: '企微未配置 CorpID/Secret/AgentID' };
      const { getWecomAccessToken, wecomReplyText } = await import('./wecom');
      const { token, error } = await getWecomAccessToken(secrets.corpId, secrets.appSecret);
      if (!token) return { ok: false, error: `获取 access_token 失败：${error ?? ''}` };
      return wecomReplyText(token, secrets.agentId, chatId, renderPlain(message));
    }
    case 'dingtalk': {
      if (!inboundKey || !secrets.appSecret) return { ok: false, error: '钉钉未配置 AppKey/AppSecret' };
      const { getDingtalkAccessToken, dingtalkSendToConversation } = await import('./dingtalk');
      const { token, error } = await getDingtalkAccessToken(inboundKey, secrets.appSecret);
      if (!token) return { ok: false, error: `获取 access_token 失败：${error ?? ''}` };
      return dingtalkSendToConversation(token, inboundKey, chatId, renderPlain(message));
    }
    case 'wechat_kf': {
      if (!secrets.corpId || !secrets.appSecret || !secrets.openKfId) return { ok: false, error: '微信客服未配置 CorpID/Secret/客服账号' };
      const { kfSendText } = await import('./wechat-kf');
      return kfSendText(secrets.corpId, secrets.appSecret, secrets.openKfId, chatId, renderPlain(message));
    }
    case 'wechat': {
      if (!secrets.ilinkBotToken) return { ok: false, error: '微信 iLink 未绑定' };
      if (!secrets.ilinkContextToken) return { ok: false, error: '微信 iLink 没有可挂的会话上下文（要等对方先发过一条消息）' };
      const { ilinkSendText } = await import('./wechat-ilink');
      return ilinkSendText(secrets.ilinkBaseUrl, secrets.ilinkBotToken, chatId, secrets.ilinkContextToken, renderPlain(message));
    }
    default:
      return { ok: false, error: `${provider} 没有会话级发送接口` };
  }
}

// ── 测试发送：设置页「测试发送」按钮用 ──
export async function testPush(integrationId: string, workspaceId: string): Promise<SendResult> {
  const it = await prisma.botIntegration.findFirst({ where: { id: integrationId, workspaceId } });
  if (!it) return { ok: false, error: '集成不存在' };
  if (isReplyOnlyProvider(it.provider)) {
    return { ok: false, error: '这条通道只答不推，没有「测试发送」；用「体检」验证凭据与回调是否配通' };
  }
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
