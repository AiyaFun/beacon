import { prisma } from '../db';
import { isExternalProvider } from './types';
import { can } from '../rbac';
import { oaIdentity, memberByOaIdentity, type OaProvider } from '../auth/oa';
import { resolveAccount } from './accounts';
import { beaconUrl, sendToChat } from './index';
import type { InboundCtx } from './router';
import type { ToolContext } from '../agent/tools';

// ── 群里派任务：/派（一键任务卡）· /执行（一句话目标）· /任务 · /终止 ─────────────
//
// 【四条边界，一条都不能松】
// ① 谁能派：只有**绑定了企业应用身份**、且角色有 content.create 的成员。群是共享空间，
//    陌生群成员 @ 一句不能花租户的额度、动租户的数据——身份靠 Member.oaIdentity 对上。
// ② 可关：09-02 起默认开（DEFAULT_OFF_COMMANDS 已清空——①③两道闸本身就是关卡，不必再多勾一次），
//    管理员在设置页取消勾选即关；关了之后自然语言里的「帮我写一篇…」也只答不做。
// ③ 确认类永远回站内：/执行 走 origin:'api'（resolveAuth 强制 confirm_each，那道闸有守卫）；
//    /派 用卡上存的授权合同（与页面上点卡完全同权——resolveAuth 照样把「无人值守」压回确认档）。
//    群里**没有任何确认通道**：等确认时回执只给链接，点头必须去网页。
// ④ 闭环：派出的运行记 botChatRef，终态/等确认经 afterTransition 把回执发回本群；
//    /任务 /终止 只圈定 botChatRef 等于本群的运行，群成员碰不到站内或别的群派的任务。

/** 本群的回执地址。chatId 里可能出现任意字符，所以放在最后一段、解析时只切前两刀。 */
export function chatRefOf(provider: string, integrationId: string, chatId: string): string {
  return `${provider}:${integrationId}:${chatId}`;
}

function parseChatRef(ref: string): { provider: string; integrationId: string; chatId: string } | null {
  const first = ref.indexOf(':');
  if (first < 0) return null;
  const second = ref.indexOf(':', first + 1);
  if (second < 0) return null;
  return { provider: ref.slice(0, first), integrationId: ref.slice(first + 1, second), chatId: ref.slice(second + 1) };
}

/** 群里显示用的状态话术（与站内一致的语义，口语化）。 */
const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '正在跑',
  awaiting_confirm: '等确认（要到网页里点头）',
  waiting_browser: '等浏览器插件',
  waiting_quota: '等额度重置',
  done: '✅ 跑完了',
  failed: '❌ 没跑成',
  cancelled: '已终止',
};

/** 还没走到头的状态（可被 /终止）。与 lib/agent/run.ts 的 LIVE_STATUSES 同义，测试钉两边一致。 */
const LIVE = ['queued', 'running', 'awaiting_confirm', 'waiting_browser', 'waiting_quota'] as const;

type Dispatcher = { ok: true; ctx: ToolContext } | { ok: false; message: string };

/**
 * 这条群消息背后是谁：OA 身份 → 在职成员 → 与本工作区同租户 → 有创作权限。
 * 每一步失败都要说清下一步怎么办，而不是一句「没权限」。
 */
