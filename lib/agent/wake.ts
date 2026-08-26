import { prisma } from '../db';
import { toJson, parseJson } from '../json';
import { createLogger } from '../logger';
import { kickAgentRun } from './kick';
import { transition } from './run';
import type { ChatMessage, ToolCall } from '../llm/types';

const log = createLogger({ module: 'agent-wake' });

// ── 叫醒在等外部结果的执行 ────────────────────────────────────────────────────
//
// 一次运行可以停在「等浏览器插件把活干完」上（AgentRun.status=waiting_browser，
// waitingOn=`browser:<taskId>`）。这个文件是它**唯一的醒来通道**。
//
// 【叫醒矩阵要全，缺一格就是永远醒不来】那件事的结局不止「成功」一种：
//   done      → 带着结果继续推理
//   failed    → 如实告诉模型没采到，让它换个说法回答用户
//   expired   → 插件一直没打开，48 小时到了
//   cancelled → 用户自己取消了这个采集
// 只接 done 的话，后三种就是一次挂在那里到天荒地老的运行——而用户看到的是
// 「进行中」。所以下面四种结局都要有人来敲门。
//
// 【为什么结果是「补上那条 tool 回复」而不是新加一句话】挂起时对话里留着一个
// 悬空的 tool_call（见 run.ts 的 park）。补上它，模型看到的就是一次正常的
// 「我调了工具 → 拿到结果」，不需要理解「中间隔了三小时」这件事。

export type WaitOutcome = {
  ok: boolean;
  /** 给模型看的一句话结论 */
  summary: string;
  /** 可选的结构化结果 */
  data?: unknown;
};

// ── 等待令牌 ──────────────────────────────────────────────────────────────────
//
// 格式统一 `<类型>:<id>`，拼法都在这里，别在调用点手写字符串。
// 三种被等的对象：
//   browser:  浏览器插件的任务（要等用户下次打开浏览器，以小时计）
//   workflow: 一条智能体流水线（后台跑，几分钟到几十分钟）
//   run:      另一次 AI 执行（自主智能体的子运行）
//
// 【加新类型时必须同时做三件事】否则挂上去的运行永远醒不来：
//   ① 被等的那件事到终态时调 wakeRunsWaitingOn
//   ② settleIfResolved 加一个分支（读路径自愈：错过实时叫醒时的兜底）
//   ③ 想清楚它的到期时间（等不到时谁来收尾）
// 只做①的话，进程在「落库」与「叫醒」之间挂一次，那条运行就永远挂着了。

export function browserWaitToken(taskId: string): string {
  return `browser:${taskId}`;
}

export function workflowWaitToken(runId: string): string {
  return `workflow:${runId}`;
}

export function runWaitToken(runId: string): string {
  return `run:${runId}`;
}

/**
 * 挂起多久算等不到了。
 *
 * browser 那种有自己的 expiresAt（48 小时，插件要等用户开浏览器）；
 * 另外两种是后台任务，跑几十分钟就该有结果——挂过一天基本可以断定那边死了，
 * 而**没有到期兜底的挂起会永久占着这个工作区的一个并发名额**。
 */
export const WAIT_TTL_MS = 24 * 60 * 60_000;

/**
 * 叫醒所有在等这件事的运行。
 *
 * 一件事可能有多次运行在等（同一个竞对，两个人各派了一次，去重后是同一条任务）。
 * 用 waitingOn 反查而不是在任务上记「谁在等我」：等待方是多个，被等方只有一个。
 */
