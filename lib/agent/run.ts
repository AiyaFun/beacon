import { prisma } from '../db';
import { parseJson, toJson } from '../json';
import { llmComplete } from '../llm/gateway';
import { readPersona, personaPromptBlock } from '../persona';
import { accountsContextBlock } from './context-accounts';
import { buildMemoryContext } from '../memory/core';
import { can } from '../rbac';
import { createLogger } from '../logger';
import type { ChatMessage, ToolCall } from '../llm/types';
import {
  AGENT_TOOLS, toolByName, needsConfirm, resultForModel, toolTimeoutMs,
  type ToolContext, type AgentTool, type RunAuth, type AuthMode, DEFAULT_AUTH_MODE,
} from './tools';
import { toolsFor, disabledTools } from './tool-config';
import { dispatchOrderBlock } from './roles';
import { kickAgentRun } from './kick';
import { describeArgs } from './args-summary';
import { beijingEndOfDay } from '../beijing';
import type { QuotaScope } from '../quota';
import { notifyRunStatus } from './notify-run';
import { decideQueue, promoteQueued, queuePositionOf } from './queue';
import { budgetForTenant, callsUsed, toolCapReason } from './budget';
import { drainNotes, appendNote, pendingNoteCount } from './notes';
import { recordArtifacts, listArtifacts, type ArtifactView } from './artifacts';

const log = createLogger({ module: 'agent' });

// ── AI 全域调用执行器 ────────────────────────────────────────────────────────
//
// 一次运行 = 「模型想 → 要调工具 → （写操作先问人）→ 执行 → 把结果回灌给模型 → 再想」的循环。
//
// 【三条不许动的规矩】
// 1. **写操作与花钱操作一律先问人**。模型说要建草稿/采数据/烧额度时，执行器停下来，
//    把「它打算做什么、参数是什么」原样展示，用户点了确认才动手。拒绝也要如实回灌给模型
//    （告诉它「用户不同意」），否则它会以为执行了、接着往下编。
// 2. **Mock 模型下直接拒绝整个执行**。Mock 会编出一段像模像样的「我已经帮你建好了」——
//    在纯聊天里那只是示例文案（带 Mock 标），在这里却是**谎报执行结果**。没有真模型就明说没有。
// 3. **步数封顶**。模型有可能在两个工具之间来回打转，封顶是防止它把额度烧光的唯一护栏。

/**
 * 一次运行最多让模型说几轮话。到顶即停，如实告诉用户没做完。
 *
 * 【它数的是 rounds 不是 steps】早先这个常量叫 MAX_STEPS，注释写着「模型轮数」，
 * 判的却是**步骤流水的条数**——而一轮里调一次工具就会记两条（tool_call + tool_result）。
 * 于是写着 12 轮的上限，实际约等于 6 次工具调用；用户看到的是「才做了几步就说到上限了」。
 */
export const MAX_ROUNDS = 12;
/** 一轮里最多处理几个工具调用（模型偶尔会一口气要十几个）。 */
export const MAX_CALLS_PER_TURN = 5;
/** 存进库的对话上限，防止一次长运行把行撑到几 MB。 */
const MAX_MESSAGES_CHARS = 200_000;
/**
 * 执行租约时长。跑的过程中每轮续一次，所以它只需要大于「模型一轮 + 一批工具」的时间。
 * 太短会让另一个进程在这次还活着的时候把它接手过去（两条推理线写同一行）；
 * 太长会让一次真的崩掉的运行迟迟无人接手。
 */
const LEASE_MS = 10 * 60_000;

export type AgentStepView = {
  seq: number;
  kind: string;
  tool: string;
  label: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
};

export type PendingView = {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  /**
   * 参数的人话版，直接摆在确认卡上。
   *
   * 【为什么在服务端算】它要用工具注册表与平台名映射，那些都在服务端；
   * 而确认卡是客户端组件——把注册表 import 过去会把 prisma 一起打进浏览器包。
   */
  argsSummary: string;
  /** 这一步会花钱吗（界面上要说清楚） */
  costly: boolean;
};

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirm'
  | 'waiting_browser'
  | 'waiting_quota'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * 还没结束的状态。界面据此决定要不要接着轮询，清理据此决定不许删。
 *
 * **加新的挂起状态时必须同时收编进这里**，否则三道闸会各自把它当成「已经结束了」：
 * claimLease 抢不到它（永远续不上跑）、contextForRun 直接拒载、cancelAgentRun 终止不了它。
 * 三处都不报错，只是那次运行从此谁也叫不醒。
 */
export const LIVE_STATUSES: readonly AgentRunStatus[] = [
  'queued',
  'running',
  'awaiting_confirm',
  'waiting_browser',
  'waiting_quota',
];

export type AgentTurn = {
  runId: string;
  status: AgentRunStatus;
  /** 用户最初那句话。「换个说法重新派」要把它填回输入框 */
  goal: string;
  /**
   * 这次执行是不是我发起的。
   *
   * 【为什么界面需要知道】同事的运行也看得见（从运行中心点进来），那是刻意的——
   * 但确认、追问、接着跑**只有发起人做得了**（服务端会拒绝）。
   * 不告诉界面的话，同事看到的就是一排点了必定报错的按钮，
   * 而 /runs 不放确认按钮防的正是这件事。
   */
  mine: boolean;
  steps: AgentStepView[];
  answer?: string;
  error?: string;
  pending?: PendingView;
  /** 挂起时：在等什么（给界面一句人话，不是给模型看的） */
  waitingFor?: string;
  /**
   * 还有几句追问没送达。**界面必须标出来**——用户打完字就以为生效了，
   * 而它可能要等到下一轮才被读到（正在跑的那一轮已经把话说出口了）。
   */
  pendingNotes?: number;
  /** 这次执行做出来的东西（草稿、版本、图、发布计划…），点得进去 */
  artifacts?: ArtifactView[];
  /**
   * 这次烧了多少。
   *
   * 【为什么按 token 而不只按次数】长任务后段每次调用都背着接近上限的对话，
   * 单次成本是短调用的十倍量级。只报「调了 N 次」会让用户以为
   * 「10 次的任务只有 1 次的十倍贵」——实际差得远。
   */
  cost?: { calls: number; tokens: number };
};

/** 跟着状态一起写的那些列。刻意列全而不用 any：漏写一列是静默的，写错一列 tsc 会说。 */
type RunPatch = {
  pending?: string | null;
  waitingOn?: string | null;
  leaseUntil?: Date | null;
  quotaResumeAt?: Date | null;
  messages?: string;
  steps?: number;
  rounds?: number;
  episode?: number;
  callBudget?: number;
  answer?: string | null;
  error?: string | null;
};

/**
 * **改状态的唯一入口。** 只有当前状态确实是 from 之一时才写，写成了返回 true。
 *
 * 【为什么非收口不可】这次运行同时被两方推着走：后台那条推理线，和随时会按下
 * 「终止」的用户。原来每个分支各写各的 `update where id`，于是——
 * 用户在模型思考的那几十秒里点了终止，状态已经是 cancelled 了，
 * 这一轮回来照写不误，把它盖成 done / awaiting_confirm。
 * 用户看到的是「我明明点了终止，它却说已完成」，而且**没有任何报错**。
 *
 * 带 from 条件的 updateMany 就是一把乐观锁：状态被人动过，这次写自然落空，
 * 调用方拿到 false 就该安静退出——它已经不是这次运行的主人了。
 *
 * 挂在这里的还有后面几批要接的东西（通知、叫醒父运行、提拔排队中的运行），
 * 所以**不许绕过它直接写 status**（tests/agent/transition.test.ts 钉死了这条）。
 */
export async function transition(
  runId: string,
  from: AgentRunStatus | readonly AgentRunStatus[],
  to: AgentRunStatus,
  patch: RunPatch = {},
): Promise<boolean> {
  const fromList = typeof from === 'string' ? [from] : [...from];
  const r = await prisma.agentRun.updateMany({
    where: { id: runId, status: { in: fromList } },
    data: { status: to, ...patch },
  });
  if (r.count !== 1) return false;

  // ── 迁移成功之后要连带做的事。**都挂在这里而不是各个调用点** ──
  // 状态写点有七八处（做完/失败/等确认/等插件/等额度/判死/取消），每处都记得做这两件事
  // 是不可能的，而漏掉的后果都是静默的：漏通知=用户等一条永远不来的消息，
  // 漏提拔=排队的运行永远轮不上。
  await afterTransition(runId, fromList, to);
  return true;
}

/** 终态与挂起态：离开这些状态之前，这次运行不再占用「同时在跑」的名额。 */
const NOT_RUNNING: readonly AgentRunStatus[] = [
  'done', 'failed', 'cancelled', 'awaiting_confirm', 'waiting_browser', 'waiting_quota',
];

const TERMINAL: readonly AgentRunStatus[] = ['done', 'failed', 'cancelled'];

async function afterTransition(runId: string, from: readonly AgentRunStatus[], to: AgentRunStatus): Promise<void> {
  // ① 通知（旁路，自己吞错）
  const freshNotify = await notifyRunStatus(runId, to);

  // ①½ 群机器人派的运行：把「跑完了/没跑成/等确认」回执发回派它的那个群。
  //    与①同理挂在咽喉上（终态有七八处写点）；动态 import 免得 agent 静态引 bot 绕成环。
  //    只有 botChatRef 非空的运行才会真的发（站内/API/定时派的此列为 NULL，零影响）。
  //    【去重直接借①的返回值】叫醒重投会让同一个 (runId,状态) 走到这里两次，
  //    notifyRunStatus 已按 (runId,状态,episode) 去过重——它没发的，群里也不该再说一遍。
  //    2026-09-03 起 waiting_browser / waiting_quota 也回：跑了几分钟卡在「等插件」「等额度」，
  //    群里的人不知道它在等什么、要不要去开插件——那正是最需要说一声的时候。
  if (freshNotify && ['done', 'failed', 'awaiting_confirm', 'waiting_browser', 'waiting_quota'].includes(to)) {
    const { echoRunToChat } = await import('../bot/dispatch');
    await echoRunToChat(runId, to).catch(() => {});
  }
  //    进度卡（飞书）：任何状态变化都把那张卡改成当前状态（强制，不受节流）——
  //    否则任务跑完了卡上还写着「正在跑」。
  void import('../bot/progress').then((m) => m.updateProgressCard(runId, { force: true })).catch(() => {});

  // ② 我要是别人派出来的子运行，跑完了得叫醒那个正挂着等我的父运行。
  //    **挂在这里而不是各个终态写点**：终态有七八处，每处都记得叫一次是不可能的，
  //    而漏掉的后果是父运行永久挂着（它自己不会去查）。
  if (TERMINAL.includes(to)) {
    const { wakeParentIfChild } = await import('./child-run');
    await wakeParentIfChild(runId).catch(() => {});

    // 定时派出来的：把成败回写到那条计划上（连败三次自动停用靠它）。
    // **同样挂在这里而不是各个终态写点**——异步派发那一刻拿不到结局，
    // 不在这儿回写的话 failStreak 永远不累加，配坏的定时会每天准点烧配额且永不自停。
    const { reportScheduleOutcome } = await import('./preset');
    await reportScheduleOutcome(runId).catch(() => {});
  }

  // ③ 腾出名额就提拔排队最久的那个。
  //    判据是「**从 running 走掉了**」：queued→cancelled 之类的迁移没有腾出任何东西
  //    （它本来就没在跑），跟着提拔会让并发悄悄超过上限。
  const wasRunning = from.includes('running');
  if (wasRunning && NOT_RUNNING.includes(to)) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { workspaceId: true } });
    if (run) await promoteQueued(run.workspaceId).catch(() => null);
  }
}

