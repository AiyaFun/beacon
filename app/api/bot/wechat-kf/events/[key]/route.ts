import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { readBotSecrets, writeBotSecrets } from '@/lib/bot';
import { wecomSignature, wecomDecrypt, wecomExtractXml } from '@/lib/bot/wecom';
import { kfSyncMsg, kfSendText, kfSendWelcome, runSerialized, markSeen, type KfMessage } from '@/lib/bot/wechat-kf';
import { handleInbound } from '@/lib/bot/router';
import type { BotSecrets } from '@/lib/bot/types';

// 微信客服回调（官方通道，2026-09-01「微信直接做」）。
// 路径参数 key = inboundKey(`${corpId}_kf`)。验签/解密与企微自建应用完全同一套
// （同一个企业加密体系），差别在**消息不在回调里**：回调只送「有新消息」信号 + 一次性
// Token，要拿它调 kf/sync_msg 拉取，再逐条回复。
// 在 middleware PUBLIC_PATHS（/api/bot 前缀）——企微服务器不带我们的登录 cookie。
//
// 【三条口径，改之前先读】
//   ① 同一集成的拉取串行（runSerialized）：企微每条新消息发一次回调，用户连发两句 = 两次回调
//      几乎同时到，并行跑会读到同一个 cursor、拉到同一批消息、答两遍。
//   ② cursor 先落库再处理：处理途中崩了宁可漏答一条，不可重放旧消息。
//   ③ 只处理 origin=3（微信用户发来）+ msgid 去重：5 是我们自己发的回执，处理它会自嗨循环。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function findIntegration(key: string) {
  const integration = await prisma.botIntegration.findUnique({ where: { inboundKey: key } });
  if (!integration || integration.provider !== 'wechat_kf') return null;
  return integration;
}

// GET：回调 URL 验证（与企微自建应用同一握手）
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
    log.warn('微信客服回调验证缺少 Token 或 EncodingAESKey', { key });
    return new Response('config missing', { status: 500 });
  }
  const expected = wecomSignature(secrets.verificationToken, timestamp, nonce, echostr);
  if (expected !== msgSignature) {
    log.warn('微信客服回调验签失败', { key });
    return new Response('bad signature', { status: 401 });
  }
  try {
    const plaintext = wecomDecrypt(secrets.encryptKey, echostr);
    return new Response(plaintext, { status: 200, headers: { 'content-type': 'text/plain' } });
  } catch (e) {
    log.warn('微信客服回调解密 echostr 失败', { key, err: e });
    return new Response('decrypt failed', { status: 400 });
  }
}

// POST：kf_msg_or_event 信号 → sync_msg 拉取 → 逐条对话回复
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
  const encrypt = wecomExtractXml(rawXml, 'Encrypt');
  if (!encrypt) return new Response('success');

  if (secrets.verificationToken) {
    const expected = wecomSignature(secrets.verificationToken, timestamp, nonce, encrypt);
    if (expected !== msgSignature) {
      log.warn('微信客服回调验签失败', { key });
      return new Response('bad signature', { status: 401 });
    }
  }

  let innerXml: string;
  try {
    if (!secrets.encryptKey) {
      log.warn('微信客服回调已加密但未配置 EncodingAESKey', { key });
      return new Response('success');
    }
    innerXml = wecomDecrypt(secrets.encryptKey, encrypt);
  } catch (e) {
    log.warn('微信客服回调解密失败', { key, err: e });
    return new Response('success');
  }

  // 只认 kf_msg_or_event；其它事件（进入会话等）不拉消息
  const event = wecomExtractXml(innerXml, 'Event');
  if (event !== 'kf_msg_or_event') return new Response('success');
  const eventToken = wecomExtractXml(innerXml, 'Token');
  if (!eventToken) return new Response('success');
  // 回调里就带着是哪个客服账号（企业可有多个）——比从消息里猜可靠，拉取也按它过滤
  const openKfId = wecomExtractXml(innerXml, 'OpenKfId') || undefined;

  // 快速 200；拉取与回复走后台（企微对回调有 5 秒超时，sync+LLM 肯定超）
  void syncAndReply(integration.id, integration.workspaceId, eventToken, openKfId).catch((e) =>
    log.error('微信客服入站处理失败', { key, err: e }),
  );
  return new Response('success');
}

/** 拉几页就够了：一次 100 条，宕机后的积压也不该超过这个量；超了留给下一次回调 */
const MAX_PAGES = 5;

