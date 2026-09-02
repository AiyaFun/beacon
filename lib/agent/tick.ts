import { prisma } from '../db';
import { createLogger } from '../logger';
import { kickAgentRun } from './kick';
import { resumeIfQuotaReset } from './run';
import { promoteQueued, QUEUED_STALE_DAYS } from './queue';

const log = createLogger({ module: 'agent-tick' });

// ── 后台执行的定时兜底 ────────────────────────────────────────────────────────
//
// 【为什么读路径自愈不够了】原来两种自愈都挂在 getAgentRunView 上，理由是
// 「没人看的运行，醒不醒都没有影响」。执行还是**用户盯着页面等**的时候这话成立。
//
// 现在不成立了：一次运行会挂起几个小时（等额度重置），用户早就关了页面去干别的，
// 指望他半夜回来打开页面替它踢一脚，等于这条自愈根本不存在。**没人看的时候
// 恰恰是它最需要被推一把的时候。**
//
// 四件事，都刻意做得很窄——只捞真正卡住的那几行，不做全表扫：
//   ① 额度重置时刻到了的：翻回 running 接着跑
//   ② 租约过期还挂在 running 的：跑它的那个进程没了（部署重启、容器被杀），接手
//   ③ 挂起等太久的：被等的那件事崩了就永远醒不来，而挂起会一直占着并发名额
//   ④ 排着队却没人叫的：正常提拔挂在状态迁移上，而**进程被杀时不会发生任何状态迁移**
//   ⑤ 跑飞的智能体流水线：它是 fire-and-forget 起的，没有租约也没人接手
//
// 【一次最多处理多少】封顶是为了防 0 点那一下的踩踏：整个平台的运行都在等
// 同一个重置时刻，一口气全放出去会瞬间把新额度再烧光一遍，还会把队列塞满。
// 放不完的下一轮（10 分钟后）接着放——反正它们已经等了一整晚。
const MAX_RESUME_PER_TICK = 20;
const MAX_REKICK_PER_TICK = 20;
const MAX_PROMOTE_PER_TICK = 20;
const MAX_SETTLE_PER_TICK = 30;

/**
 * 一条智能体流水线多久没动就当它死了。
 *
 * 它每跑完一步就写一次行（stepIndex/log），所以 updatedAt 就是心跳——不需要另加租约列。
 * 阈值取得宽：单步最长的是「派一个智能体」（20 分钟超时），十步的模板理论上能跑很久，
 * 但**两小时一步没动**只可能是跑它的进程没了。
 */
const WORKFLOW_STALE_MS = 2 * 60 * 60_000;
const MAX_WORKFLOW_REAP_PER_TICK = 20;

/**
 * 等确认等了多久算没人要了。
 *
 * 【为什么要有超时】原来 awaiting_confirm 会永远挂着：它不占并发名额、到期清理只删终态，
 * 于是一条没人点的确认卡会一直亮着红点，而它手里那份对话（三天前查到的数据、当时的草稿列表）
 * 早就过时了——真点了「同意」，执行的是三天前的判断。学 Hermes 的口径：审批超时=拒绝，
 * 如实关掉并通知，用户要做就重新派一次，模型会按现在的数据重新想。
 * 与排队超时用同一个数（QUEUED_STALE_DAYS），一条「多久没人管就算了」的规矩比两条好记。
 */
export const CONFIRM_STALE_DAYS = QUEUED_STALE_DAYS;
const MAX_EXPIRE_CONFIRM_PER_TICK = 30;

export type AgentTickResult = {
  resumed: number; rekicked: number; promoted: number; settled: number; reapedWorkflows: number;
  expiredConfirms: number;
};