/**
 * 不改状态、只补数据的写（对话、流水计数、租约）。
 *
 * 同样要带状态条件：一次已经被取消的运行不该再被写进新的对话内容。
 * 它不会造成状态复活（那是 transition 的活），但会让终止后的记录继续长出内容来。
 */
async function patchRun(runId: string, expect: AgentRunStatus | readonly AgentRunStatus[], patch: RunPatch): Promise<void> {
  const expectList = typeof expect === 'string' ? [expect] : [...expect];
  await prisma.agentRun.updateMany({ where: { id: runId, status: { in: expectList } }, data: patch });
}

/**
 * 「写操作会不会先问你」这句话，**必须跟着这次执行的授权档走**。
 *
 * 写死一句「会先弹给用户确认」的后果不是提示词不准，是**让模型替我们撒谎**：
 * 预授权的运行里它会照着这句对用户说「这一步我会先问你」，然后直接做了。
 * 本项目 08-13 审计过 11 条「文案与实际行为相反」，这是同一个形状。
 */
function writeConfirmLine(authMode: string): string {
  if (authMode === 'preauthorized') {
    return '- 写操作（建草稿、加对标、采数据、生成选题）用户已经**提前授权**了一批：'
      + '授权范围内的直接做，范围外的仍会停下来等他点头。';
  }
  if (authMode === 'unattended') {
    return '- 写操作（建草稿、加对标、采数据、生成选题）**直接做，不用停下来问**——用户要的就是一口气跑完。'
      + '**但**建发布计划、写长期记忆、配定时、拼新智能体这几样仍然会停下来等他确认。';
  }
  return '- 写操作（建草稿、加对标、采数据、生成选题）会先弹给用户确认，用户同意后才真正执行。';
}

function systemPrompt(personaBlock: string, memoryBlock: string, toolNames: string[], authMode: string, accountsBlock = ''): string {
  return [
    '你是「烽火台」内容创作 SaaS 里的 AI 助手，除了回答问题，你还能**直接操作这个系统**。',
    '',
    '可用工具：' + toolNames.join('、') + '。',
    '',
    '工作方式：',
    '- 需要系统里的真实数据时，**必须先调工具查**，不许凭印象编。查不到就说查不到。',
    // 【2026-08-26 真机反馈「应该智能点，不要每次都询问」】那次它先反问要主页链接、
    // 自己又查到 6 个监控账号、然后又停下问「采哪个」——用户说的就是「都采一下」。
    // 反问是把用户当成执行器的一部分；目标含糊时按最合理的默认做完再说明取舍，才是「去做」。
    '- **不要停下来反问**。目标里没写明的细节，按最合理的默认去做：让你采竞对没点名＝监控列表里**全部**；没说数量＝常规量；没说时间范围＝最近的。做完在结果里说明你的取舍。',
    '- 反问之前必须先把能查的都查了（list_ 开头的工具）；查完能定的就自己定。整次执行**至多反问一次**，且只在查遍了仍无法继续时。',
    writeConfirmLine(authMode),
    '- 用户拒绝某一步时，不要重复请求同一个操作，换个思路或直接告诉他你的建议。',
    '- 工具返回里标了「示例数据」的内容，转述时必须一并说明它是示例，不能当成真实数据下结论。',
    '- 全部做完后，用中文简短说清楚你做了什么、结果如何。别复述 JSON。',
    // ── 事前计划（2026-08-29）──
    // 【为什么要这一段】此前用户看到的是 appendStep 的**事后**步骤流：每做完一步冒一行。
    // 一件要跑七八分钟的活，前几十秒他看到的是空白——不知道要做几步、也不知道还剩多少。
    // 让模型先把打算做的事说出来，等待就从「白屏」变成「看着它推进」。
    // 【为什么是「说出来」而不是新造一个计划字段】计划要是落成结构化数据，就得有人保证
    // 它和实际执行对得上——而模型完全可能中途改主意（那往往是对的）。
    // 计划只是给人看的一句话，实际做了什么以步骤流为准，两者不必强行一致。
    '',
    '开工前先说计划：',
    '- 需要**两步以上**才能完成的活，第一句话先列出你打算怎么做（三到六条，每条一行，用「1. 2. 3.」）。',
    '- 一句话能答的、或只需一次工具调用的，**不要列计划**——那只是噪音。',
    '- 计划是给用户看的，不是合同：中途发现更好的路就改，改了在结果里说一声即可。',
    // 光在工具清单里列出 list_agents/list_skills 是不够的：模型会倾向于自己一步步做，
    // 那几个工具就成了摆设。派活次序从 lib/agent/roles.ts 生成——**界面上写给用户看的
    // 那四类分工，和模型看到的是同一份**，改一句话两头一起变，不会出现「帮助页说
    // 技能优先，模型却从来不调技能」这种对不上又不会报错的情况。
    '',
    dispatchOrderBlock(authMode),
    '',
    // 长期记忆只装账号的事实，不装「上次做这件事发生了什么」——那在过去的执行记录里
    '- 像是做过的活、或想知道上次某个账号/平台采集是什么情况，先用 search_past_runs 翻过去的执行记录，别把同一个坑再踩一遍。',
    '',
    '认人的次序：先 list_agents（一整套）→ 再 list_skills（一次成品）。',
    '- 它们各自带着「什么时候该派我上」的说明，照着挑，别只看名字猜。',
    authMode === 'confirm_each'
      ? '- run_agent / run_skill 都会花较长时间并消耗额度，和别的写操作一样要先经用户确认。'
      : '- run_agent / run_skill 都会花较长时间并消耗额度，用之前先想清楚这一步值不值。',
    '- 技能作用在**某一篇草稿**上：先 list_drafts 拿到 draft_id，跑完结果会存成那篇草稿的新版本。',
    '- 定时计划与新智能体你可以**起草**（draft_schedule / draft_workflow），但落库前会停下来让用户确认——',
    '  那是会在他睡着时花钱的合约，不能由你一个人签。起草前先 list_schedules 看有没有重复的。',
    '- 说时间一律带上「北京时间」四个字，并且只能配整十分（09:00 / 09:10 …）。',
    '',
    // 不教这一段的话，模型遇到「服务端没有的数据」只会干说「我拿不到」——
    // 而插件恰恰能拿到，只是要排队等它醒来
    '关于浏览器插件（有些数据服务端拿不到）：',
    '- 完播率、粉丝画像这类**只有创作后台才有**的指标，以及竞对主页要翻很多页才够的作品，',
    '  服务端都拿不到。别编，也别只说「拿不到」——用 dispatch_browser_task 把这件事排给用户的插件。',
    '- 它是**排队**：插件要等用户下次打开浏览器才会跑。所以排完要如实说「已排给插件，还没有数据」，',
    '  绝不能说成「已经采好了」。用户问进度时用 list_browser_tasks 看。',
    '- 手上的数据够回答问题时就直接回答，不要每次都派活——那只会让用户等一个他不需要的采集。',
    '',
    personaBlock,
    // 账号清单 + 插件状态：用户说「我的 X 账号」时它得知道那是哪一条、能不能派（2026-09-03）
    accountsBlock ? '\n' + accountsBlock : '',
    memoryBlock ? '\n' + memoryBlock : '',
  ].join('\n');
}

async function loadContext(ctx: ToolContext): Promise<{ persona: string; memory: string; accounts: string }> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: ctx.accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');
  const [memory, accounts] = await Promise.all([
    buildMemoryContext(ctx.workspaceId, ctx.accountId).catch(() => ''),
    accountsContextBlock({ workspaceId: ctx.workspaceId, accountId: ctx.accountId }),
  ]);
  return { persona: personaPromptBlock(persona), memory, accounts };
}

type RunRow = {
  id: string;
  workspaceId: string;
  accountId: string | null;
  memberId: string;
  status: string;
  messages: string;
  pending: string | null;
  waitingOn: string | null;
  steps: number;
  rounds: number;
  callBudget: number;
  toolAllowlist: string;
};

/**
 * 记一条步骤流水。
 *
 * 【为什么外键错误只记不抛】执行改到后台之后，这条线可能比它的记录活得更久：
 * 到期清理删掉了那次运行、工作区被删级联带走了它。那时候「记不下这一步」
 * 不是故障，是这次运行已经与谁都无关了——抛出去只会在日志里留下一条
 * 吓人但没有意义的 ERROR，而真正该做的（安静收工）循环下一轮自己会做。
 * 别的写库错误照抛：那才是真的出了问题。
 */
async function appendStep(
  runId: string,
  seq: number,
  step: { kind: string; tool?: string; args?: unknown; result?: string; ok?: boolean },
): Promise<void> {
  try {
    await prisma.agentStep.create({
      data: {
        runId,
        seq,
        kind: step.kind,
        tool: step.tool ?? '',
        args: toJson(step.args ?? {}),
        result: (step.result ?? '').slice(0, 4000),
        ok: step.ok ?? true,
      },
    });
    // 群里派出的运行：把那张进度卡改成「已走 N 步 · 最近：xxx」（有节流；站内派的没有卡，查一下就返回）
    void import('../bot/progress').then((m) => m.updateProgressCard(runId)).catch(() => {});
  } catch (err) {
    const gone = await prisma.agentRun.count({ where: { id: runId } });
    if (gone > 0) throw err;
    log.info('运行记录已被删除，这一步不再记录', { runId, kind: step.kind });
  }
}

/**
 * 挂起时给界面的一句人话。**按挂在什么上分开写**：
 * 两种等待里用户该做的事完全不同（一个要去开浏览器，一个什么都不用做），
 * 都印成「等你的插件」会让撞了额度的人白等一场。
 */
function waitingText(
  status: AgentRunStatus,
  quotaResumeAt: Date | null,
  queuePosition = 0,
  waitingOn?: string | null,
): string | undefined {
  if (status === 'waiting_browser') {
    // 【三种等待，用户该做的事完全不同】全印成「等你的浏览器插件」的话，
    // 等智能体跑完的人会跑去开浏览器，而那件事跟浏览器毫无关系。
    if (waitingOn?.startsWith('workflow:')) return '派出去的智能体正在跑，它跑完就自动接着做';
    if (waitingOn?.startsWith('run:')) return '派出去的子任务正在跑，它跑完就自动接着做';
    return '已把活排给你的浏览器插件，等它下次醒来跑完就自动接着做';
  }
  if (status === 'waiting_quota') {
    const at = quotaResumeAt ? beijingClock(quotaResumeAt) : '北京时间 0 点';
    return `今日 AI 额度用完了，${at}重置后会自动接着跑，你不用管它`;
  }
  if (status === 'queued') {
    // 说清楚「在排队」而不是「正在跑」：这两件事对用户的意义完全不同——
    // 排队意味着它一步都还没开始，而前面那些跑完之前它不会动
    const where = queuePosition > 0 ? `排在第 ${queuePosition} 位` : '在排队';
    return `同时在跑的任务已经满了，这一条${where}，前面的跑完就自动开始`;
  }
  return undefined;
}