export async function resolveDispatcher(
  workspaceId: string,
  inbound: Pick<InboundCtx, 'provider' | 'senderId' | 'integrationId'>,
  boundAccountId: string | null,
): Promise<Dispatcher> {
  if (!inbound.senderId) {
    return { ok: false, message: '取不到你的企业应用账号，没法确认是谁在派任务（这个通道可能不支持带发送者身份）。' };
  }
  // 🔒 对外渠道：senderId 是微信 external_userid，对不上任何 OA 身份，也**不该**被映射成 feishu 身份去查——
  //    下面那行兜底把未知 provider 当 feishu，对微信来说等于拿一个陌生 ID 去撞成员表。
  if (isExternalProvider(inbound.provider)) {
    return { ok: false, message: '微信客服渠道无法确认你是哪位成员（这里的身份是微信用户 ID，不是企业应用身份）。派任务请到飞书/钉钉/企微机器人里，或在网页任务台发起。' };
  }
  let member: { id: string; tenantId: string; role: string } | null;
  if (inbound.provider === 'wechat') {
    // 微信 iLink：身份不是 OA，而是「扫码绑定时登录着的那个成员」（secrets.boundMemberId），且只认绑定的微信号。
    // 扫码要 byok.manage 权限——所以这条链上的人至少是管理员级别，比 OA 自动加入的成员身份更硬
    member = await ilinkOwnerMember(inbound.integrationId, inbound.senderId);
    if (!member) {
      return { ok: false, message: '这个微信号不是绑定这条机器人的那个号，或绑定它的成员已被停用——到网页「消息渠道」重新扫码绑定后再派。' };
    }
  } else {
    const provider = (inbound.provider === 'dingtalk' || inbound.provider === 'wecom' ? inbound.provider : 'feishu') as OaProvider;
    member = await memberByOaIdentity(oaIdentity(provider, inbound.senderId));
    if (!member) {
      return {
        ok: false,
        message: '派任务要先绑定身份：**私聊我**说「登录」（成员一键绑定），或说「绑定 <6 位码>」（码在网页「设置 → 账号与安全」里拿）。绑定过一次以后就不用再绑了。',
      };
    }
  }
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true, id: true } });
  if (!ws || ws.tenantId !== member.tenantId) {
    // 身份是真的，但绑在别的团队：如实说，不要让人以为绑定坏了
    return { ok: false, message: '你的身份绑在另一个团队上，不能给这个群背后的工作区派任务。' };
  }
  if (!can(member.role, 'content.create')) {
    return { ok: false, message: `你的角色（${member.role}）没有派任务的权限，找管理员把你提为编辑或以上。` };
  }
  const acct = await resolveAccount(workspaceId, { boundId: boundAccountId });
  if (!acct.ok) return { ok: false, message: acct.message };
  return {
    ok: true,
    ctx: {
      tenantId: member.tenantId,
      workspaceId,
      accountId: acct.account.id,
      memberId: member.id,
      role: member.role,
    },
  };
}

/** 微信 iLink 的派任务身份：senderId 必须是绑定的那个微信号，成员必须仍在职。 */
async function ilinkOwnerMember(integrationId: string | undefined, senderId: string) {
  if (!integrationId) return null;
  const it = await prisma.botIntegration.findUnique({ where: { id: integrationId }, select: { provider: true, secretsEnc: true } });
  if (!it || it.provider !== 'wechat') return null;
  const { readBotSecrets } = await import('./index');
  const secrets = readBotSecrets(it.secretsEnc);
  if (!secrets.boundMemberId || !secrets.ilinkUserId || secrets.ilinkUserId !== senderId) return null;
  return prisma.member.findFirst({
    where: { id: secrets.boundMemberId, status: 'active' },
    select: { id: true, tenantId: true, role: true },
  });
}

function shortGoal(goal: string, max = 40): string {
  const g = goal.trim().replace(/\s+/g, ' ');
  return g.length > max ? `${g.slice(0, max)}…` : g;
}

function runLink(runId: string): string {
  return beaconUrl(`/assistant?run=${runId}`);
}