export async function wakeRunsWaitingOn(token: string, outcome: WaitOutcome): Promise<number> {
  const runs = await prisma.agentRun.findMany({
    // 状态不写死 waiting_browser：等工作流、等子运行的那些也停在这个状态上
    //（它们共用同一套「挂起 → 补 tool 回复 → 继续」的机制）
    where: { waitingOn: token, status: 'waiting_browser' },
    select: { id: true, messages: true, pending: true, steps: true },
  });
  if (runs.length === 0) return 0;

  let woken = 0;
  for (const run of runs) {
    try {
      const call = run.pending ? parseJson<ToolCall | null>(run.pending, null) : null;
      const messages = parseJson<ChatMessage[]>(run.messages, []);
      const content = outcome.ok
        ? toJson({ ok: true, summary: outcome.summary, data: outcome.data }).slice(0, 6000)
        : toJson({ ok: false, error: outcome.summary }).slice(0, 2000);

      if (call) {
        // 补上挂起时留下的那条悬空 tool_call 的回复
        messages.push({ role: 'tool', toolCallId: call.id, content });
      } else {
        // pending 丢了（降级部署 / 手工改过库）：退一步用一句话告诉模型发生了什么。
        // 不这么兜的话，这次运行会带着一个永远没有回复的 tool_call 去调模型，多数端点直接 400。
        messages.push({ role: 'user', content: `【系统】你之前等的那件事有结果了：${outcome.summary}` });
      }

      // 走 transition 的**乐观锁**：叫醒可能被触发两次（回执重投、自愈顺手也叫了一次），
      // 没有它两条推理线会同时被踢起来
      // 【绝不能对序列化后的 JSON 做裸截断】早先这里是 `toJson(messages).slice(0, 200_000)`：
      // 挂起时对话本来就接近上限，叫醒又追加一条最长 6000 字的工具回复，很容易刚好越线
      // 被砍在字符串中间 —— 下一轮 parseJson 兜底成 `[]`，**系统提示词与用户那句话一起消失**，
      // 模型被喂一个空对话，而整个过程一声不响。
      // capMessages 走的是「按消息折叠/丢弃」，出来的永远是合法 JSON。
      const { capMessagesForWake } = await import('./run');
      const updated = await transition(run.id, 'waiting_browser', 'running', {
        pending: null,
        waitingOn: null,
        steps: run.steps + 1,
        messages: capMessagesForWake(messages),
      });
      if (updated) {
        // 【流水要写在抢到那一步之后】原来是先写 AgentStep 再 transition：
        // 叫醒被触发两次时（回执重投 + 读路径自愈），第二次的 transition 会落空，
        // 但那条流水已经写进去了——用户在时间线上看到**同一个结果出现两遍**，
        // 而且 seq 与 AgentRun.steps 从此对不上。
        await prisma.agentStep.create({
          data: {
            runId: run.id,
            seq: run.steps + 1,
            kind: 'tool_result',
            tool: call?.name ?? '',
            args: toJson({}),
            result: content.slice(0, 4000),
            ok: outcome.ok,
          },
        });
        woken++;
        kickAgentRun(run.id);
      }
    } catch (err) {
      // 一次叫醒失败不能连坐其它在等的运行
      log.warn('叫醒执行失败', { runId: run.id, token, error: (err as Error).message });
    }
  }
  if (woken > 0) log.info('已叫醒等待中的 AI 执行', { token, woken });
  return woken;
}

/**
 * 自愈：那件事其实早就有结果了，只是当时没人来叫醒。
 *
 * 【什么时候会这样】回执落库与叫醒之间进程挂了；或者任务是被每日清理判过期的，
 * 而整机版在批 5 之前根本不跑那条清理。用户打开页面看这次运行时顺手补一刀，
 * 比专门开一条定时任务扫全表划算——反正没人看的运行，醒不醒都没有影响。
 */
