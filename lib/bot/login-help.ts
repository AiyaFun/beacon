import { prisma } from '../db';
import { log } from '../logger';
import { notify } from '../notify';
import { platformName } from '../constants';
import { beaconUrl, readBotSecrets, sendToChat } from './index';
import { dmImage, type BotImage } from './image';
import { parseChatRef } from './dispatch';

// 「卡在登录页了，把那一页发给我」（2026-09-17，用户：「遇到问题比如登录的话，
// 可以以截图的方式发送登录后，再进行采集」）。
//
// ─────────────── 这条路要解决的实际问题 ───────────────
// 群里 @机器人 派一次采集，活落到桌面执行器或整机自己的浏览器上。撞上登录墙时，
// 执行器**本来就会停在那一页等人登录**（desktop/src-tauri/src/executor.rs 的 wait_for_login）——
// 但用户此刻在手机上，他既不知道卡住了，也够不着那台机器。
// 而国内平台的登录几乎都是**扫码**：只要把那一页拍给他，他用手机一扫就登上了，
// 执行器判出已登录，接着把这次采集跑完。人不用回到电脑前。
//
// ─────────────── 一条安全线：二维码就是凭证 ───────────────
// 登录二维码谁扫谁就是**以他的身份登录**。所以：
//   · 只**私聊**发给**发起这次采集的那个人**（AgentRun.memberId → Member.oaIdentity）；
//   · 群里只留一句文字，不带图；
//   · 图不落库、不进任何素材表，转发完就丢（这也是为什么这里拿的是 Buffer 不是 URL）；
//   · 私发不出去（没配自建应用 / 认不出身份）时**宁可不发**，改成文字告诉他去哪看。
// 这三条在 tests/bot/login-help.test.ts 里各有一条守卫钉着。
//
// ─────────────── 限流 ───────────────
// 同一条任务最多求助 MAX_HELPS 次、两次之间至少隔 MIN_GAP_MS：
// 执行器每隔几秒重判一次登录状态，没有限流就会把人的私聊刷屏。
// 计数用的是站内通知本身（refId 前缀）——不额外加表、也不靠进程内状态（多实例会失效）。

export const MAX_HELPS_PER_TASK = 3;
export const MIN_GAP_MS = 90_000;

export type LoginHelpInput = {
  workspaceId: string;
  /** 这次求助属于哪条浏览器任务（排队那条路才有；整机当场跑时可以不给） */
  taskId?: string | null;
  /** 当场跑时直接给运行 id（整机版本机浏览器那条路） */
  runId?: string | null;
  platform?: string | null;
  /** 卡住的那一页 */
  url?: string | null;
  /** 执行器自己的说法（「小红书要登录才看得到」之类） */
  reason?: string | null;
  screenshot?: BotImage | null;
};

export type LoginHelpOutcome = {
  /** dm=二维码已私发 | chat=只在群里留了话 | notification=只写了站内通知 | skipped=限流 */
  delivered: 'dm' | 'chat' | 'notification' | 'skipped';
  /** 给执行器/日志看的一句话 */
  note: string;
};

function label(input: LoginHelpInput): string {
  const p = input.platform ? platformName(input.platform) : '';
  return p ? `${p}` : '这个站点';
}

/** 找「谁在等这条任务」：运行 → 派活的人 + 回执群。 */
async function locate(input: LoginHelpInput) {
  const run = input.runId
    ? await prisma.agentRun.findFirst({ where: { id: input.runId, workspaceId: input.workspaceId }, select: { id: true, memberId: true, botChatRef: true } })
    : input.taskId
      ? await prisma.agentRun.findFirst({
          where: { workspaceId: input.workspaceId, waitingOn: `browser:${input.taskId}` },
          orderBy: { updatedAt: 'desc' },
          select: { id: true, memberId: true, botChatRef: true },
        })
      : null;
  if (!run) return { run: null, member: null, chat: null };
  const member = run.memberId
    ? await prisma.member.findFirst({ where: { id: run.memberId }, select: { id: true, oaIdentity: true } })
    : null;
  const chat = run.botChatRef ? parseChatRef(run.botChatRef) : null;
  return { run, member, chat };
}

