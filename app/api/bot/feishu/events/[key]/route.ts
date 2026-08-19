import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { readBotSecrets } from '@/lib/bot';
import { parseJson } from '@/lib/json';
import {
  feishuVerifySignature, feishuDecrypt, feishuTenantAccessToken, feishuReplyText,
  feishuPassesMentionGate, feishuMentionsBot, type FeishuMention,
} from '@/lib/bot/feishu';
import { handleInbound } from '@/lib/bot/router';

// 飞书事件订阅回调（需求④入站）。
// 路径参数 key = inboundKey(app_id)：先按它反查集成/工作区，再验签/解密——多租户下这是
// 唯一能在「解密前」定位密钥的方式（加密时 app_id 也在密文里，无法从 body 取）。
//
// 🔒 三道闸：① key 命中某启用集成；② Verification Token 相符；③ 开了加密则 X-Lark-Signature 验签。
// 在 middleware PUBLIC_PATHS（/api/bot 前缀）——飞书服务器不带我们的登录 cookie。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ack(body: unknown = { code: 0 }) {
  return NextResponse.json(body, { status: 200 });
}

// 去 @机器人 占位符与首尾空白，得到干净指令文本。
function cleanText(content: string): string {
  try {
    const t = JSON.parse(content)?.text ?? '';
    return String(t).replace(/@_(user|all)_\w+/g, '').replace(/@_all\b/g, '').trim();
  } catch {
    return '';
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const raw = await req.text();

  const integration = await prisma.botIntegration.findUnique({ where: { inboundKey: key } });
  if (!integration || integration.provider !== 'feishu') {
    return NextResponse.json({ code: 404, msg: 'unknown app' }, { status: 404 });
  }
  const secrets = readBotSecrets(integration.secretsEnc);

  // 解析（可能加密）
  let payload: any;
  try {
    const outer = JSON.parse(raw);
    if (outer?.encrypt) {
      if (!secrets.encryptKey) {
        log.warn('飞书事件已加密但未配置 Encrypt Key', { key });
        return ack({ code: 400, msg: 'encrypt key missing' });
      }
      payload = JSON.parse(feishuDecrypt(secrets.encryptKey, outer.encrypt));
    } else {
      payload = outer;
    }
  } catch (e) {
    log.warn('飞书事件解析/解密失败', { key, err: e });
    return ack({ code: 400 });
  }

  // ① URL 校验握手：配置事件订阅时飞书先打这一下
  if (payload?.type === 'url_verification') {
    if (secrets.verificationToken && payload.token !== secrets.verificationToken) {
      return NextResponse.json({ code: 401, msg: 'bad token' }, { status: 401 });
    }
    return NextResponse.json({ challenge: payload.challenge });
  }

  // ② Verification Token
  const tokenInHeader = payload?.header?.token;
  if (secrets.verificationToken && tokenInHeader !== secrets.verificationToken) {
    log.warn('飞书事件 token 不符', { key });
    return ack({ code: 401 });
  }

  // ③ 开了加密则验签（明文模式飞书不发签名头，靠 token 即可）
  if (secrets.encryptKey) {
    const timestamp = req.headers.get('X-Lark-Request-Timestamp') ?? '';
    const nonce = req.headers.get('X-Lark-Request-Nonce') ?? '';
    const signature = req.headers.get('X-Lark-Signature') ?? '';
    if (signature && !feishuVerifySignature({ timestamp, nonce, encryptKey: secrets.encryptKey, rawBody: raw, signature })) {
      log.warn('飞书事件验签失败', { key });
      return ack({ code: 401 });
    }
  }

  // 只处理文本消息接收事件；其余（进群/表情等）静默 ack
  const eventType = payload?.header?.event_type;
  if (eventType !== 'im.message.receive_v1') return ack();

  const message = payload?.event?.message;
  const chatId = message?.chat_id as string | undefined;
  if (!chatId) return ack();

  // 图片消息：读创作者后台截图 → 抽指标 → 入表现数据
  // 刻意不套下面那道 @ 闸：图片消息压根 @ 不了人，套上等于把群内截图回填整条掐死。
  // （群里能收到图片本就意味着应用拿了「接收群聊中所有消息」权限，是用户主动开的。）
  if (message?.message_type === 'image') {
    const fileKey = parseJson<{ image_key?: string }>(message.content ?? '', {}).image_key;
    const messageId = message.message_id as string | undefined;
    if (!fileKey || !messageId) return ack();
    void processImage(integration.id, integration.workspaceId, messageId, fileKey, chatId, secrets.appSecret, key).catch((e) =>
      log.error('飞书截图处理失败', { key, err: e }),
    );
    return ack();
  }

  if (message?.message_type !== 'text') return ack();

  // 群聊必须 @ 到机器人才应答（闸的两道见 lib/bot/feishu）。第一道是纯判断，放在 ack 前；
  // 第二道要调飞书接口认「@ 的是不是我」，放在后台段，别拖慢这 3 秒的 ack。
  //
  // 丢弃必须留痕：静默 return 会让「@了没反应」变成无从下手的玄学——
  // 而「事件到底有没有到我们这」正是这条链路上最贵的一个问题（2026-07-29 排查过一次，
  // 靠 nginx access log 才排除掉是这道闸的问题）。日志里能一眼看出是闸挡的还是压根没来。
  if (!feishuPassesMentionGate(message)) {
    log.info('飞书群消息未 @ 机器人，已忽略', { key, chatId, chatType: message?.chat_type });
    return ack();
  }

  const text = cleanText(message.content ?? '');
  if (!text) return ack();

  // 快速 ack（飞书要求 <3s，超时会重推）；实际处理与回复走后台（常驻 Node 进程，安全）。
  // 操作皆幂等（收录去重 / 订阅 upsert / 查询无副作用），偶发重推不会重复入库。
  void processAndReply({
    integrationId: integration.id,
    workspaceId: integration.workspaceId,
    text,
    chatId,
    appSecret: secrets.appSecret,
    appId: key,
    mentions: (message?.mentions ?? []) as FeishuMention[],
    isGroup: message?.chat_type === 'group',
    senderId: payload?.event?.sender?.sender_id?.open_id,
  }).catch((e) => log.error('飞书入站处理失败', { key, err: e }));
  return ack();
}

// 截图入站：下载图 → 识图入库 → 回执。
// 与文本路径分开是有意的：它会写表现数据，失败原因也要说得更具体（见 describeScreenshotResult）。
async function processImage(
  integrationId: string,
  workspaceId: string,
  messageId: string,
  fileKey: string,
  chatId: string,
  appSecret: string | undefined,
  appId: string,
) {
  if (!appSecret) return; // 没 secret 既下不了图也回不了话
  const { token, error } = await feishuTenantAccessToken(appId, appSecret);
  if (!token) {
    log.warn('飞书取 token 失败，无法处理截图', { appId, error });
    return;
  }

  const { feishuDownloadResource } = await import('@/lib/bot/feishu');
  const { ingestScreenshot, describeScreenshotResult } = await import('@/lib/bot/screenshot');

  const dl = await feishuDownloadResource(token, messageId, fileKey, 'image');
  const reply = dl.ok
    ? describeScreenshotResult(await ingestScreenshot(workspaceId, { data: dl.data, mime: dl.mime }))
    : `图片下载失败：${dl.error}。请确认应用已开通 im:resource 权限。`;

  await prisma.botIntegration
    .updateMany({ where: { id: integrationId }, data: { lastInboundAt: new Date(), lastError: null } })
    .catch(() => {});
  const r = await feishuReplyText(token, chatId, reply);
  if (!r.ok) log.warn('飞书截图回复失败', { appId, error: r.error });
}

async function processAndReply(p: {
  integrationId: string;
  workspaceId: string;
  text: string;
  chatId: string;
  appSecret: string | undefined;
  appId: string;
  mentions: FeishuMention[];
  isGroup: boolean;
  senderId?: string;
}) {
  // 群里的 @ 是不是冲着机器人来的——要调飞书接口，所以放在 ack 之后的后台段里做
  if (p.isGroup && !(await feishuMentionsBot(p.mentions, p.appId, p.appSecret))) {
    log.info('飞书群消息 @ 的不是本机器人，已忽略', { appId: p.appId, chatId: p.chatId, mentions: p.mentions.length });
    return;
  }

  const reply = await handleInbound(p.workspaceId, p.text, {
    provider: 'feishu',
    integrationId: p.integrationId,
    chatId: p.chatId,
    senderId: p.senderId,
    // 🔒 必须传：登录/绑定指令靠它拒绝在群里响应（链接发进群 = 谁点谁登进来）
    isGroup: p.isGroup,
  });
  // updateMany：集成若在处理期间被删（并发/测试），0 行静默返回，不抛「record not found」
  await prisma.botIntegration
    .updateMany({ where: { id: p.integrationId }, data: { lastInboundAt: new Date(), lastError: null } })
    .catch(() => {});

  // 回复到群：需要 app_id + app_secret 换 tenant_access_token
  if (p.appSecret) {
    const { token, error } = await feishuTenantAccessToken(p.appId, p.appSecret);
    if (!token) {
      log.warn('飞书取 token 失败，无法回复', { appId: p.appId, error });
      return;
    }
    const r = await feishuReplyText(token, p.chatId, reply);
    if (!r.ok) log.warn('飞书回复失败', { appId: p.appId, error: r.error });
  }
}