export async function settleIfResolved(token: string, waitingSince?: Date | null): Promise<boolean> {
  // 【按类型分派】早先这里写死 `if (!token.startsWith('browser:')) return false`，
  // 于是等工作流、等子运行的那些**完全没有自愈通道**：错过一次实时叫醒
  //（进程在「落库」与「叫醒」之间挂掉，或者后台任务比 park 还快跑完）就永远挂着。
  // 而 browser 那种靠插件轮询天然错开，另外两种秒级跑完是常态——这个竞态在那边是日常。
  if (token.startsWith('workflow:')) return settleWorkflow(token, waitingSince);
  if (token.startsWith('run:')) return settleChildRun(token, waitingSince);
  if (!token.startsWith('browser:')) return false;
  const taskId = token.slice('browser:'.length);
  const task = await prisma.browserTask.findUnique({
    where: { id: taskId },
    select: { status: true, result: true, error: true, expiresAt: true },
  });

  // 任务行没了（被清理掉了）：等下去没有意义，如实叫醒
  if (!task) {
    return (await wakeRunsWaitingOn(token, { ok: false, summary: '那条派给插件的任务已经不在了，没能拿到结果' })) > 0;
  }

  // 还没到期但过了有效期：清理任务还没轮到它，这里当场按过期处理
  if ((task.status === 'pending' || task.status === 'claimed') && task.expiresAt < new Date()) {
    return (await wakeRunsWaitingOn(token, { ok: false, summary: '插件一直没来领这个活，已经超过有效期了（多半是那台浏览器这两天没打开）' })) > 0;
  }

  switch (task.status) {
    case 'done':
      return (await wakeRunsWaitingOn(token, { ok: true, summary: task.result || '插件已经跑完了' })) > 0;
    case 'failed':
      return (await wakeRunsWaitingOn(token, { ok: false, summary: `插件没跑成：${task.error || '未说明原因'}` })) > 0;
    case 'expired':
      return (await wakeRunsWaitingOn(token, { ok: false, summary: '插件一直没来领这个活，已经超过有效期了（多半是那台浏览器这两天没打开）' })) > 0;
    case 'cancelled':
      return (await wakeRunsWaitingOn(token, { ok: false, summary: '这个采集任务被取消了' })) > 0;
    default:
      return false; // pending / claimed：还在等，什么都不做
  }
}

/** 等一条智能体流水线：查它现在到底跑完没有。 */
async function settleWorkflow(token: string, waitingSince?: Date | null): Promise<boolean> {
  const runId = token.slice('workflow:'.length);
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { status: true, error: true, log: true },
  });
  if (!run) {
    return (await wakeRunsWaitingOn(token, { ok: false, summary: '那条智能体运行记录已经不在了，没能拿到结果' })) > 0;
  }
  if (run.status === 'done') {
    return (await wakeRunsWaitingOn(token, { ok: true, summary: '智能体已经跑完了', data: { runId } })) > 0;
  }
  if (run.status === 'failed' || run.status === 'cancelled') {
    return (await wakeRunsWaitingOn(token, { ok: false, summary: run.error || '智能体没跑成' })) > 0;
  }
  return expireIfTooLong(token, waitingSince, '那个智能体跑了太久也没有结果，先不等了');
}

/** 等另一次 AI 执行（自主智能体的子运行）。 */
async function settleChildRun(token: string, waitingSince?: Date | null): Promise<boolean> {
  const childId = token.slice('run:'.length);
  const child = await prisma.agentRun.findUnique({
    where: { id: childId },
    select: { status: true, answer: true, error: true },
  });
  if (!child) {
    return (await wakeRunsWaitingOn(token, { ok: false, summary: '那次子任务的记录已经不在了，没能拿到结果' })) > 0;
  }
  if (child.status === 'done') {
    return (await wakeRunsWaitingOn(token, { ok: true, summary: child.answer || '子任务已经跑完了' })) > 0;
  }
  if (child.status === 'failed' || child.status === 'cancelled') {
    return (await wakeRunsWaitingOn(token, {
      ok: false,
      summary: child.error || (child.status === 'cancelled' ? '子任务被用户终止了' : '子任务没跑成'),
    })) > 0;
  }
  return expireIfTooLong(token, waitingSince, '那次子任务跑了太久也没有结果，先不等了');
}

/**
 * 等太久了就如实收尾。
 *
 * 【没有这一步的后果】被等的那件事一崩（worker 被杀、进程重启），父运行就**永久**挂着——
 * 提拔只在终态发生、到期清理只删终态、读路径自愈也救不了它，
 * 于是它一直占着这个工作区的一个并发名额。三条挂死就把整个工作区堵住了。
 */
async function expireIfTooLong(token: string, waitingSince: Date | null | undefined, why: string): Promise<boolean> {
  if (!waitingSince) return false; // 不知道等了多久就别乱判死
  if (Date.now() - waitingSince.getTime() < WAIT_TTL_MS) return false;
  return (await wakeRunsWaitingOn(token, { ok: false, summary: why })) > 0;
}