async function syncAndReply(integrationId: string, workspaceId: string, eventToken: string, callbackKfId?: string) {
  await runSerialized(integrationId, async () => {
    // secrets 现读现用：cursor 上一轮可能刚被更新，闭包里的旧快照会重放消息
    const it = await prisma.botIntegration.findUnique({ where: { id: integrationId } });
    if (!it) return;
    let secrets: BotSecrets = readBotSecrets(it.secretsEnc);
    if (!secrets.corpId || !secrets.appSecret) {
      // 缺凭据不能静默：此前这里直接 return，用户看到的只是「回调通了但永远不回话」
      await prisma.botIntegration
        .updateMany({ where: { id: integrationId }, data: { lastError: '缺企业 CorpID 或微信客服 Secret，无法拉取消息' } })
        .catch(() => {});
      return;
    }
    const { corpId, appSecret } = secrets;
    const kfIdHint = callbackKfId || secrets.openKfId;

    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await kfSyncMsg(corpId, appSecret, eventToken, secrets.kfCursor, kfIdHint);
      if (!r.ok) {
        await prisma.botIntegration
          .updateMany({ where: { id: integrationId }, data: { lastError: `sync: ${r.error}`.slice(0, 300) } })
          .catch(() => {});
        return;
      }

      // cursor 先落库再处理：处理途中崩了，宁可漏答一条（用户会再问），不可重放旧消息
      //（重放 = 同一个问题被答两遍，客服窗口里看起来像机器人抽风）
      secrets = {
        ...secrets,
        kfCursor: r.nextCursor ?? secrets.kfCursor,
        openKfId: secrets.openKfId ?? kfIdHint ?? r.msgs.find((m) => m.open_kfid)?.open_kfid,
      };
      await prisma.botIntegration
        .updateMany({
          where: { id: integrationId },
          data: { secretsEnc: writeBotSecrets(secrets), lastInboundAt: new Date(), lastError: null },
        })
        .catch(() => {});

      // 停用的机器人：cursor 照样推进（停用期间的消息就此丢弃，恢复后不会突然把积压全答一遍），但不回话
      if (it.enabled) {
        for (const m of r.msgs) await handleOne(integrationId, workspaceId, secrets, m);
      }
      if (!r.hasMore) break;
    }
  });
}

async function handleOne(integrationId: string, workspaceId: string, secrets: BotSecrets, m: KfMessage) {
  const corpId = secrets.corpId!;
  const appSecret = secrets.appSecret!;

  // 进入会话事件：发一条欢迎语作「身份行开场」（welcome_code 只在后台没配自动欢迎语时才给）
  if (m.msgtype === 'event' && m.event?.event_type === 'enter_session' && m.event.welcome_code) {
    const r = await kfSendWelcome(corpId, appSecret, m.event.welcome_code, await welcomeText(integrationId));
    if (!r.ok) log.warn('微信客服欢迎语发送失败', { integrationId, error: r.error });
    return;
  }

  // origin=3 才是微信用户发来的；5 是客服人员/我们自己发出的回执——处理它会自嗨循环
  if (m.origin !== 3) return;
  if (!m.msgid || !markSeen(integrationId, m.msgid)) return;

  const userId = m.external_userid;
  const kfId = m.open_kfid ?? secrets.openKfId;
  if (!userId || !kfId) return;

  let reply: string;
  if (m.msgtype !== 'text') {
    // 图片/语音/文件：静默不回等于装死。说清能看懂什么，用户才知道下一步怎么发
    reply = '目前只能看懂文字消息，图片、语音、文件请转成文字再发我。';
  } else {
    const text = (m.text?.content ?? '').trim();
    if (!text) return;
    reply = await handleInbound(workspaceId, text, {
      provider: 'wechat_kf',
      integrationId,
      // chatId 用 external_userid：客服会话是微信用户与客服号的一对一
      chatId: userId,
      senderId: userId,
      isGroup: false,
    });
  }

  const sent = await kfSendText(corpId, appSecret, kfId, userId, reply);
  if (!sent.ok) {
    log.warn('微信客服回复失败', { integrationId, error: sent.error });
    await prisma.botIntegration
      .updateMany({ where: { id: integrationId }, data: { lastError: `send: ${sent.error}`.slice(0, 300) } })
      .catch(() => {});
  } else {
    await prisma.botIntegration
      .updateMany({ where: { id: integrationId }, data: { lastOutboundAt: new Date() } })
      .catch(() => {});
  }
}

/** 欢迎语：绑了智能体就以它出面（与群里 @机器人 的身份行同一口径），没绑就是通用助手 */
async function welcomeText(integrationId: string): Promise<string> {
  const it = await prisma.botIntegration
    .findUnique({ where: { id: integrationId }, select: { agentTemplateId: true } })
    .catch(() => null);
  let who = '烽火台的 AI 运营助手';
  if (it?.agentTemplateId) {
    const tpl = await prisma.workflowTemplate
      .findUnique({ where: { id: it.agentTemplateId }, select: { name: true } })
      .catch(() => null);
    if (tpl?.name) who = `「${tpl.name}」（烽火台的智能体）`;
  }
  return `你好，我是${who}。直接发问题、文章链接或一句选题都行；发 /帮助 看我能做什么。`;
}