/** /派 [卡名]：无参数列出可派的卡；有参数按名字匹配（不唯一就列候选，绝不猜）。 */
export async function cmdDispatchPreset(workspaceId: string, ctx: InboundCtx, arg: string, boundAccountId: string | null): Promise<string> {
  const chatRef = ctx.integrationId && ctx.chatId ? chatRefOf(ctx.provider ?? 'feishu', ctx.integrationId, ctx.chatId) : undefined;
  const presets = await prisma.taskPreset.findMany({
    where: { workspaceId, enabled: true },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, title: true, goal: true },
  });

  const name = arg.trim();
  if (!name) {
    if (presets.length === 0) {
      return `还没有一键任务卡。去「技能 · 连接器 → 智能体」右侧「反复要做的事」存一张，回来 /派 卡名 就能用 → ${beaconUrl('/workflows')}`;
    }
    return [
      '可以派的一键任务卡：',
      ...presets.map((p, i) => `${i + 1}. ${p.title} — ${shortGoal(p.goal)}`),
      '',
      '用法：/派 卡名（授权范围按卡上存的来；要点头的操作会停下来等你去网页确认）',
    ].join('\n');
  }

  const exact = presets.filter((p) => p.title === name);
  const hits = exact.length ? exact : presets.filter((p) => p.title.includes(name));
  if (hits.length === 0) {
    return `没找到叫「${name}」的一键任务卡。发「/派」看看现在有哪些。`;
  }
  if (hits.length > 1) {
    return `「${name}」匹配到多张卡：${hits.map((p) => p.title).join('、')}。请写全名。`;
  }

  const who = await resolveDispatcher(workspaceId, ctx, boundAccountId);
  if (!who.ok) return who.message;

  const { dispatchPreset } = await import('../agent/preset');
  const r = await dispatchPreset(who.ctx, { presetId: hits[0].id, origin: 'preset', botChatRef: chatRef });
  if (!r.ok) return `没派出去：${r.error}`;
  return [
    `✅ 已派出「${hits[0].title}」，${STATUS_LABEL[r.turn.status] ?? r.turn.status}。`,
    '授权按这张卡存的范围来；要你点头的操作会停下来，去网页确认（群里不能确认）。',
    `跑完/要确认时我会在群里说一声。看进度 → ${runLink(r.turn.runId)}`,
  ].join('\n');
}

/** 派活时出面的智能体（本会话选的，或渠道默认的）。见 router.ts 的 currentAgent。 */
export type DispatchAgent = { id: string; name: string; persona: string };

/**
 * /执行 <目标>：一句话派给 AI 执行器。走 origin:'api'，每个写/花钱动作都要到站内确认。
 * 自然语言里「帮我写一篇…」这类句子也走这里（lib/bot/intent 判成 run），与敲 /执行 完全同权。
 */
export async function cmdDispatchGoal(
  workspaceId: string,
  ctx: InboundCtx,
  goal: string,
  boundAccountId: string | null,
  agent: DispatchAgent | null = null,
): Promise<string> {
  const g = goal.trim();
  if (!g) return '用法：/执行 你要它做的事。例：/执行 看看我最近三天的作品数据，挑出表现最差的一条分析原因';

  const who = await resolveDispatcher(workspaceId, ctx, boundAccountId);
  if (!who.ok) return who.message;

  const chatRef = ctx.integrationId && ctx.chatId ? chatRefOf(ctx.provider ?? 'feishu', ctx.integrationId, ctx.chatId) : undefined;
  const { startAgentRun } = await import('../agent/run');
  try {
    // origin:'api'：resolveAuth 会把授权档强制成 confirm_each（那道闸有专门守卫）。
    // 群通道与对外 API 同一个待遇——它们都「人不在站内」，没有资格更宽。
    // 选了智能体就让它出面：身份与职责拼进系统提示，运行记录上也记着是谁跑的
    const turn = await startAgentRun(who.ctx, g, {
      origin: 'api',
      botChatRef: chatRef,
      ...(agent ? {
        agentTemplateId: agent.id,
        agentSystemPrompt: `你现在以智能体「${agent.name}」的身份承接这件事。它的职责：${agent.persona || '（未填写职责说明）'}`,
      } : {}),
    });
    return [
      `✅ ${agent ? `已交给「${agent.name}」，` : ''}任务已开始（${STATUS_LABEL[turn.status] ?? turn.status}）。`,
      '每一步会改数据或花额度的操作都会停下来等你去网页点头——想少点头就把这件事存成一键任务卡再 /派。',
      `跑完/要确认时我会在群里说一声。看进度 → ${runLink(turn.runId)}`,
    ].join('\n');
  } catch (e) {
    return `没派出去：${(e as Error).message.slice(0, 200)}`;
  }
}