/** 把恢复时刻讲成北京时间的人话（「今天 0 点 / 明天 0 点」这种精度就够了）。 */
function beijingClock(d: Date): string {
  const today = beijingEndOfDay(new Date()).getTime();
  return d.getTime() <= today ? '今晚 24 点（北京时间）' : '北京时间次日 0 点';
}

async function viewOf(runId: string, viewerId?: string): Promise<AgentTurn> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agentSteps: { orderBy: { seq: 'asc' } } },
  });
  if (!run) throw new Error('运行记录不存在');
  // 排第几位要现算（前面的跑完了它就往前挪），只在真排着队时查一次
  const queuePosition = run.status === 'queued' ? await queuePositionOf(run) : 0;
  const notesPending = await pendingNoteCount(runId);
  const artifacts = await listArtifacts(runId);
  const cost = await runCost(runId);
  const pendingCall = run.pending ? parseJson<ToolCall | null>(run.pending, null) : null;
  const pendingTool = pendingCall ? toolByName(pendingCall.name) : null;
  // pending 这一列身兼两职（等你点头 / 等浏览器回来），但界面上只有前者该出确认卡。
  // 不按状态分的话，一次「等插件」会渲染成一张点了也没用的确认卡。
  const awaitingConfirm = run.status === 'awaiting_confirm';
  return {
    runId: run.id,
    status: run.status as AgentRunStatus,
    goal: run.goal,
    mine: viewerId ? run.memberId === viewerId : false,
    answer: run.answer ?? undefined,
    error: run.error ?? undefined,
    waitingFor: waitingText(run.status as AgentRunStatus, run.quotaResumeAt, queuePosition, run.waitingOn),
    pendingNotes: notesPending || undefined,
    artifacts: artifacts.length ? artifacts : undefined,
    cost: cost.calls > 0 ? cost : undefined,
    steps: run.agentSteps.map((s) => ({
      seq: s.seq,
      kind: s.kind,
      tool: s.tool,
      label: toolByName(s.tool)?.label ?? s.tool,
      args: parseJson<Record<string, unknown>>(s.args, {}),
      result: s.result,
      ok: s.ok,
    })),
    pending:
      awaitingConfirm && pendingCall && pendingTool
        ? (() => {
            const args = parseJson<Record<string, unknown>>(pendingCall.arguments, {});
            return {
              tool: pendingCall.name,
              label: pendingTool.label,
              args,
              argsSummary: describeArgs(args),
              costly: pendingTool.costly === true,
            };
          })()
        : undefined,
  };
}

/**
 * 开始一次运行：建库记录 → **踢给后台** → 立刻把「已经开始了」返回给用户。
 *
 * 【为什么不在这里跑完】原来这里是同步跑到底的，于是：关掉页面 = 执行被掐断在半路；
 * 一次多步执行要占住整个请求；而「派活给插件然后等它回来」这种要等几小时的事根本无从谈起。
 * 现在这个函数只负责把这次运行**记下来**，往前推是后台的事（lib/agent/kick.ts）。
 *
 * 代价是调用方拿到的是一个 status=running、steps 为空的快照——界面要靠轮询把后续读回来。
 * 这笔账是划算的：用户看到的第一帧从「转圈几十秒」变成「立刻有一条任务」。
 */
export type StartRunOptions = {
  /**
   * 谁发起的。api 那种在下面被**强制**回 confirm_each，见注释。
   * bot = 群机器人里派的（/执行、自然语言）：与页面同权，缺省直接跑完。
   */
  origin?: 'manual' | 'preset' | 'schedule' | 'api' | 'bot';
  /** 授权档。不传按 DEFAULT_AUTH_MODE（直接跑完）；对外 API 例外，见 resolveAuth。 */
  authMode?: AuthMode;
  /** 预授权勾定的工具名。**只在 authMode=preauthorized 时有意义**。 */
  preauthorizedTools?: readonly string[];
  /** 这次最多烧几次模型调用。不传按套餐档。 */
  callBudget?: number;
  /** 谁派出来的子运行（自主智能体）。非空即「我是子运行」，它自己不许再往下派。 */
  parentRunId?: string;
  /** 哪个自主智能体在跑这次执行 */
  agentTemplateId?: string;
  /** 那个智能体的人设，拼在系统提示词后面 */
  agentSystemPrompt?: string;
  /** 定时派的话记下是哪一条——连败自停闸靠它在终态时回写 */
  scheduledAgentId?: string;
  /** 群机器人派的话记下回哪儿（`<provider>:<integrationId>:<chatId>`）——终态回执与 /任务 /终止 靠它 */
  botChatRef?: string;
  /**
   * 这次只许用这些工具（自主智能体的白名单，**已经与用户自己的权限求过交集**）。
   * 不传 = 用户有权用的全都能用。
   */
  toolAllowlist?: readonly string[];
};

export async function startAgentRun(ctx: ToolContext, goal: string, opts: StartRunOptions = {}): Promise<AgentTurn> {
  const trimmed = goal.trim().slice(0, 2000);
  if (!trimmed) throw new Error('先说说你想让我做什么');

  const tools = await toolsForRun(ctx, opts.toolAllowlist);
  if (tools.length === 0) {
    throw new Error('你的角色没有任何可执行的权限，AI 助手无法代你操作系统');
  }
  // 授权档要先定下来：系统提示词里那句「会不会先问你」是**按它拼的**，
  // 拼错了就是让模型替我们对用户撒谎（预授权的运行里说「这一步我会先问你」然后直接做了）。
  const auth = resolveAuth(opts);

  const { persona, memory, accounts } = await loadContext(ctx);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        systemPrompt(persona, memory, tools.map((t) => `${t.name}(${t.label})`), auth.authMode, accounts)
        // 智能体的人设拼在最后：它是对通用助手的**补充**，不是替换——
        // 替换掉的话那几条硬规矩（不许编数据、Mock 不许假装执行）就随人设一起丢了
        + (opts.agentSystemPrompt ? `\n\n【你这次的角色】\n${opts.agentSystemPrompt}` : ''),
    },
    { role: 'user', content: trimmed },
  ];

  // 这个工作区已经有几个在跑了？满了就先排队（排队满了 decideQueue 会当场拒绝）。
  const decision = await decideQueue(ctx.workspaceId);

  const run = await prisma.agentRun.create({
    data: {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      memberId: ctx.memberId,
      goal: trimmed,
      status: decision.status,
      messages: toJson(messages),
      origin: opts.origin ?? 'manual',
      authMode: auth.authMode,
      preauthorizedTools: toJson(auth.preauthorizedTools),
      callBudget: opts.callBudget ?? (await budgetForTenant(ctx.tenantId)),
      parentRunId: opts.parentRunId ?? null,
      agentTemplateId: opts.agentTemplateId ?? null,
      scheduledAgentId: opts.scheduledAgentId ?? null,
      botChatRef: opts.botChatRef ?? null,
      toolAllowlist: toJson([...(opts.toolAllowlist ?? [])]),
    },
  });
  // 排队的不踢：它要等前面的让位（transition 里的提拔会来叫它）。
  // 这里踢一脚是无害但无用的——claimLease 只抢 running 的行。
  if (decision.status === 'running') kickAgentRun(run.id);
  return viewOf(run.id, ctx.memberId);
}

/**
 * 定下这次执行的授权档。
 *
 * 【为什么 api 要在这里强制覆写，而不是「调用方不传就行」】
 * 对外调用面（/api/v1/runs、MCP）刻意不暴露授权档，理由是那头坐着的常常是**另一个模型**——
 * 模型 A 起草、模型 B 代签，那条「写操作必须有人点头」的规矩就等于没有。
 * 但「接口不收这个参数」是一句**随时会被下一次改动破坏**的保证：将来任何人给
 * startAgentRun 接上「模板自带的缺省授权档」，API 面就跟着静默升权，而且不会有任何测试变红。
 * 所以判定放在这里——一个所有调用方都绕不过去的地方。
 */
function resolveAuth(opts: StartRunOptions): { authMode: AuthMode; preauthorizedTools: string[] } {
  if (opts.origin === 'api') return { authMode: 'confirm_each', preauthorizedTools: [] };

  // 【2026-09-03 缺省改为直接跑完】此前缺省是 confirm_each，且 unattended 只有定时派的才放行，
  // 页面/桌面端/群里派的活每一步写操作都要回来点头。用户拍板：「无论在群里派发任务还是在
  // 页面桌面端，只要是任务，就要直接去完成」。于是：
  //   · 缺省档 = unattended，页面/群/预设/定时都一样；想逐步确认的在派发卡上自己选；
  //   · 对外 API 仍强制 confirm_each（上面那一行，另一个模型代签的风险没变）；
  //   · 签合约那几样（发布计划/长期记忆/定时/新智能体）仍由 needsConfirm 的机制级闸拦住——
  //     那些做完会一直生效，不随这次改动放开。
  const mode: AuthMode = opts.authMode ?? DEFAULT_AUTH_MODE;
  // 白名单只在预授权档有意义。别的档留着它没有用处，反而会在将来改档时变成一份
  // 「谁也不记得是什么时候勾的」的授权
  const list = mode === 'preauthorized' ? [...new Set(opts.preauthorizedTools ?? [])] : [];
  return { authMode: mode, preauthorizedTools: list };
}