export async function tickAgentRuns(): Promise<AgentTickResult> {
  const now = new Date();

  // ① 等额度的：到点了就翻回 running
  const waiting = await prisma.agentRun.findMany({
    where: { status: 'waiting_quota', quotaResumeAt: { lte: now } },
    select: { id: true, quotaResumeAt: true },
    orderBy: { quotaResumeAt: 'asc' }, // 等得最久的先放
    take: MAX_RESUME_PER_TICK,
  });
  let resumed = 0;
  for (const r of waiting) {
    // 走 resumeIfQuotaReset 而不是自己 update：状态翻转必须是乐观锁的，
    // 否则这一轮定时与「用户正好打开了页面」会同时把它踢起来，两条推理线写同一行
    if (await resumeIfQuotaReset(r.id, r.quotaResumeAt).catch(() => false)) resumed++;
  }

  // ② 跑着跑着进程没了的：租约过期即接手。
  //    这里**只踢不改状态**——它本来就是 running，kick 那边的 claimLease 会去抢租约，
  //    抢不到（真有别人在跑）就自己退，不会双跑。
  const stale = await prisma.agentRun.findMany({
    where: { status: 'running', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: MAX_REKICK_PER_TICK,
  });
  for (const r of stale) kickAgentRun(r.id);

  // ③ 挂起太久的：等的那件事崩了（worker 被杀、进程重启）就永远醒不来。
  //    **没有这一步的话它会永久占着一个并发名额**——提拔只在终态发生、
  //    到期清理只删终态、读路径自愈要有人打开页面才触发。
  const settled = await settleStaleWaits();

  // ④ 排着队却没人叫的：正常情况下提拔挂在状态迁移上，轮不到这里。
  //    但那条链路有一处断点——**进程被杀时不会发生任何状态迁移**：
  //    三个 running 随进程消失，队列里的就永远等着一个不会到来的「让位」。
  //    ②那步会把它们接手回来，这一步则负责把队伍往前挪。
  const promoted = await promoteWaitingWorkspaces();

  // ⑤ 跑飞的智能体流水线。它由 kickWorkflowRun 以 fire-and-forget 起，**既没有租约
  //    也没有接手机制**：进程一没（部署重启、容器被杀），那条 WorkflowRun 就永远停在
  //    running——运行中心里它是一条永远转圈的记录，用户既看不出结果也没法重跑。
  //    这里不接手（重跑一半的流水线会把已经做过的步骤再做一遍，可能真的重复建草稿），
  //    而是**如实判死**，让用户自己决定要不要再跑一次。
  const reapedWorkflows = await reapStaleWorkflowRuns(now);

  // ⑥ 等确认等太久的：审批超时=拒绝（见 CONFIRM_STALE_DAYS）
  const expiredConfirms = await expireStaleConfirms(now);

  if (resumed > 0 || stale.length > 0 || promoted > 0 || settled > 0 || reapedWorkflows > 0 || expiredConfirms > 0) {
    log.info('AI 执行兜底巡检', { resumed, rekicked: stale.length, promoted, settled, reapedWorkflows, expiredConfirms });
  }
  return { resumed, rekicked: stale.length, promoted, settled, reapedWorkflows, expiredConfirms };
}

/** 等确认超过 CONFIRM_STALE_DAYS 天的，如实取消并通知。 */
export async function expireStaleConfirms(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONFIRM_STALE_DAYS * 86_400_000);
  const stale = await prisma.agentRun.findMany({
    where: { status: 'awaiting_confirm', updatedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: MAX_EXPIRE_CONFIRM_PER_TICK,
  });
  if (stale.length === 0) return 0;
  const { transition } = await import('./run');
  let n = 0;
  for (const r of stale) {
    const reason = `等你确认等了 ${CONFIRM_STALE_DAYS} 天没有回应，已自动取消——那时查到的数据早就过时了，要做请重新派一次。`;
    // 乐观锁：这一刻用户可能正好点了确认或终止
    if (!(await transition(r.id, 'awaiting_confirm', 'cancelled', {
      error: reason, pending: null, waitingOn: null, leaseUntil: null, quotaResumeAt: null,
    }))) continue;
    n++;
    // transition 对 cancelled 刻意不自动通知（多数取消是用户自己点的）；这一种是系统替他取消的，要说一声
    await notifyStaleCancel(r.id, reason);
  }
  if (n > 0) log.info('清掉等确认超时的执行', { count: n });
  return n;
}

/**
 * 挂着等外部结果的那些：查一遍那件事到底有没有结果，等太久的如实收尾。
 *
 * 只扫 waitingOn 非空的挂起运行（有索引），一次最多一批。
 */
async function settleStaleWaits(): Promise<number> {
  const waiting = await prisma.agentRun.findMany({
    where: { status: 'waiting_browser', waitingOn: { not: null } },
    select: { id: true, waitingOn: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' }, // 等得最久的先看
    take: MAX_SETTLE_PER_TICK,
  });
  let n = 0;
  const { settleIfResolved } = await import('./wake');
  for (const r of waiting) {
    if (await settleIfResolved(r.waitingOn!, r.updatedAt).catch(() => false)) n++;
  }
  return n;
}

/** 每个有人在排队的工作区各提拔一个（提拔本身会再判一次并发上限）。 */
async function promoteWaitingWorkspaces(): Promise<number> {
  const queued = await prisma.agentRun.findMany({
    where: { status: 'queued' },
    select: { workspaceId: true },
    distinct: ['workspaceId'],
    take: MAX_PROMOTE_PER_TICK,
  });
  let n = 0;
  for (const q of queued) {
    if (await promoteQueued(q.workspaceId).catch(() => null)) n++;
  }
  return n;
}

/**
 * 排太久没轮上的，当作没人要了。
 *
 * 【为什么要清】queued 不是终态，到期清理（只删 done/failed/cancelled）碰不到它——
 * 一条排在别人后面、而前面那些又都挂了的运行会**永久**留在库里，还占着这个工作区的排队名额。
 * 由每日清理调用（lib/legal/retention.ts）。
 */
export async function cancelStaleQueued(): Promise<number> {
  const cutoff = new Date(Date.now() - QUEUED_STALE_DAYS * 86_400_000);
  const stale = await prisma.agentRun.findMany({
    where: { status: 'queued', createdAt: { lt: cutoff } },
    select: { id: true },
    take: 200,
  });
  let n = 0;
  const { transition } = await import('./run');
  for (const r of stale) {
    const reason = `排队超过 ${QUEUED_STALE_DAYS} 天都没轮上，已自动取消。可以重新派一次。`;
    if (!(await transition(r.id, 'queued', 'cancelled', { error: reason }))) continue;
    n++;
    // 【这一条要自己发通知】transition 的自动通知**刻意不管 cancelled**：
    // 绝大多数取消是用户自己点的「终止」，他当然知道，推给他只是噪音。
    // 而这一种是**系统替他取消的**——不说一声，他就是在等一个永远不会跑的任务。
    await notifyStaleCancel(r.id, reason);
  }
  if (n > 0) log.info('清掉排太久没轮上的执行', { count: n });
  return n;
}

async function notifyStaleCancel(runId: string, reason: string): Promise<void> {
  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true, accountId: true, goal: true, episode: true },
    });
    if (!run) return;
    const { notify } = await import('../notify');
    const { notifyRefId } = await import('./notify-run');
    await notify({
      workspaceId: run.workspaceId,
      accountId: run.accountId,
      kind: 'system',
      refId: notifyRefId(runId, 'cancelled', run.episode),
      title: `排队的任务已自动取消：${run.goal.slice(0, 40)}`,
      body: reason,
      link: `/assistant?run=${runId}`,
    });
  } catch {
    // 通知发不出去是小事
  }
}

