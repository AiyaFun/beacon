
import { prisma } from '@/lib/db';
import { markSeen } from '@/lib/bot/seen';
import { log } from '@/lib/logger';
import { readBotSecrets } from '@/lib/bot';
import { wecomSignature, wecomDecrypt, wecomExtractXml, getWecomAccessToken, wecomReplyText } from '@/lib/bot/wecom';
import { handleInbound } from '@/lib/bot/router';

// 企业微信自建应用回调（入站）。
// 路径参数 key = inboundKey(corpId_agentId)：先按它反查集成/工作区，再验签/解密。
//
// GET：URL 校验握手（echostr 解密返回明文）。
// POST：接收消息/事件（XML body，可能加密）。
// 在 middleware PUBLIC_PATHS（/api/bot 前缀）——企微服务器不带我们的登录 cookie。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function findIntegration(key: string) {
  const integration = await prisma.botIntegration.findUnique({ where: { inboundKey: key } });
  if (!integration || integration.provider !== 'wecom') return null;
  // 停用 = 出站入站一起停。此前 enabled 只被出站看（pushEvent/sendToIntegration），
  // 「停用」后群里照答——按钮上写的是停用，不是「只停推送」
  if (!integration.enabled) return null;
  return integration;
}

// GET：企微回调 URL 验证
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const integration = await findIntegration(key);
  if (!integration) return new Response('not found', { status: 404 });
  const secrets = readBotSecrets(integration.secretsEnc);

  const url = new URL(req.url);
  const msgSignature = url.searchParams.get('msg_signature') ?? '';
  const timestamp = url.searchParams.get('timestamp') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';
  const echostr = url.searchParams.get('echostr') ?? '';

  if (!secrets.verificationToken || !secrets.encryptKey) {
    log.warn('企微回调验证缺少 Token 或 EncodingAESKey', { key });
    return new Response('config missing', { status: 500 });
  }

  // 验签
  const expected = wecomSignature(secrets.verificationToken, timestamp, nonce, echostr);
  if (expected !== msgSignature) {
    log.warn('企微回调验签失败', { key });
    return new Response('bad signature', { status: 401 });
  }

  // 解密 echostr 返回明文
  try {
    const plaintext = wecomDecrypt(secrets.encryptKey, echostr);
    return new Response(plaintext, { status: 200, headers: { 'content-type': 'text/plain' } });
  } catch (e) {
    log.warn('企微回调解密 echostr 失败', { key, err: e });
    return new Response('decrypt failed', { status: 400 });
  }
}

// POST：接收消息/事件
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const integration = await findIntegration(key);
  if (!integration) return new Response('not found', { status: 404 });
  const secrets = readBotSecrets(integration.secretsEnc);

  const url = new URL(req.url);
  const msgSignature = url.searchParams.get('msg_signature') ?? '';
  const timestamp = url.searchParams.get('timestamp') ?? '';
  const nonce = url.searchParams.get('nonce') ?? '';

  const rawXml = await req.text();

  // 从外层 XML 提取 Encrypt
  const encrypt = wecomExtractXml(rawXml, 'Encrypt');
  if (!encrypt) {
    log.warn('企微回调缺少 Encrypt 字段', { key });
    return new Response('success');
  }

  // 验签
  if (secrets.verificationToken) {
    const expected = wecomSignature(secrets.verificationToken, timestamp, nonce, encrypt);
    if (expected !== msgSignature) {
      log.warn('企微回调验签失败', { key });
      return new Response('bad signature', { status: 401 });
    }
  }

  // 解密
  let innerXml: string;
  try {
    if (!secrets.encryptKey) {
      log.warn('企微回调已加密但未配置 EncodingAESKey', { key });
      return new Response('success');
    }
    innerXml = wecomDecrypt(secrets.encryptKey, encrypt);
  } catch (e) {
    log.warn('企微回调解密失败', { key, err: e });
    return new Response('success');
  }

  // 只处理文本消息
  const msgType = wecomExtractXml(innerXml, 'MsgType');
  if (msgType !== 'text') return new Response('success');

  const text = wecomExtractXml(innerXml, 'Content').trim();
  const fromUser = wecomExtractXml(innerXml, 'FromUserName');
  if (!text) return new Response('success');
  // 重投去重：企微 5 秒内没收到响应会重试（最多 3 次）。对话/派任务/试采都不是幂等的。
  const msgId = wecomExtractXml(innerXml, 'MsgId');
  if (msgId && !markSeen(integration.id, `wecom:${msgId}`)) {
    log.info('企微重投的消息，已忽略', { key, msgId });
    return new Response('success');
  }

  // 快速响应；处理与回复走后台
  void processAndReply(integration.id, integration.workspaceId, text, fromUser, secrets).catch((e) =>
    log.error('企微入站处理失败', { key, err: e }),
  );
  return new Response('success');
}

async function processAndReply(
  integrationId: string,
  workspaceId: string,
  text: string,
  fromUser: string,
  secrets: ReturnType<typeof readBotSecrets>,
) {
  // chatId 用 fromUser：企微自建应用是一对一会话，同一个人的连续提问就是一轮对话
  const reply = await handleInbound(workspaceId, text, {
    provider: 'wecom',
    integrationId,
    chatId: fromUser,
    senderId: fromUser,
    // 企微自建应用的消息回调**只有**一对一会话，没有群消息这条路径 ——
    // 显式写 false 而不是留空，是为了让「登录链接能不能发」这件事在这里一眼可见。
    isGroup: false,
  });
  await prisma.botIntegration
    .updateMany({ where: { id: integrationId }, data: { lastInboundAt: new Date(), lastError: null } })
    .catch(() => {});

  // 回复：需要 corpId + appSecret 换 access_token，再用应用消息 API 发给用户
  if (secrets.corpId && secrets.appSecret && secrets.agentId && fromUser) {
    const { token } = await getWecomAccessToken(secrets.corpId, secrets.appSecret);
    if (token) {
      const r = await wecomReplyText(token, secrets.agentId, fromUser, reply);
      if (!r.ok) log.warn('企微回复失败', { integrationId, error: r.error });
    }
  }
}