/** 用户对当前 pending 的写操作做出决定。approve=false 表示拒绝（照样把结果回灌给模型）。 */
export async function decidePendingCall(ctx: ToolContext, runId: string, approve: boolean): Promise<AgentTurn> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, workspaceId: ctx.workspaceId } });
  if (!run) throw new Error('运行记录不存在');
  if (run.status !== 'awaiting_confirm' || !run.pending) return viewOf(runId, ctx.memberId);
  // 只有发起人能确认：别人替他点确认，等于用他的权限做他没同意的事。
  if (run.memberId !== ctx.memberId) throw new Error('只有发起这次执行的人能确认或拒绝');

  const call = parseJson<ToolCall | null>(run.pending, null);
  if (!call) {
    if (await transition(runId, 'awaiting_confirm', 'running', { pending: null })) kickAgentRun(runId);
    return viewOf(runId, ctx.memberId);
  }

  // 【先抢占，再执行】这一段原来是「读一次状态 → 直接执行工具 → 才写状态」，
  // 中间没有任何互斥：两个并发请求都能通过状态检查，于是**同一个写操作被执行两遍**
  //（真的建出两篇草稿）——乐观锁只保证第二次 transition 落空，而工具早跑完了。
  //
  // 现实触发面比「双击」宽得多：run_agent(20 分钟) / generate_image(8 分钟) 是同步跑在
  // server action 里的，反代 60 秒就断，用户看到失败再点一次就是第二次真实付费执行；
  // 两个标签页同时开着 /assistant?run=xxx 也够。
  //
  // 用 pending 本身做抢占标记：把它置空的那个请求才有权执行，另一个当场退出。
  const claimed = await prisma.agentRun.updateMany({
    where: { id: runId, status: 'awaiting_confirm', pending: { not: null } },
    data: { pending: null },
  });
  if (claimed.count !== 1) return viewOf(runId, ctx.memberId); // 别人已经在处理这一步了

  const messages = parseJson<ChatMessage[]>(run.messages, []);
  let seq = run.steps;

  if (!approve) {
    messages.push({ role: 'tool', toolCallId: call.id, content: toJson({ ok: false, error: '用户拒绝了这次操作' }) });
    await appendStep(runId, ++seq, { kind: 'rejected', tool: call.name, args: parseJson(call.arguments, {}), result: '用户拒绝执行', ok: false });
    if (await transition(runId, 'awaiting_confirm', 'running', { messages: capMessages(messages), pending: null, steps: seq })) {
      kickAgentRun(runId);
    }
    return viewOf(runId, ctx.memberId);
  }

  // 【确认后的这一次工具执行仍然在这里同步做】它是用户刚刚亲手点下去的，
  // 页面上那个按钮该等到「这一步做完了没有」。再往后的推理才是后台的事。
  // 真正长的活（跑一整个智能体）由 executeCall 的超时闸兜底。
  // 【必须把 runId 带上】产物登记挂在 executeCall 里，判据是 `ctx.runId`——
  // 而这里的 ctx 来自 server action，**它不带 runId**。少了这一下，
  // 凡是走确认闸执行的写操作，产物一律静默丢弃。
  // 而默认档（confirm_each）下写操作**全都**走确认闸，等于产物清单整个是死的：
  // 真机第一次验就撞上了——草稿建出来了（0→1），清单却是空的。
  const executed = await executeCall({ ...ctx, runId }, call);
  await appendStep(runId, ++seq, {
    kind: 'tool_result', tool: call.name, args: parseJson(call.arguments, {}), result: executed.message, ok: executed.ok,
  });

  if (executed.waitFor) {
    // park 会把 pending 重新写上（叫醒时要靠它把结果对回去）——
    // 上面抢占时清掉的那次只是为了互斥
    await park(runId, 'awaiting_confirm', call, executed, messages, seq);
    return viewOf(runId, ctx.memberId);
  }

  messages.push({ role: 'tool', toolCallId: call.id, content: executed.message });
  if (await transition(runId, 'awaiting_confirm', 'running', { messages: capMessages(messages), pending: null, steps: seq })) {
    kickAgentRun(runId);
  }
  return viewOf(runId, ctx.memberId);
}

/**
 * 把这次运行停在「等外面的事」上。
 *
 * 【关键：这一步的 tool 消息现在**不写进对话**】一次 tool_call 在对话里只该有一条
 * tool 回复，而那条回复的内容应该是**最终结果**（「采到了 12 条」），不是「已排队」。
 * 所以对话里先留着悬空的 tool_call，等叫醒时再补上真结果——反正挂起期间这份对话
 * 一次也不会送给模型。
 *
 * 步骤列表（给人看的审计流水）则相反：**现在就记一条**「已排给插件」。
 * 用户要能立刻看到自己那句话变成了一件正在办的事，而不是盯着一片空白。
 * 两边刻意不一致，各自服务各自的读者。
 */
async function park(
  runId: string,
  from: AgentRunStatus,
  call: ToolCall,
  executed: CallOutcome,
  messages: ChatMessage[],
  seq: number,
): Promise<void> {
  await transition(runId, from, 'waiting_browser', {
    // pending 存的是「停在哪次调用上」——叫醒时靠它把结果按 toolCallId 对回去
    pending: toJson(call),
    waitingOn: executed.waitFor,
    messages: capMessages(messages),
    steps: seq,
    leaseUntil: null,
  });
}

/**
 * 跑着跑着（或跑完之后）用户又说了一句话。
 *
 * 【三种情形，都走这一个入口】
 *   还在跑     —— 记下来，下一轮开头它就读到了
 *   停着等确认 —— 记下来，跟着这次「确认/拒绝」一起送进去
 *   已经结束   —— **同一条运行接着跑**（不新开一条），状态回 running、预算再给一段
 *
 * 【为什么终态续跑必须是同一条运行】新开一条的话，它不知道前面查过什么、
 * 建过什么草稿——用户说「刚才那篇标题再改改」，新运行只能从头再查一遍，
 * 而且很可能得出不一样的结论。上下文本身就是这次执行最值钱的东西。
 *
 * 【只有发起人能追问】与确认同一条理由：这次执行按他的权限跑，
 * 别人往里塞一句话就等于用他的权限做他没同意的事。
 */
export async function appendUserNote(ctx: ToolContext, runId: string, text: string): Promise<AgentTurn> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, workspaceId: ctx.workspaceId } });
  if (!run) throw new Error('运行记录不存在');
  if (run.memberId !== ctx.memberId) throw new Error('只有发起这次执行的人能接着追问');

  const t = text.trim();
  if (!t) throw new Error('说点什么吧');

  await appendNote(runId, t);

  // 已经结束的：把它叫起来接着跑。
  // 预算再给一段（不给的话它一睁眼就撞上「额度用完」的收尾轮），
  // 轮数从头算（防打转的那道闸是针对**一段连续推理**的，新的一段该重新计数）。
  const ENDED: readonly AgentRunStatus[] = ['done', 'failed', 'cancelled'];
  if (ENDED.includes(run.status as AgentRunStatus)) {
    const extra = await budgetForTenant(ctx.tenantId);
    const ok = await transition(runId, ENDED, 'running', {
      rounds: 0,
      // 激活段 +1：通知的去重键带着它，不然「第二次跑完」会被当成重复而静默——
      // 而追问的人正是最想知道结果的那个
      episode: run.episode + 1,
      callBudget: run.callBudget + extra,
      // 【必须是 null 不能是 undefined】Prisma 会把 undefined 的键**整个忽略**，
      // 于是上一段的答案原样留着：界面上这次执行明明在跑，却还挂着上次的结论，
      // 用户会以为它已经答完了。
      answer: null,
      error: null,
      quotaResumeAt: null,
    });
    if (ok) kickAgentRun(runId);
  }
  return viewOf(runId, ctx.memberId);
}

export async function cancelAgentRun(ctx: ToolContext, runId: string): Promise<AgentTurn> {
  // 归属先校验：transition 只认 runId，不带工作区条件——别的工作区的人不能靠猜 id 终止你的运行
  const own = await prisma.agentRun.count({ where: { id: runId, workspaceId: ctx.workspaceId } });
  if (own === 0) throw new Error('运行记录不存在');
  // 等浏览器、等额度的那些也要能终止——不然一次派错的活会把运行挂在那里等满 48 小时
  // 租约一并清掉：后台那一轮跑完会看到 status 已经不是 running 就自己退出
  const stopped = await transition(runId, LIVE_STATUSES, 'cancelled', {
    pending: null,
    waitingOn: null,
    leaseUntil: null,
    quotaResumeAt: null,
  });

  // 【终止父运行必须连带终止它派出去的子运行】父运行挂在 `run:<childId>` 上等着，
  // 而子运行是**另一条独立的后台推理线**：不管它的话，用户点了终止之后它还在
  // 接着烧额度、接着写库（建草稿、发计划），而页面上父运行已经写着「已终止」。
  // 那正是「点了终止它还在做事」——轮内取消那道闸修的是同一个病，只是范围小一层。
  //
  // 只终止**还活着**的子运行（cancelAgentRun 里的 transition 自带乐观锁，
  // 已经跑完的不会被拉回来）。嵌套只许一层，所以不需要递归。
  if (stopped) {
    const children = await prisma.agentRun.findMany({
      where: { parentRunId: runId, status: { in: [...LIVE_STATUSES] } },
      select: { id: true },
    });
    for (const c of children) {
      await transition(c.id, LIVE_STATUSES, 'cancelled', {
        pending: null,
        waitingOn: null,
        leaseUntil: null,
        quotaResumeAt: null,
        error: '发起它的那次任务被终止了',
      });
    }
  }
  return viewOf(runId, ctx.memberId);
}

/**
 * 读一次运行的当前样子。界面轮询走的就是它，所以**顺手做两件自愈**：
 *
 * ① 等的那件事其实早有结果了，却没人来叫醒——进程在「回执落库」与「叫醒」之间挂掉就会这样。
 * ② 后台跑着跑着那个进程没了（租约过期而状态还是 running）——再踢一脚接手。
 *
 * 【为什么把自愈放在「用户看的时候」】这两种情况都罕见，专门开一条定时任务扫全表不划算；
 * 而它们**只在有人关心那次运行时才有影响**。整机版在批 5 之前连每日清理都不跑，
 * 靠定时兜底等于不兜。
 */
export async function getAgentRunView(ctx: ToolContext, runId: string): Promise<AgentTurn> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, workspaceId: ctx.workspaceId } });
  if (!run) throw new Error('运行记录不存在');

  if (run.status === 'waiting_browser' && run.waitingOn) {
    const { settleIfResolved } = await import('./wake');
    // 带上「从什么时候开始等的」：等工作流/等子运行那两种没有自己的 expiresAt，
    // 到期判定要靠这个（updatedAt 就是挂起那一刻，之后没人再动过这一行）
    await settleIfResolved(run.waitingOn, run.updatedAt);
  } else if (run.status === 'waiting_quota') {
    // ③ 额度早就重置了，只是定时还没轮到它（整机版/开发态压根不跑定时）。
    //    翻回 running 必须走乐观锁：不然定时和这里会同时踢，两条推理线写同一行。
    await resumeIfQuotaReset(runId, run.quotaResumeAt);
  } else if (run.status === 'running' && (!run.leaseUntil || run.leaseUntil < new Date())) {
    kickAgentRun(runId);
  }
  return viewOf(runId, ctx.memberId);
}

/**
 * 额度重置时刻到了就把这次运行翻回 running 并接着跑。
 *
 * 【为什么不能直接 kick】kick 链路上三道闸全都只认 running：claimLease 抢不到、
 * loop 开头就 return、contextForRun 直接拒载。对一个 waiting_quota 的运行踢一脚
 * 是**静默无效**的——恰好复刻这一批要修的那个「悬死」。必须先翻状态。
 */
export async function resumeIfQuotaReset(runId: string, quotaResumeAt: Date | null): Promise<boolean> {
  if (quotaResumeAt && quotaResumeAt > new Date()) return false; // 还没到点
  const ok = await transition(runId, 'waiting_quota', 'running', { quotaResumeAt: null, error: null });
  if (ok) kickAgentRun(runId);
  return ok;
}

