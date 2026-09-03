import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { markSeen } from '@/lib/bot/seen';
import { log } from '@/lib/logger';
import { readBotSecrets } from '@/lib/bot';
import { dingtalkVerifySign, dingtalkReplyViaSession, stripDingtalkAtPrefix } from '@/lib/bot/dingtalk';
import { handleInbound } from '@/lib/bot/router';

// 钉钉企业内部机器人回调（入站）。
// 路径参数 key = inboundKey(appKey)：先按它反查集成/工作区，再验签。
//
// 钉钉机器人 outgoing webhook 以 JSON POST 发来，header 带 timestamp + sign（HMAC-SHA256）。
// payload.text.content 是用户消息，payload.sessionWebhook 可用于异步回复。
// 在 middleware PUBLIC_PATHS（/api/bot 前缀）——钉钉服务器不带我们的登录 cookie。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;

  const integration = await prisma.botIntegration.findUnique({ where: { inboundKey: key } });
  if (!integration || integration.provider !== 'dingtalk') {
    return NextResponse.json({ code: 404, msg: 'unknown app' }, { status: 404 });
  }
  // 停用 = 出站入站一起停（此前 enabled 只管出站，「停用」后群里照答）。回 200 让平台别重试
  if (!integration.enabled) return NextResponse.json({ code: 0, msg: 'disabled' });
  const secrets = readBotSecrets(integration.secretsEnc);

  // 验签：header timestamp + sign，用 appSecret 校验
  if (secrets.appSecret) {
    const timestamp = req.headers.get('timestamp') ?? '';
    const sign = req.headers.get('sign') ?? '';
    if (!timestamp || !sign || !dingtalkVerifySign(timestamp, secrets.appSecret, sign)) {
      log.warn('钉钉回调验签失败', { key });
      return NextResponse.json({ code: 401, msg: 'bad sign' }, { status: 401 });
    }
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ code: 400 }, { status: 400 });
  }

  // 只处理文本消息
  if (payload?.msgtype !== 'text') {
    return NextResponse.json({});
  }

  // 剥掉「@机器人名 」前缀，否则斜杠命令顶不了格（见 stripDingtalkAtPrefix）
  const text = stripDingtalkAtPrefix(String(payload?.text?.content ?? ''));
  const sessionWebhook = String(payload?.sessionWebhook ?? '');
  // 会话 id：群聊给 conversationId，单聊退回发送者，都没有就不记上下文（照常回话）
  const chatId = String(payload?.conversationId ?? payload?.senderStaffId ?? '');
  if (!text) return NextResponse.json({});
  // 重投去重：钉钉回调超时会重试。对话/派任务/试采都不是幂等的。
  const msgId = String(payload?.msgId ?? '');
  if (msgId && !markSeen(integration.id, `dingtalk:${msgId}`)) {
    log.info('钉钉重投的消息，已忽略', { key, msgId });
    return NextResponse.json({});
  }

  // 快速响应；处理与回复走后台
  // 身份：senderStaffId 是这个人在企业里的稳定 userid（senderId 是会话级的，换个群就变）。
  // conversationType：'1'=单聊，'2'=群聊。**只有显式的 '1' 才算私聊** ——
  // 字段缺失时按群聊处理是刻意的 fail-closed：判错方向的代价是把一次性登录链接发进群，
  // 群里任何人点开都能拿到这个人的会话。
  const senderId = String(payload?.senderStaffId ?? payload?.senderId ?? '') || undefined;
  const senderName = String(payload?.senderNick ?? '') || undefined;
  const isGroup = String(payload?.conversationType ?? '') !== '1';
  // 群名回调里就带着（conversationTitle）——渠道卡「在哪些群」靠它，别的渠道还得去同步
  const chatName = String(payload?.conversationTitle ?? '') || undefined;
  void processAndReply(integration.id, integration.workspaceId, text, sessionWebhook, chatId, senderId, senderName, isGroup, chatName).catch((e) =>
    log.error('钉钉入站处理失败', { key, err: e }),
  );
  return NextResponse.json({});
}

async function processAndReply(
  integrationId: string,
  workspaceId: string,
  text: string,
  sessionWebhook: string,
  chatId: string,
  senderId: string | undefined,
  senderName: string | undefined,
  isGroup: boolean,
  chatName?: string,
) {
  const reply = await handleInbound(workspaceId, text, {
    provider: 'dingtalk',
    integrationId,
    chatId: chatId || undefined,
    senderId,
    senderName,
    isGroup,
    chatName,
  });
  await prisma.botIntegration
    .updateMany({ where: { id: integrationId }, data: { lastInboundAt: new Date(), lastError: null } })
    .catch(() => {});

  if (sessionWebhook) {
    const r = await dingtalkReplyViaSession(sessionWebhook, reply);
    if (!r.ok) log.warn('钉钉回复失败', { integrationId, error: r.error });
  }
}