/**
 * 把跑飞的智能体流水线如实判死。
 *
 * 【为什么不接手而是判死】AI 执行那边接手是安全的：状态与对话全在库里，重进主循环
 * 从最新一轮接着推。流水线不是——它跑到一半重来会把已经做过的步骤**再做一遍**
 *（真的重复建草稿、重复出图、重复烧额度）。宁可如实说「它断在第 N 步」，
 * 让用户自己决定要不要重跑。
 *
 * 判死会走到 wakeRunsWaitingOn（settleWorkflow 认 failed），所以挂在它上面的
 * AI 执行会被一并叫醒——不用等那 24 小时的挂起兜底。
 */
async function reapStaleWorkflowRuns(now: Date): Promise<number> {
  const dead = await prisma.workflowRun.findMany({
    where: { status: 'running', updatedAt: { lt: new Date(now.getTime() - WORKFLOW_STALE_MS) } },
    select: { id: true, stepIndex: true },
    orderBy: { updatedAt: 'asc' },
    take: MAX_WORKFLOW_REAP_PER_TICK,
  });
  if (dead.length === 0) return 0;

  let n = 0;
  for (const r of dead) {
    // 乐观锁：它可能正好在这一刻跑完了
    const done = await prisma.workflowRun.updateMany({
      where: { id: r.id, status: 'running' },
      data: {
        status: 'failed',
        error: `这次运行在第 ${r.stepIndex + 1} 步之后就没有动静了（多半是跑它的进程重启了），已经如实标记为失败。已经做完的步骤不会重做——要继续的话请重新跑一次。`,
      },
    });
    if (done.count !== 1) continue;
    n++;
    // 挂在它上面的 AI 执行要立刻叫醒，别让人家干等 24 小时的挂起兜底
    try {
      const { wakeRunsWaitingOn, workflowWaitToken } = await import('./wake');
      await wakeRunsWaitingOn(workflowWaitToken(r.id), {
        ok: false,
        summary: '那个智能体跑到一半就没动静了（多半是跑它的进程重启了）',
      });
    } catch {
      // 叫不醒也没关系：settleIfResolved 与 24 小时到期兜底都还在
    }
  }
  if (n > 0) log.info('清掉跑飞的智能体流水线', { count: n });
  return n;
}