/** /任务：本群派出的最近几条运行与状态。只看 botChatRef 等于本群的。 */
export async function cmdChatTasks(workspaceId: string, ctx: InboundCtx): Promise<string> {
  if (!ctx.integrationId || !ctx.chatId) return '这个通道取不到会话标识，看不了任务列表。';
  const chatRef = chatRefOf(ctx.provider ?? 'feishu', ctx.integrationId, ctx.chatId);
  const runs = await prisma.agentRun.findMany({
    where: { workspaceId, botChatRef: chatRef },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, goal: true, status: true, error: true },
  });
  if (runs.length === 0) return '这个群还没派过任务。用「/派」或「/执行 …」派一条。';
  return [
    '本群最近派出的任务：',
    ...runs.map((r) => `· ${STATUS_LABEL[r.status] ?? r.status} — ${shortGoal(r.goal)}${r.status === 'failed' && r.error ? `（${r.error.slice(0, 60)}）` : ''}`),
    `\n详情与确认 → ${beaconUrl('/runs')}`,
  ].join('\n');
}

/** /终止：停掉本群派出的、还没走到头的最新一条。只碰 botChatRef 等于本群的运行。 */
export async function cmdStopChatRun(workspaceId: string, ctx: InboundCtx, boundAccountId: string | null): Promise<string> {
  if (!ctx.integrationId || !ctx.chatId) return '这个通道取不到会话标识，没法定位要终止的任务。';
  const chatRef = chatRefOf(ctx.provider ?? 'feishu', ctx.integrationId, ctx.chatId);
  const run = await prisma.agentRun.findFirst({
    where: { workspaceId, botChatRef: chatRef, status: { in: [...LIVE] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, goal: true },
  });
  if (!run) return '本群没有还在跑的任务。';

  // 终止也要过身份闸：它会打断一次真实执行，和派出去是同一级别的操作
  const who = await resolveDispatcher(workspaceId, ctx, boundAccountId);
  if (!who.ok) return who.message;

  const { cancelAgentRun } = await import('../agent/run');
  try {
    await cancelAgentRun(who.ctx, run.id);
    return `🛑 已终止「${shortGoal(run.goal)}」。已经做完的步骤不会撤销，详情 → ${runLink(run.id)}`;
  } catch (e) {
    return `终止失败：${(e as Error).message.slice(0, 200)}`;
  }
}

/**
 * 运行走到「跑完/没跑成/等确认」时，把回执发回派它的那个群。
 * 由 lib/agent/run.ts 的 afterTransition 动态引入调用（去重也在那边借 notifyRunStatus 做了）。
 * 旁路增强：任何失败都不许影响执行本身，向外只回 boolean。
 */
export async function echoRunToChat(runId: string, status: string): Promise<boolean> {
  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, workspaceId: true, botChatRef: true, goal: true, status: true, answer: true, error: true },
    });
    if (!run?.botChatRef || run.status !== status) return false;
    const ref = parseChatRef(run.botChatRef);
    if (!ref) return false;

    const g = shortGoal(run.goal);
    const body =
      status === 'done'
        ? { title: `✅ 任务跑完了：${g}`, lines: [(run.answer ?? '').trim().slice(0, 300) || '已完成，点下面看它做了什么。'] }
        : status === 'failed'
          ? { title: `❌ 任务没跑成：${g}`, lines: [(run.error ?? '未说明原因').slice(0, 300)] }
          : status === 'waiting_browser'
            ? { title: `🧩 任务在等浏览器插件：${g}`, lines: ['这一步要在你的浏览器里采集，打开装了烽火台插件的浏览器它就会接着跑。'] }
            : status === 'waiting_quota'
              ? { title: `⏳ 任务在等额度：${g}`, lines: ['今天的 AI 额度用完了，额度重置后自动继续；急的话到网页里升级套餐。'] }
              : { title: `✋ 任务等你确认：${g}`, lines: ['下一步会改数据或花额度，到网页里点头它才继续（群里不能确认）。'] };

    // 定点回**派它的那个会话**（sendToChat），不是集成级广播——见 lib/bot/index.ts 那段注释
    const r = await sendToChat(run.workspaceId, ref.integrationId, ref.chatId, {
      kind: 'card',
      title: body.title,
      lines: body.lines,
      link: { text: '去看看', url: runLink(run.id) },
    });
    return r.ok;
  } catch {
    return false;
  }
}