/**
 * 对话超长时怎么办。
 *
 * 【原来是直接从中间成对删】那意味着模型会**忘掉自己做过什么**：
 * 一次长任务跑到后半程，前面查过的数据、建过的草稿全没了，
 * 它可能把同一件事再做一遍（而且是真的再做一遍，花第二次钱）。
 *
 * 现在改成**先折叠再删**：把要丢掉的那段压成一句「我在这中间做过 X、Y、Z」。
 * 折叠用本地规则拼，不调模型——为了省上下文再花一次模型调用不划算，
 * 而且那次调用本身也要占额度（这条路径恰恰是在额度吃紧的长任务里走的）。
 */
function capMessages(messages: ChatMessage[]): string {
  let json = toJson(messages);
  if (json.length <= MAX_MESSAGES_CHARS) return json;

  // 第零步（2026-09-02，学自 Hermes 压缩的第一阶段）：先只剪**旧的大工具结果**。
  // 撑爆上下文的几乎总是它们（一次采集回来几十条作品、一篇正文全文），而不是对话本身。
  // 剪掉结果、留下「调过什么工具、传了什么参数、结果一句话是什么」，模型仍然知道自己
  // 做过什么，也不用像整段折叠那样把中间的一切都丢掉再重查一遍（重查=再花一次配额）。
  // 多数情况下这一步做完就够了，根本走不到折叠。
  if (pruneOldToolResults(messages)) {
    json = toJson(messages);
    if (json.length <= MAX_MESSAGES_CHARS) return json;
  }

  // 第一步：把中段折叠成一条摘要。系统提示（第一条）与最近几轮原样留着。
  if (messages.length > KEEP_RECENT + 2) {
    const cut = safeCut(messages, messages.length - KEEP_RECENT);
    if (cut > 1) {
      const middle = messages.slice(1, cut);
      const summary = foldSummary(middle);
      const next = messages[cut];
      messages.splice(1, middle.length);
      // 【折叠摘要不能造出两条连着的 user】折叠段之后紧跟的若是一条真实的用户消息
      //（追问过的运行就是这样），再塞一条 user 进去就是 user→user——不少端点直接 400，
      // 而且这份对话是落库的，之后每一轮都会再送一遍，等于这次运行永久失败。
      // 紧跟的是 user 就把摘要并进它的开头；是 assistant 才单独插一条 user。
      if (next && next.role === 'user') {
        next.content = typeof next.content === 'string'
          ? `${summary}\n\n${next.content}`
          : [{ type: 'text', text: summary }, ...next.content];
      } else {
        messages.splice(1, 0, { role: 'user', content: summary });
      }
      json = toJson(messages);
    }
  }

  // 第二步：折叠完还是太长（最近几轮里有超大工具结果），才动手删——
  // 这时候丢的是「最近的一批」里较早的那些，仍然保系统提示与最后几条
  while (json.length > MAX_MESSAGES_CHARS && messages.length > 6) {
    const cut = safeCut(messages, 3); // 至少丢两条，且不许切断配对
    if (cut <= 1) break; // 再丢就要拆配对了，宁可超长也不能留下孤儿
    messages.splice(1, cut - 1);
    json = toJson(messages);
  }
  return json;
}

/**
 * 找一个**不会拆散「工具调用与它的回复」**的切点。
 *
 * 【为什么必须对齐】一条 `assistant(toolCalls)` 与随后那几条 `tool` 回复是一个整体，
 * 线格式上是 1:1 对应的（lib/llm/openai-compatible.ts 原样映射，没有任何清洗）。
 * 按条数硬切会留下**孤儿 tool 消息**——多数端点直接 400。
 *
 * 而这里最糟的地方是：折叠结果是**落库**的，于是之后每一轮、每一次追问
 * 都把同一份非法对话再送一遍，那次运行从此永久失败。
 *
 * 传入「想切到哪儿」，返回「实际切到哪儿」：只会往前退，不会往后越界。
 */
function safeCut(messages: readonly ChatMessage[], want: number): number {
  let i = Math.min(Math.max(want, 1), messages.length);
  // 切点落在一条 tool 回复上：它的 assistant 在前面，而保留区是 [i, end)——
  // 从这儿切会把回复留下、把声明它的那条折叠掉，正好造出孤儿。一路退到不是 tool 为止。
  //
  // 【只退不进】退过头最多是多折叠几条（信息进了摘要里），而切错一格是永久 400。
  while (i > 1 && messages[i]?.role === 'tool') i--;
  return i;
}

/** 折叠时保留最近几条原文。太少会让模型接不上最后一步，太多则折叠不出空间。 */
const KEEP_RECENT = 6;

/** 工具结果超过这个长度才剪。小结果留着比剪掉划算：占位符自己也有百来字。 */
const PRUNE_TOOL_RESULT_OVER = 400;

/**
 * 把「最近几条」之前的大工具结果各剪成一行。返回有没有真的剪到东西。
 *
 * 剪出来的占位符刻意保留两样：原结果的 ok 标志（写成同样的 `"ok":false` 形状，
 * 折叠摘要数失败次数用的正是这个正则）和 summary 的前 120 字（那是工具自己写的一句人话，
 * 模型看它就知道那一步的结果是什么，不必回头猜）。
 * 已经剪过的不再剪（占位符带 pruned 标记）。
 */
function pruneOldToolResults(messages: ChatMessage[]): boolean {
  let changed = false;
  const keepFrom = Math.max(1, messages.length - KEEP_RECENT);
  for (let i = 1; i < keepFrom; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || m.content.length <= PRUNE_TOOL_RESULT_OVER) continue;
    if (/"pruned"\s*:\s*true/.test(m.content)) continue;
    const failed = /"ok"\s*:\s*false/.test(m.content);
    let brief = '';
    try {
      const parsed = JSON.parse(m.content) as { summary?: unknown; error?: unknown };
      const line = typeof parsed.summary === 'string' ? parsed.summary : typeof parsed.error === 'string' ? parsed.error : '';
      brief = line.replace(/\s+/g, ' ').slice(0, 120);
    } catch { /* 不是 JSON 就不带摘要 */ }
    m.content = toJson({
      ok: !failed,
      pruned: true,
      brief,
      note: `这条工具结果原文 ${m.content.length} 字，为了不超出上下文已经剪掉。这一步已经做过了，不要重做；需要它的具体数据就重新查一次。`,
    });
    changed = true;
  }
  return changed;
}

/**
 * 把一段对话压成一句人话摘要。**本地拼，不调模型。**
 *
 * 只保留「做过什么」这一件事：调过哪些工具、成没成。
 * 工具返回的原始数据本来就是要丢的那部分——留着它就没有折叠的意义了。
 */
function foldSummary(middle: readonly ChatMessage[]): string {
  const tools: string[] = [];
  let failed = 0;
  for (const m of middle) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const c of m.toolCalls) tools.push(toolByName(c.name)?.label ?? c.name);
    }
    if (m.role === 'tool' && /"ok"\s*:\s*false/.test(m.content ?? '')) failed++;
  }
  const uniq = [...new Set(tools)];
  const did = uniq.length ? `做过这些：${uniq.join('、')}` : '没有调用过工具';
  const bad = failed > 0 ? `（其中 ${failed} 次没成）` : '';
  return `【前面的过程已折叠】为了不超出上下文，你与系统之间较早的那段对话被压成了这一句：${did}${bad}。`
    + '这些步骤**已经做过了，不要重做**；需要那时候的具体数据就重新查一次。';
}

/**
 * 这个工作区关掉了哪些「插件」（AI 能调的能力）。
 *
 * 刻意**不放进 ToolContext**：放进去就意味着每个构造 ctx 的地方都要记得填一次，
 * 而漏填的后果是静默的——工具照常可用，用户以为自己关掉了。让 run.ts 自己去查，
 * 新增调用点不可能漏。
 */
async function offTools(workspaceId: string): Promise<string[]> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { agentToolConfig: true } });
  return disabledTools(ws?.agentToolConfig);
}

type CallOutcome = {
  message: string;
  ok: boolean;
  /** 这一步要求把整次运行停下来等外面的事，格式 `<类型>:<id>`（见 AgentRun.waitingOn） */
  waitFor?: string;
};

/** 真正执行一次工具调用。权限与开关在这里**再查一次**——列表给了什么不算数，执行时的判定才算。 */
async function executeCall(ctx: ToolContext, call: ToolCall): Promise<CallOutcome> {
  const tool = toolByName(call.name);
  if (!tool) {
    return { message: toJson({ ok: false, error: `没有名为 ${call.name} 的工具` }), ok: false };
  }
  if (!can(ctx.role, tool.action)) {
    return { message: toJson({ ok: false, error: '发起人的角色没有这个权限，操作未执行' }), ok: false };
  }
  // 被工作区关掉的工具不给执行。只从清单里拿掉是不够的——模型会凭上一轮上下文里
  // 见过的工具名继续调，那样「关掉」就成了摆设。
  if ((await offTools(ctx.workspaceId)).includes(tool.name)) {
    return { message: toJson({ ok: false, error: `「${tool.label}」已被工作区关闭，操作未执行` }), ok: false };
  }
  // 自主智能体的白名单同理要在**执行时**再查一次，理由与上面那条一模一样。
  if (ctx.runId) {
    const row = await prisma.agentRun.findUnique({ where: { id: ctx.runId }, select: { toolAllowlist: true } });
    const allow = parseJson<string[]>(row?.toolAllowlist ?? '[]', []);
    if (allow.length > 0 && !allow.includes(tool.name)) {
      return {
        message: toJson({ ok: false, error: `这次任务只许用指定的几个动作，「${tool.label}」不在其中，未执行` }),
        ok: false,
      };
    }
  }
  const args = parseJson<Record<string, unknown>>(call.arguments, {});
  const ac = new AbortController();
  const ctxWithSignal = { ...ctx, signal: ac.signal };
  try {
    const result = await withTimeout(tool.run(ctxWithSignal, args), toolTimeoutMs(tool), tool.label, ac);
    // 产物登记挂在**这一个咽喉**上：所有工具执行都过 executeCall，
    // 挂在这里就不会出现「新加的工具忘了登记产物」——它只要在 ToolResult 里报，就一定被记下
    if (result.artifacts?.length && ctx.runId) await recordArtifacts(ctx.runId, result.artifacts);
    return { message: resultForModel(result), ok: result.ok, waitFor: result.waitFor };
  } catch (err) {
    // 工具自己炸了不能把整次运行带走：如实回灌错误，让模型换个做法或告诉用户。
    log.warn('工具执行失败', { tool: call.name, error: (err as Error).message });
    return { message: toJson({ ok: false, error: (err as Error).message.slice(0, 300) }), ok: false };
  }
}

/**
 * 给一次工具执行封个时间上限。
 *
 * 【说清楚它做不到什么】JS 没法真的掐断一个已经跑起来的 Promise：超时只是
 * **不再等它**，那边该写库还会写库。所以回灌给模型的话必须写明「它可能还在后台跑」，
 * 否则模型会当成「没做成」而重来一次——一次超时变成两次真的执行。
 *
 * 那为什么还要有它：没有上限的话，一个卡住的外部请求会把这次运行永远钉在 running 上，
 * 租约一直续、谁也接手不了，用户看到的是一个永不结束的转圈。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, ac?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          ac?.abort();
          reject(new Error(`「${label}」超过 ${Math.round(ms / 1000)} 秒还没返回，先不等了。它可能仍在后台继续，别重复执行同一步。`));
        },
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * 后台执行的入口：把一次运行往前推到「停下来」为止（做完 / 等确认 / 等浏览器 / 失败）。
 *
 * 只认一个运行 id——因为叫它的地方（队列 worker、脱离请求的后台任务、插件回执）
 * 手上都**没有会话**。权限上下文在这里按当前库里的样子重建：
 * 发起人这会儿可能已经被降权或移出团队了，那这次运行就该按新权限跑（或跑不动）。
 */