/** 限流：同一条任务最多几次、间隔多久。用站内通知当账本，不加表也不靠进程内状态。 */
async function throttleKey(input: LoginHelpInput): Promise<{ allowed: boolean; refId: string }> {
  const key = input.taskId || input.runId || 'adhoc';
  const prefix = `login-help:${key}`;
  const prior = await prisma.notification.findMany({
    where: { workspaceId: input.workspaceId, refId: { startsWith: prefix } },
    orderBy: { createdAt: 'desc' },
    take: MAX_HELPS_PER_TASK,
    select: { createdAt: true },
  }).catch(() => []);
  if (prior.length >= MAX_HELPS_PER_TASK) return { allowed: false, refId: `${prefix}:${prior.length}` };
  if (prior[0] && Date.now() - prior[0].createdAt.getTime() < MIN_GAP_MS) return { allowed: false, refId: `${prefix}:${prior.length}` };
  return { allowed: true, refId: `${prefix}:${prior.length}` };
}

/**
 * 求助一次：能私发就把那一页私发给派活的人，群里留一句话；私发不了就如实说为什么。
 * **绝不抛**——采集卡住已经够糟了，通知失败不该再把这次采集也带崩。
 */
export async function requestLoginHelp(input: LoginHelpInput): Promise<LoginHelpOutcome> {
  try {
    const { allowed, refId } = await throttleKey(input);
    if (!allowed) return { delivered: 'skipped', note: '刚提醒过，这次不重复打扰' };

    const what = label(input);
    const title = `${what}要登录才能继续采`;
    const body = [input.reason?.trim(), input.url ? `卡在：${input.url}` : ''].filter(Boolean).join('　');
    const { run, member, chat } = await locate(input);

    let delivered: LoginHelpOutcome['delivered'] = 'notification';
    let note = '已写一条站内通知';

    if (chat) {
      const integration = await prisma.botIntegration.findFirst({
        where: { id: chat.integrationId, workspaceId: input.workspaceId },
        select: { id: true, provider: true, inboundKey: true, webhookUrl: true, secretsEnc: true },
      });
      const oa = member?.oaIdentity ?? '';
      // oaIdentity 形如 `feishu:ou_xxx`；provider 对不上就不是同一个渠道的身份，不能拿去私发
      const userId = oa.startsWith(`${chat.provider}:`) ? oa.slice(chat.provider.length + 1) : '';

      let dmNote = '';
      if (integration && input.screenshot && userId) {
        const r = await dmImage({
          provider: integration.provider,
          secrets: readBotSecrets(integration.secretsEnc),
          inboundKey: integration.inboundKey,
          webhookUrl: integration.webhookUrl,
          userId,
          image: input.screenshot,
          caption: [
            `【${what}需要登录】采集卡在登录页了，下面这张就是那一页。`,
            '如果是二维码，用手机扫一下就行；登录完我会自己接着采，你不用再派一次。',
            '⚠️ 这张图等于一把钥匙，别转发给别人。',
            input.url ? `页面：${input.url}` : '',
          ].filter(Boolean).join('\n'),
        });
        if (r.ok) { delivered = 'dm'; note = '二维码已私发给你'; }
        else dmNote = r.error ?? '私聊没发出去';
      } else if (!input.screenshot) {
        dmNote = '执行器这次没给截图';
      } else if (!userId) {
        dmNote = '认不出你在这个群里的企业应用身份（要先绑定过账号）';
      } else {
        dmNote = '这个群绑的机器人集成找不到了';
      }

      // 群里那条**永远只有文字**：二维码不进群，这是这条路的硬约束
      const groupText = delivered === 'dm'
        ? `🔐 ${title}。那一页我已经私发给你了，扫完我接着采。`
        : `🔐 ${title}。${dmNote ? `（本来想把那一页私发给你，但${dmNote}）` : ''}去 ${beaconUrl('/runs')} 看这次运行，或到那台机器上登录一次。`;
      const sent = await sendToChat(input.workspaceId, chat.integrationId, chat.chatId, { kind: 'text', text: groupText }).catch(() => ({ ok: false }));
      if (delivered !== 'dm' && sent.ok) { delivered = 'chat'; note = '已在群里说了一声'; }
    }

    await notify({
      workspaceId: input.workspaceId,
      kind: 'system',
      refId,
      title,
      body: body || '采集停在登录页，等你登录后自动继续',
      link: '/runs',
      // 只给发起人：别人看到也推不动这件事（与 notify 的 memberId 口径一致）
      memberId: member?.id ?? null,
    });

    log.info('采集卡在登录页，已求助', { module: 'login-help', workspaceId: input.workspaceId, taskId: input.taskId ?? undefined, runId: run?.id, delivered });
    return { delivered, note };
  } catch (e) {
    log.warn('登录求助没发出去', { module: 'login-help', err: e instanceof Error ? e.message : String(e) });
    return { delivered: 'skipped', note: '提醒没发出去（不影响这次采集继续等）' };
  }
}
