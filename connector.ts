// 飞书长连接 connector：整机版（appliance）的机器人入站通道。
//
// 【为什么整机版必须有它】飞书的事件订阅默认走 webhook —— 飞书服务器要主动打到你的公网地址。
// 卖给客户的那台 Mac mini / Win 主机在 NAT 后面，**没有公网地址**，webhook 永远到不了。
// 长连接反过来：由本机主动出站连飞书，事件顺着这条连接推下来。
// 不需要公网 IP、不需要域名、不需要证书、不需要备案。
//
// 私有化版（private）不用它：客户云上有公网域名和证书，沿用现成的 webhook 路由更简单，
// 也少一个常驻进程。形态判定见 lib/edition.ts 的 botInboundWs。
//
// 运行：BEACON_EDITION=appliance npx tsx connector.ts
// 整机安装脚本会把它注册成开机自启的第二个服务（launchd / 计划任务）。

import { prisma } from './lib/db';
import { can, edition } from './lib/edition';
import { initObservability, log, flushReports } from './lib/logger';
import { handleInbound } from './lib/bot/router';
import { readBotSecrets } from './lib/bot';
import { feishuTenantAccessToken, feishuReplyText, feishuMentionsBot } from './lib/bot/feishu';

type FeishuEvent = {
  event?: {
    message?: {
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: unknown[];
    };
    sender?: { sender_id?: { open_id?: string } };
  };
};

async function main() {
  initObservability('connector');

  if (!can('botInboundWs')) {
    log.error(
      `当前形态（${edition()}）不使用长连接入站。` +
        'private/saas 走 webhook 路由 app/api/bot/feishu/events/[key]，不需要这个进程。',
    );
    await flushReports();
    process.exit(1);
  }

  const integration = await prisma.botIntegration.findFirst({
    where: { provider: 'feishu', enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, workspaceId: true, inboundKey: true, secretsEnc: true },
  });
  if (!integration?.inboundKey) {
    log.error('还没有配置飞书企业应用（设置 → 机器人与通知）。配好后重启本进程。');
    await flushReports();
    process.exit(1);
  }
  const secrets = readBotSecrets(integration.secretsEnc);
  if (!secrets.appSecret) {
    log.error('飞书应用缺少 App Secret，无法建立长连接。');
    await flushReports();
    process.exit(1);
  }

  // SDK 动态引入：只有这个进程用得到它，web/worker 不该为它付出启动开销。
  // 装不上时给的是「怎么修」，不是一句 MODULE_NOT_FOUND。
  let Lark: typeof import('@larksuiteoapi/node-sdk');
  try {
    Lark = await import('@larksuiteoapi/node-sdk');
  } catch {
    log.error('缺少依赖 @larksuiteoapi/node-sdk。在项目目录执行：npm install @larksuiteoapi/node-sdk');
    await flushReports();
    process.exit(1);
  }

  const appId = integration.inboundKey;
  const appSecret = secrets.appSecret;

  const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.warn });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      // SDK 把 event 内容拍平递进来，形状与 webhook 的 payload.event 一致。
      const ev = { event: data } as FeishuEvent;
      await onMessage(ev, { appId, appSecret, integrationId: integration.id, workspaceId: integration.workspaceId });
    },
  });

  wsClient.start({ eventDispatcher });
  log.info('飞书长连接已建立（整机版入站通道）', { appId, workspaceId: integration.workspaceId });

  // 长连接断了由 SDK 自己重连；进程要一直活着。
  process.on('SIGTERM', async () => {
    log.info('收到 SIGTERM，退出');
    await flushReports();
    process.exit(0);
  });
}

async function onMessage(
  payload: FeishuEvent,
  ctx: { appId: string; appSecret: string; integrationId: string; workspaceId: string },
) {
  const message = payload.event?.message;
  const chatId = message?.chat_id ?? '';
  if (!chatId || message?.message_type !== 'text') return;

  // content 是 JSON 串：{"text":"..."}
  let text = '';
  try {
    text = String(JSON.parse(message.content ?? '{}').text ?? '').trim();
  } catch {
    return;
  }
  if (!text) return;

  const isGroup = message.chat_type === 'group';
  const senderId = payload.event?.sender?.sender_id?.open_id;

  // 群里必须是 @ 本机器人才理会 —— 与 webhook 路由同一条口径，
  // 否则机器人会对群里每一句话都作出反应。
  if (isGroup && !(await feishuMentionsBot((message.mentions ?? []) as never, ctx.appId, ctx.appSecret))) return;

  // 剥掉 @机器人 前缀，否则斜杠命令顶不了格
  const clean = text.replace(/^@\S+\s*/, '');

  const reply = await handleInbound(ctx.workspaceId, clean, {
    provider: 'feishu',
    integrationId: ctx.integrationId,
    chatId,
    senderId,
    // 🔒 必须传：登录/绑定指令靠它拒绝在群里响应（链接发进群 = 谁点谁登进来）
    isGroup,
  }).catch((e) => {
    log.error('长连接入站处理失败', { err: (e as Error).message });
    return '处理出错了，请稍后再试。';
  });

  await prisma.botIntegration
    .updateMany({ where: { id: ctx.integrationId }, data: { lastInboundAt: new Date(), lastError: null } })
    .catch(() => {});

  const { token } = await feishuTenantAccessToken(ctx.appId, ctx.appSecret);
  if (!token) {
    log.warn('取 tenant_access_token 失败，回不了话', { appId: ctx.appId });
    return;
  }
  const r = await feishuReplyText(token, chatId, reply);
  if (!r.ok) log.warn('长连接回复失败', { appId: ctx.appId, error: r.error });
}

main().catch(async (e) => {
  log.error('connector 启动失败', { err: (e as Error).message });
  await flushReports();
  process.exit(1);
});