export async function runAgentLoop(runId: string): Promise<void> {
  const ctx = await contextForRun(runId);
  if (!ctx) return; // 上下文没了（人被移出团队等），contextForRun 已经如实写进库
  if (!(await claimLease(runId))) return; // 别人正在跑它
  try {
    await loop(ctx, runId);
  } catch (err) {
    // 【这个 catch 是「必须有终态」那条规矩的兜底】
    // 原来这里只有 finally：loop 里任何一处抛错——模型调用撞配额、写库瞬断、
    // 记流水时表被清理掉——异常都会穿过这里，被 kick 的兜底 catch 记成一行日志，
    // 而那次运行**永远停在 running**：没有终态、没有错误、界面转圈到天荒地老，
    // 每次用户打开页面还会触发一次自愈，再撞一次同样的墙。
    //
    // 刻意放在最外层而不是包住 llmComplete 那一句：抛错的地方不止模型调用一处，
    // 而「运行必须有个看得见的结局」对所有出错方式都成立。
    await failFromError(runId, err).catch(() => {});
  } finally {
    // 租约必须还回去，否则这次运行要等 10 分钟才有人敢接手
    await prisma.agentRun.updateMany({ where: { id: runId }, data: { leaseUntil: null } }).catch(() => {});
  }
}

/**
 * 从库里把执行上下文重建出来。
 *
 * AgentRun 只存了 workspaceId / accountId / memberId——tenantId 与角色都要现查。
 * **现查是刻意的**：角色按恢复时点算，一次昨天发起、今天才被叫醒的运行，
 * 用的是这个人今天的权限。存一份快照会让「已经降权的人」靠一次挂起的运行继续用旧权限。
 */
async function contextForRun(runId: string): Promise<ToolContext | null> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, workspaceId: true, accountId: true, memberId: true },
  });
  if (!run) return null;
  if (!LIVE_STATUSES.includes(run.status as AgentRunStatus)) return null;

  const [ws, member] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: run.workspaceId }, select: { tenantId: true } }),
    prisma.member.findUnique({ where: { id: run.memberId }, select: { role: true } }),
  ]);

  // 工作区没了 / 发起人不在了：这次运行永远不可能再跑，如实判死而不是留一个僵尸
  if (!ws || !member || !run.accountId) {
    await transition(runId, LIVE_STATUSES, 'failed', {
      pending: null,
      waitingOn: null,
      leaseUntil: null,
      quotaResumeAt: null,
      error: !member ? '发起这次执行的成员已不在团队里，执行按他的权限跑不下去了' : '这次执行所属的工作区或账号已不存在',
    });
    return null;
  }
  return {
    tenantId: ws.tenantId,
    workspaceId: run.workspaceId,
    accountId: run.accountId,
    memberId: run.memberId,
    role: member.role,
    // 带上自己的 id：工具报出来的产物要挂到这次执行头上
    runId: run.id,
  };
}

/**
 * 抢执行租约。抢到才往下跑。
 *
 * 【为什么必须有】踢一脚的地方有三处（开跑、确认完、等的事有结果了），每一处都可能
 * 重复触发：用户把「确认」点两下、插件把同一条回执重投一次、队列重试。没有租约的话
 * 两条推理线会交替往同一行 messages 里写，最后是一份自相矛盾的对话 + 重复执行的工具。
 *
 * 用带条件的 updateMany 而不是「先读再写」：后者中间有窗口，两个进程会同时读到「没人占」。
 */
