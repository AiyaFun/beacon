import { prisma } from '../db';
import { createLogger } from '../logger';

const log = createLogger({ module: 'agent-queue' });

// ── 一个工作区同时能跑几个 AI 执行 ──────────────────────────────────────────────
//
// 【为什么要有上限】执行改成后台跑之后，派活的成本降到「打一行字」——用户可以在半分钟里
// 派出十个。十条推理线同时烧同一个租户的额度，谁也跑不完，而额度是共享的：
// 后面那几条把前面几条的额度吃掉，最后是十个半途而废。
// 排队反而更快出活：一次跑完一个。
//
// 【上限只数 running】挂起的那些（等确认、等插件、等额度）**不占名额**。
// 数它们的话会死锁：三个运行都停在「等你确认」，用户想再派一个新的却被拦住，
// 而他要确认的那三个恰恰要他先腾出手来——两边互相等。
//
// 代价是「同时活着的运行」可以超过 3 个（比如 3 个在跑 + 5 个等确认）。这是对的：
// 真正在烧钱的只有 running 那几个。

/** 一个工作区同时最多几个运行在真的跑。 */
export const MAX_CONCURRENT_RUNS = 3;

/**
 * 一个工作区最多排多长的队。
 *
 * 排满了就当场拒绝而不是继续收：队列无上限的话，一个手滑连点二十次的用户会给自己
 * 排出一条跑一整天的队，而他多半只想要第一条的结果。当场说「排队满了」他会去看
 * 前面那些跑得怎么样——这正是他该做的事。
 */
export const MAX_QUEUED_RUNS = 10;

/** 排了这么多天还没轮上的，当作没人要了。 */
export const QUEUED_STALE_DAYS = 7;

export type QueueDecision = { status: 'running' | 'queued'; queuePosition: number };

/**
 * 新运行该直接跑还是先排队。
 *
 * 【竞态怎么办：明文容忍超发】这是「先数后建」，两个请求可能同时数到 2<3 于是双双开跑，
 * 结果是 4 个在跑。**这个后果是可接受的**：租约保证了没有任何一条运行会被跑两遍，
 * 超出的那一两条只是让额度消耗得快一点点。
 * 而为它上一把分布式锁（或走事务串行化）要引入一整套新的失败模式——
 * Redis 不可用时是拦死所有人还是放行所有人？两个答案都比「偶尔多跑一条」糟。
 */
export async function decideQueue(workspaceId: string): Promise<QueueDecision> {
  const [running, queued] = await Promise.all([
    prisma.agentRun.count({ where: { workspaceId, status: 'running' } }),
    prisma.agentRun.count({ where: { workspaceId, status: 'queued' } }),
  ]);

  if (queued >= MAX_QUEUED_RUNS) {
    throw new Error(
      `排队的任务已经有 ${queued} 个了，先看看它们跑得怎么样再派新的吧（同时最多排 ${MAX_QUEUED_RUNS} 个）。`,
    );
  }
  // 已经有人在排队时，新来的一律排到队尾——即使这一刻恰好有空位。
  // 不然「先到的还在排、后到的插队先跑」，而先到的那个用户什么都没做错。
  if (running >= MAX_CONCURRENT_RUNS || queued > 0) {
    return { status: 'queued', queuePosition: queued + 1 };
  }
  return { status: 'running', queuePosition: 0 };
}

/**
 * 让位了：把排最久的那个提拔起来。
 *
 * 【调用点只有一处：transition】一个运行离开 running（跑完了、失败了、停下来等确认了、
 * 等插件了、等额度了）就腾出一个名额。挂在状态迁移那个咽喉上，新增任何一种停法都不会漏掉。
 *
 * 一次只提拔一个：名额是一个一个腾出来的，一口气放三个等于绕开上限。
 */
export async function promoteQueued(workspaceId: string): Promise<string | null> {
  const running = await prisma.agentRun.count({ where: { workspaceId, status: 'running' } });
  if (running >= MAX_CONCURRENT_RUNS) return null;

  const next = await prisma.agentRun.findFirst({
    where: { workspaceId, status: 'queued' },
    orderBy: { createdAt: 'asc' }, // 排最久的先上
    select: { id: true },
  });
  if (!next) return null;

  // 走 transition 的乐观锁：两条线同时提拔（一个运行刚结束 + 定时巡检）时只有一个能成
  const { transition } = await import('./run');
  const ok = await transition(next.id, 'queued', 'running');
  if (!ok) return null;

  const { kickAgentRun } = await import('./kick');
  kickAgentRun(next.id);
  log.info('排队的执行被提拔上来了', { runId: next.id, workspaceId });
  return next.id;
}

/** 我前面还排着几个。给界面说「排第 N 位」用。 */
export async function queuePositionOf(run: { workspaceId: string; createdAt: Date }): Promise<number> {
  const ahead = await prisma.agentRun.count({
    where: { workspaceId: run.workspaceId, status: 'queued', createdAt: { lt: run.createdAt } },
  });
  return ahead + 1;
}