async function claimLease(runId: string): Promise<boolean> {
  const now = new Date();
  const r = await prisma.agentRun.updateMany({
    where: { id: runId, status: 'running', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return r.count === 1;
}

/**
 * 主循环。每次进来都从库里读最新状态，所以「确认后继续」与「首次运行」走的是同一段代码。
 *
 * 返回 void：它现在只在后台跑，没有人等它的返回值。
 * 每一轮先看一眼记录还在不在——后台这条线**可能比它的记录活得更久**
 *（到期清理删了它、工作区被删级联带走了它、用户在别处终止了它），
 * 那时候就该安静退出，而不是抛一个没人接的错。
 */
async function loop(ctx: ToolContext, runId: string): Promise<void> {
  for (;;) {
    const run = (await prisma.agentRun.findUnique({ where: { id: runId } })) as RunRow | null;
    if (!run) return; // 记录没了：不是错误，是这次运行已经与谁都无关了
    if (run.status !== 'running') return;
    // 续租：一轮模型 + 一批工具可能几十秒，不续的话长执行跑到一半就被别人接手了
    await patchRun(runId, 'running', { leaseUntil: new Date(Date.now() + LEASE_MS) });
    // 两道预算：轮数（防模型在两个工具之间来回打转）与**模型调用次数**（防一步烧光）。
    // 后者才是真正管钱的那道——一次 run_advisor 就是十几次调用，按轮数根本拦不住。
    const used = await callsUsed(runId);
    const overBudget = used >= run.callBudget;
    const overRounds = run.rounds >= MAX_ROUNDS;

    const messages = parseJson<ChatMessage[]>(run.messages, []);
    // 消费点①：用户在上一轮之后又说了什么，这一轮就带上
    const notes = await drainNotes(runId);
    if (notes.length > 0) {
      messages.push(...notes);
      // 【排干就要立刻落库】drainNotes 已经把这几句标成「已送达」了，而下面那次模型调用
      // **随时可能抛错**（配额超限是家常便饭）。那时 messages 还只在内存里，运行被推去
      // waiting_quota，续跑时从库里重读——用户那句话就此蒸发：不报错、界面上
      //「还有 N 句没送达」也归零了，他以为已经被听到了。
      await patchRun(runId, 'running', { messages: capMessages(messages) });
    }
    // 【白名单必须在这里也生效】早先这里是 toolsFor(...) 重算一遍、不带白名单——
    // 于是自主智能体的「只许用这几个工具」只影响了系统提示词里印出来的名字，
    // 而**真正送给模型的 tool schema 仍然是全量的**，它照样调得动。
    // 白名单从库里读（后台恢复时手上没有当初那个参数）。
    const tools = (await toolsForRun(ctx, parseJson<string[]>(run.toolAllowlist, []))).map((t) => t.def);

    // 【到顶了不直接判死，先让它把话说完】原来是当场 failed，用户拿到的是一句
    // 「跑到上限了」外加一片空白——而它可能已经查了五样东西、写好了一半。
    // 多花一次调用换一段「我做到哪儿了、还差什么」，这次执行才对用户有价值。
    // 收尾这一轮**不给工具**：给了它又会接着干活，那就不叫收尾了。
    const wrapUp = overBudget || overRounds;
    if (wrapUp) {
      messages.push({
        role: 'user',
        content:
          '【系统】这次任务的额度用完了，不能再调用任何工具。'
          + '请用中文简短总结：你已经做完了什么（有具体产出就说清楚在哪），还差什么没做完。不要再说你要去做什么。',
      });
    }

    // 抛错不在这里接：统一由 runAgentLoop 的外层 catch 收口成一个可见的结局
    // （配额超限是其中最常见的一种，见 failFromError）。
    const result = await llmComplete(ctx.tenantId, 'chat', messages, {
      // 【fn 仍然是 chat，只是多问一句】执行模式对模型的要求与聊天不同：它必须稳定地发
      // **结构化工具调用**，发不出来就会出现「说做了其实没做」。所以允许单独指一条渠道。
      // 但 fn 不能改成 'agent'——它同时是记账口径与 BYOK 的既有路由键，
      // 改了会让只配 chat 路由的存量租户静默换渠道甚至落 Mock（执行器里 Mock 是硬停）。
      // preferFn 只增不减：配了就用，没配完全照旧。
      preferFn: 'agent',
      temperature: 0.3,
      // 收尾轮不带工具，模型只能说话
      ...(wrapUp ? {} : { tools }),
      runId,
    });

    // 模型确实说了一轮话，先把轮数记上。放在这里而不是各个分支里：
    // 分支有五个（回答/等确认/等插件/失败/继续），漏一个就是一条永远跑不到上限的运行。
    //
    // **收尾那一轮不计**：rounds 是「用户的预算用掉了多少」，而收尾是系统强制加的一轮，
    // 不该算在他头上。计进去的话 rounds 会停在 MAX_ROUNDS+1，
    // 「用满了预算」这件事反而说不清楚。
    if (!wrapUp) await patchRun(runId, 'running', { rounds: run.rounds + 1 });

    // Mock 兜底会编出「我已经帮你做好了」——在执行器里这是谎报，必须硬停。
    if (result.mocked) {
      await transition(runId, 'running', 'failed', {
        error: result.degraded
          ? 'AI 模型这次调用失败了，执行已中止（不会拿示例内容冒充执行结果）。稍后重试，或到「接入与密钥」检查渠道。'
          : '还没有接入真实的 AI 模型，执行模式不可用（示例模型只会编造执行结果）。请先到「接入与密钥」配置 API Key。',
      });
      return;
    }

    // 收尾轮：把它这段总结记下来，如实判 failed（**没做完就是没做完**），
    // 但 answer 里带着阶段性成果，用户知道自己拿到了什么、还差什么。
    if (wrapUp) {
      const summary = result.text.trim();
      const why = overBudget
        ? `这次任务的调用额度用完了（上限 ${run.callBudget} 次模型调用）`
        : `已经跑到轮数上限（${MAX_ROUNDS} 轮）`;
      await appendStep(runId, run.steps + 1, { kind: 'answer', result: summary.slice(0, 4000), ok: false });
      await transition(runId, 'running', 'failed', {
        answer: summary,
        steps: run.steps + 1,
        error: `${why}，没能全部做完。上面是它做到的部分——可以把剩下的拆成一件小事再派一次。`,
        messages: capMessages([...messages, { role: 'assistant', content: summary }]),
      });
      return;
    }

    const calls = (result.toolCalls ?? []).slice(0, MAX_CALLS_PER_TURN);
    let seq = run.steps;

    if (calls.length === 0) {
      // 消费点③：**它以为自己做完了，但用户刚又说了一句**。
      // 不在这里检查的话，最后一轮之后到达的那句话永远没人读——
      // 而「就快跑完时想起还有件事」恰恰是最常见的追问时机。
      const lateNotes = await drainNotes(runId);
      if (lateNotes.length > 0) {
        messages.push({ role: 'assistant', content: result.text ?? '' }, ...lateNotes);
        await patchRun(runId, 'running', { messages: capMessages(messages), rounds: run.rounds + 1 });
        continue; // 别急着收工，带着新要求再想一轮
      }

      const answer = result.text.trim();

      // 【它想调工具，但把调用写成了正文】真机第一次跑就撞上：MiniMax 前一轮还在发正规
      // 工具调用，下一轮忽然吐出
      //     「接下来，我会根据这个选题生成一篇初稿并保存。请稍等。」
      //     ```typescript
      //     functions.create_draft({"platform": "wechat", "title": "…"})
      //     ```
      // 而这一轮的 toolCalls 是空的。执行器于是把这段**承诺**当成最终答案、判 done——
      // 用户要一篇稿子，拿到一句「请稍等」，任务却写着「已完成」，库里一个字都没多。
      //
      // 这正是本轮一直在治的那一类：**报告与事实不符**。所以宁可多花一次调用把它叫回来，
      // 也不能把一句承诺当成交付。nudge 有上限，模型如果就是不会用工具，
      // 到顶之后照常收工（那时至少 answer 是它自己写的东西，不是我们编的）。
      const nudged = messages.filter((m) => m.role === 'user' && typeof m.content === 'string'
        && m.content.startsWith(TOOL_SYNTAX_NUDGE)).length;
      if (nudged < MAX_TOOL_SYNTAX_NUDGES && looksLikeUnsentToolCall(answer, tools)) {
        await appendStep(runId, ++seq, {
          kind: 'tool_result', tool: '', args: toJson({}), ok: false,
          result: '模型把工具调用写成了正文（没有按工具调用的格式发出来），已让它重发。',
        });
        messages.push(
          { role: 'assistant', content: answer },
          { role: 'user', content: `${TOOL_SYNTAX_NUDGE}你刚才是想调用工具，但把调用写在了正文里，系统收不到，那一步**没有执行**。`
            + '请用工具调用的方式重新发一次；如果你其实不需要调工具，就直接把结论说完，不要再写 functions.xxx(...) 这种文本。' },
        );
        await patchRun(runId, 'running', { messages: capMessages(messages), steps: seq, rounds: run.rounds + 1 });
        continue;
      }

      // 【它一个工具都没调，却宣称做完了 / 编了示例数据 / 让用户选路】2026-09-03 真机：
      // 「去抓取 x 的数据」两轮零工具调用——第一轮「请稍等，我正在为您采集…您希望如何操作？」，
      // 第二轮「数据采集已完成。以下是示例数据（不代表真实情况）：播放量 10,000…」，运行判了 done。
      // 上面那道闸只认「写成正文的工具调用」，这种连调用形状都没有的纯编造它看不见。
      // 判据与处置见 looksLikeFabricatedCompletion；叫不回来就判 failed——没做就是没做，
      // 一句「示例数据」标注挡不住用户把 10,000 当成真播放量。
      const fab = looksLikeFabricatedCompletion(answer, tools);
      if (fab) {
        const factNudged = messages.filter((m) => m.role === 'user' && typeof m.content === 'string'
          && m.content.startsWith(FACT_NUDGE)).length;
        if (factNudged < MAX_FACT_NUDGES) {
          await appendStep(runId, ++seq, {
            kind: 'tool_result', tool: '', args: toJson({}), ok: false,
            result: FAB_STEP_NOTE[fab],
          });
          messages.push(
            { role: 'assistant', content: answer },
            { role: 'user', content: FACT_NUDGE + fabNudgeText(fab, tools) },
          );
          await patchRun(runId, 'running', { messages: capMessages(messages), steps: seq, rounds: run.rounds + 1 });
          continue;
        }
        await appendStep(runId, ++seq, { kind: 'answer', result: answer.slice(0, 4000), ok: false });
        await transition(runId, 'running', 'failed', {
          answer,
          steps: seq,
          error: FAB_FAIL_ERROR[fab],
          messages: capMessages([...messages, { role: 'assistant', content: answer }]),
        });
        return;
      }

      await appendStep(runId, ++seq, { kind: 'answer', result: answer.slice(0, 4000) });
      await transition(runId, 'running', 'done', {
        answer,
        steps: seq,
        messages: capMessages([...messages, { role: 'assistant', content: answer }]),
      });
      return;
    }

    // 模型这一轮要调工具：先把它的「意图」原样记进对话（含 tool_calls），
    // 否则下一轮回灌 tool 结果时 id 对不上，多数端点直接 400。
    messages.push({ role: 'assistant', content: result.text ?? '', toolCalls: calls });

    let paused = false;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const tool = toolByName(call.name);
      await appendStep(runId, ++seq, { kind: 'tool_call', tool: call.name, args: parseJson(call.arguments, {}) });

      // 单个工具在这次任务里的次数上限（run_advisor 一次就是十几次模型调用，
      // 连开三场会诊就把预算清空了，而用户要的只是一篇稿子）。
      // 如实回灌给模型而不是抛错：它会换个做法或告诉用户，而抛错会让它以为是
      // 临时故障再重试一遍——那是白白多烧一次。
      //
      // 【必须在确认闸**之前**（2026-08-30 修）】原来它在下面、紧挨着 executeCall。
      // 而 PER_RUN_TOOL_CAP 里那几个工具（run_advisor / generate_topics / run_agent /
      // generate_image）**全都是 write**，于是在默认授权档（每一步都要确认）下：
      // 确认分支在这里就 break 了，永远走不到那道闸；而用户点了确认之后走的是
      // decidePendingCall，那条路直接 executeCall，同样没有这道闸。
      // 结果是这几个上限**一次都没生效过**——写了、也有用例，就是够不着。
      //
      // 挪到确认之前还顺带免掉一个不该出现的场面：超了上限就**根本不去问用户**，
      // 而不是先弹一张确认卡、等他点了同意再告诉他「这一步不能执行」。
      const capped = await toolCapReason(runId, call.name);
      if (capped) {
        await appendStep(runId, ++seq, { kind: 'tool_result', tool: call.name, args: parseJson(call.arguments, {}), result: capped, ok: false });
        messages.push({ role: 'tool', toolCallId: call.id, content: toJson({ ok: false, error: capped }) });
        continue;
      }

      if (tool && (await mustConfirm(ctx, runId, tool, call)) && can(ctx.role, tool.action)) {
        // 停在这一步等人。**同一批里排在它后面的调用也一起等**——
        // 先斩后奏地把后面的读操作跑完，会让确认弹层出现在一堆已经发生的事之后。
        const remaining = calls.slice(i);
        // 消费点②：停下来等人之前先把话排干。不排的话，用户在「正要弹确认卡」
        // 这一刻打的字会一直悬着——他看着确认卡，以为自己补充的要求已经被听到了
        messages.push(...(await drainNotes(runId)));
        if (!(await transition(runId, 'running', 'awaiting_confirm', {
          pending: toJson(remaining[0]),
          messages: capMessages(messages),
          steps: seq,
        }))) {
          return; // 这期间被终止了：不要把它从 cancelled 拉回「等你确认」
        }
        // 后面的调用这一轮不执行：模型会在确认后的下一轮重新决定要不要再调。
        // 代价是可能多一轮对话，换来的是「用户看到的每一步都还没发生」。
        if (remaining.length > 1) {
          for (const skipped of remaining.slice(1)) {
            messages.push({
              role: 'tool',
              toolCallId: skipped.id,
              content: toJson({ ok: false, error: '这一步先没执行：同一轮里前面有一步在等用户确认' }),
            });
          }
          await patchRun(runId, 'awaiting_confirm', { messages: capMessages(messages) });
        }
        paused = true;
        break;
      }

      // 【取消要在轮内也生效】轮首那道检查只挡得住「上一轮结束前就点了终止」。
      // 一轮里可能连着调五个工具、每个几十秒到几分钟——用户在中间点终止，
      // 剩下的工具照跑照写库（建草稿、烧额度），他看到的是「点了终止它还在做事」。
      if (!(await stillRunning(runId))) return;
      // 【租约也要在这里续】续租原本只在轮首做一次，而单个工具的超时上限是
      // 8 分钟（出图、会诊）甚至 20 分钟（派智能体）——一轮五个工具可以远超 10 分钟的租约。
      // 租约一过期，定时巡检与「用户打开页面」两处都会再踢一脚，
      // 于是**两条推理线同时推同一次运行**：各读一份 messages、重复执行同一批工具
      //（真的重复建草稿、真的重复烧额度）、用同一段 seq 写流水、最后互相覆盖。
      await patchRun(runId, 'running', { leaseUntil: new Date(Date.now() + LEASE_MS) });

      const executed = await executeCall(ctx, call);
      await appendStep(runId, ++seq, {
        kind: 'tool_result', tool: call.name, args: parseJson(call.arguments, {}), result: executed.message, ok: executed.ok,
      });

      // 这一步要求停下来等外面的事（派了活给插件并要等结果）。
      // 与「等确认」同样的处理：同一轮里排在它后面的调用一律不执行——
      // 那些调用多半就是想用这一步的结果，现在跑它们只会拿到还没有的数据。
      if (executed.waitFor) {
        for (const skipped of calls.slice(i + 1)) {
          messages.push({
            role: 'tool',
            toolCallId: skipped.id,
            content: toJson({ ok: false, error: '这一步先没执行：同一轮里前面有一步在等浏览器插件的结果' }),
          });
        }
        await park(runId, 'running', call, executed, messages, seq);
        return;
      }

      messages.push({ role: 'tool', toolCallId: call.id, content: executed.message });
    }

    if (paused) return;
    await patchRun(runId, 'running', { messages: capMessages(messages), steps: seq });
  }
}

/** 这次执行烧了多少：真实调用次数与 token 总量（Mock 不算，它不花钱）。 */
async function runCost(runId: string): Promise<{ calls: number; tokens: number }> {
  const agg = await prisma.llmCallLog.aggregate({
    where: { runId, mocked: false },
    _count: { _all: true },
    _sum: { promptTokens: true, completionTokens: true },
  });
  return {
    calls: agg._count._all,
    tokens: (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0),
  };
}

/**
 * 这次执行能用哪些工具。**建行与主循环共用这一个入口**——各算各的迟早会不一致，
 * 而不一致的方向恰恰是「提示词里没有、模型却调得动」。
 *
 * 三道收窄叠加，顺序即优先级：
 *   ① 角色的 RBAC 权限     ② 工作区关掉的     ③ 这次执行的白名单（自主智能体配的）
 * 白名单**只能收不能放**：它先与①②求交集，配了个用户没权限的工具也拿不到。
 */
async function toolsForRun(ctx: ToolContext, allowlist?: readonly string[]): Promise<AgentTool[]> {
  const tools = toolsFor(ctx.role, await offTools(ctx.workspaceId));
  if (!allowlist || allowlist.length === 0) return tools;
  const allow = new Set(allowlist);
  return tools.filter((t) => allow.has(t.name));
}

/**
 * 这一段正文里，是不是藏着一个「本该是工具调用、却被写成文字」的东西。
 *
 * 判据要**同时**满足两条，少一条都会误伤：
 *   ① 出现了工具调用的字面形状（functions.x(…) / tool_call: x / <invoke name="x">）
 *   ② 括号前那个名字**确实是这次运行能用的工具**
 * 只看①的话，一篇讲「怎么写函数」的稿子会被反复打回；只看②的话，正文里提一句
 * 工具名（「我用 list_topics 查了一下」）也会被当成没发出去的调用。
 */
export function looksLikeUnsentToolCall(text: string, tools: readonly { name: string }[]): boolean {
  if (!text) return false;
  const names = new Set(tools.map((t) => t.name));
  if (names.size === 0) return false;
  const shapes = [
    /(?:^|[^\w.])functions?\.(\w+)\s*\(/g,          // functions.create_draft({...})
    /<invoke\s+name=["'](\w+)["']/g,                  // <invoke name="create_draft">
    /["']?tool(?:_name|Name)?["']?\s*[:=]\s*["'](\w+)["']/g, // {"tool": "create_draft", ...}
    // 2026-09-03 真机又抓到一个形状：```json {"function": "list_browser_tasks"}```——
    // 模型把「你可以用这个命令看进度」写成一个 JSON 块给用户看。"name" 只认带引号的键，
    // 免得正文里普通的 name = xxx 赋值被当成调用
    /["']?function(?:_name|Name)?["']?\s*[:=]\s*["'](\w+)["']/g, // {"function": "list_browser_tasks"}
    /["']name["']\s*:\s*["'](\w+)["']/g,                          // {"name": "list_browser_tasks", "arguments": …}
  ];
  for (const re of shapes) {
    for (const m of text.matchAll(re)) if (names.has(m[1])) return true;
  }
  return false;
}

/**
 * 叫它重发工具调用时那句话的开头。用来数「已经叫过几次」，别写成两处。
 *
 * 【不能用泛泛的「【系统】」】收尾轮那句话也是【系统】开头，拿它数的话
 * 两件事会互相串——而串了之后的表现是「明明只叫过一次却不再叫了」，很难查。
 */
const TOOL_SYNTAX_NUDGE = '【系统·工具调用格式】';
/**
 * 最多叫几次。
 * 给到 2 是因为这是**模型能力问题不是逻辑问题**：叫一次多半就回来了，
 * 叫三次还不会用工具的模型，再叫也只是烧钱。到顶就照常收工。
 */
const MAX_TOOL_SYNTAX_NUDGES = 2;

/**
 * 零工具调用的最终回答里，三种「报告与事实不符」的形状（2026-09-03 真机抓到，见调用处注释）：
 *   sample         编了「示例/模拟」数据冒充结果——最坏的一种，数字会被当真
 *   promise        把「请稍等 / 正在为您…」当成最终回答——最终回答之后没人会替它继续
 *   route_question 问用户「走插件还是客户端」——路由由系统定（vet 会如实说派不派得出去），不该甩给用户
 *
 * 只在这次运行**有工具可用**时判：没有工具的纯问答里说「示例」是正常的。
 * promise 只认短回答：一段真交付的末尾顺口一句「稍等」不该被打回。
 */
export function looksLikeFabricatedCompletion(
  text: string, tools: readonly { name: string }[],
): 'sample' | 'promise' | 'route_question' | null {
  if (!text || tools.length === 0) return null;
  if (/示例数据|模拟数据|不代表真实|仅为示例|虚构的数据|假设的数据|示例结果/.test(text)) return 'sample';
  if (/(插件|客户端|本机浏览器)[\s\S]{0,200}(您希望如何|你希望如何|请告诉我您|请告诉我你|请选择|如何操作|您的选择|你的选择)/.test(text)) return 'route_question';
  if (text.length < 600 && /请稍等|稍等片刻|正在为您|正在为你|我这就去|马上为您|马上为你/.test(text)) return 'promise';
  return null;
}

const FACT_NUDGE = '【系统·不许谎报】';
const MAX_FACT_NUDGES = 2;

const FAB_STEP_NOTE: Record<NonNullable<ReturnType<typeof looksLikeFabricatedCompletion>>, string> = {
  sample: '模型没有调用任何工具，却给出了「示例数据」冒充结果，已打回让它真的去做。',
  promise: '模型把「请稍等」当成了最终回答（之后什么都不会再发生），已打回让它真的去做。',
  route_question: '模型让用户选走插件还是客户端——路由由系统定，已打回让它直接派活。',
};

const FAB_FAIL_ERROR: typeof FAB_STEP_NOTE = {
  sample: '模型没有调用任何工具就宣称做完了，内容是它编的示例数据。已判失败，没有任何数据入库——上面那些数字不是真的。换一个更会用工具的模型（接入与密钥 → 执行模式渠道）再派。',
  promise: '模型只说了「请稍等」就收工了，什么都没做。已判失败。换一个更会用工具的模型（接入与密钥 → 执行模式渠道）再派。',
  route_question: '模型一直在问你选哪条采集路由，而没有真的去派。已判失败。直接再派一次；仍然这样就换一个更会用工具的模型。',
};

function fabNudgeText(kind: NonNullable<ReturnType<typeof looksLikeFabricatedCompletion>>, tools: readonly { name: string }[]): string {
  const dispatch = tools.some((t) => t.name === 'dispatch_browser_task') ? '（采集就调用 dispatch_browser_task）' : '';
  const tail = `要做就**现在**用工具调用去做${dispatch}；做不了就如实说做不了、为什么、用户该做什么。不要写「请稍等」，不要编任何数字。`;
  switch (kind) {
    case 'sample':
      return `你这一轮没有调用任何工具，却给出了「示例/模拟」数据。这是谎报——用户会把那些数字当真。${tail}`;
    case 'promise':
      return `你把「请稍等 / 正在为您…」当成了最终回答。最终回答之后什么都不会再发生，没人会替你继续。${tail}`;
    case 'route_question':
      return `走哪条采集路由由系统决定，不要问用户选。直接派活${dispatch}；派不出去时工具会如实返回原因（插件版本旧、需要登记桌面客户端等），你把那个原因转告用户即可。`;
  }
}

/** 这次运行还归我推吗。用户随时可能按终止，而一批工具要跑好几分钟。 */
async function stillRunning(runId: string): Promise<boolean> {
  const r = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } });
  return r?.status === 'running';
}

/**
 * 这一步要不要停下来问人。**授权状态每次都从库里现读**——
 * 不缓存在内存里，也绝不接受对话里的任何声明：模型可以说「用户已经授权了」，
 * 那句话对这里没有任何影响。
 */
async function mustConfirm(ctx: ToolContext, runId: string, tool: AgentTool, call: ToolCall): Promise<boolean> {
  const row = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { authMode: true, preauthorizedTools: true },
  });
  const auth: RunAuth = {
    authMode: row?.authMode ?? 'confirm_each',
    preauthorizedTools: parseJson<string[]>(row?.preauthorizedTools ?? '[]', []),
  };
  if (needsConfirm(tool, auth)) return true;

  // 【run_agent 是排除表的后门，必须单独堵】
  // 智能体模板的步骤里有 publish（建发布计划）与 notify（往群里推消息）两种，
  // 而模板执行**不经过这里的逐步确认闸**——它是一次工具调用里从头跑到尾的。
  // 于是「无人值守下不许签合约」这条规矩，只要模型改派一个含 publish 步的模板就绕过去了。
  // 派发之前先看一眼那个模板里有没有这两种步骤，有就照样停下来问人。
  if (tool.name === 'run_agent' && auth.authMode !== 'confirm_each') {
    const args = parseJson<Record<string, unknown>>(call.arguments, {});
    if (await templateSignsContract(ctx, args)) return true;
  }
  return false;
}

/** 这个模板里有没有「签合约」性质的步骤（建发布计划 / 往群里推消息）。 */
async function templateSignsContract(ctx: ToolContext, args: Record<string, unknown>): Promise<boolean> {
  const id = typeof args.agent_id === 'string' ? args.agent_id : '';
  if (!id) return true; // 说不清是哪个模板就按最保守的来
  try {
    const tpl = await prisma.workflowTemplate.findFirst({
      // 归属校验：跨租户的模板本来就派不动，这里顺手也不给它放行
      where: { id, OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] },
      select: { steps: true },
    });
    if (!tpl) return true;
    const steps = parseJson<{ kind?: string }[]>(tpl.steps, []);
    return steps.some((s) => s.kind === 'publish' || s.kind === 'notify');
  } catch {
    return true; // 查不动就当它有——失败方向必须是「多问一次」
  }
}

/**
 * 模型调用抛错了：给这次运行一个**可见的结局**。
 *
 * 配额是唯一「等一等真的会好」的一类，而且只有日额度是：
 *   · 日额度   → waiting_quota，记下北京时间次日 0 点，定时到点把它翻回 running（lib/agent/tick.ts）
 *   · 月额度   → 等一个月的僵尸比如实失败更糟，判死
 *   · 平台预算 → 全平台共享的池子，等下去还会跟别人抢；用户手上有 BYOK 这条当场能走的路，判死
 * 其余异常（provider 挂了、库写不进去）一律判死并如实带上错误——
 * 唯一不能接受的是「什么都不写，留一个永远转圈的运行」。
 */
async function failFromError(runId: string, err: unknown): Promise<void> {
  const e = err as { code?: string; scope?: QuotaScope; message?: string };
  const message = (e?.message ?? '执行时发生了未知错误').slice(0, 500);

  if (e?.code === 'QUOTA_EXCEEDED' && e.scope === 'daily') {
    const resumeAt = beijingEndOfDay();
    const ok = await transition(runId, 'running', 'waiting_quota', {
      quotaResumeAt: resumeAt,
      leaseUntil: null,
      error: message,
    });
    if (ok) log.info('额度用尽，执行挂起等重置', { runId, resumeAt });
    return;
  }

  await transition(runId, 'running', 'failed', { leaseUntil: null, error: message });
  log.warn('执行失败', { runId, error: message });
}

/** 给界面用：当前角色能调用哪些工具（不含权限外的、也不含工作区关掉的）。 */
export function availableTools(role: string, disabled: readonly string[] = []) {
  return toolsFor(role, disabled).map((t) => ({
    name: t.name,
    label: t.label,
    write: t.write,
    costly: t.costly === true,
    // contract 必须带出来：派发卡按它把工具分到「排任务与签合约」那一组，
    // 漏了的话那几样会落进缺省勾上的组里——用户以为自己勾的是「改我的内容」，
    // 卡上却把「配定时」也算了进去。**类型上它是可选的，所以漏传不会报错**（有守卫）。
    contract: t.contract === true,
    description: t.def.description,
  }));
}

export { AGENT_TOOLS };

/** 只给测试用：这几个是内部函数，但它们的口径值得被单独钉住。 */
export const __testing = { capMessages, foldSummary, pruneOldToolResults, KEEP_RECENT, MAX_MESSAGES_CHARS };

/**
 * 给 lib/agent/wake.ts 用的对话收口。
 *
 * 它与主循环走的是同一个 capMessages——**叫醒那条路径此前是裸 slice 字符串**，
 * 会把 JSON 砍在中间，下一轮解析兜底成空数组、整段上下文无声无息地消失。
 */
export function capMessagesForWake(messages: ChatMessage[]): string {
  return capMessages(messages);
}
