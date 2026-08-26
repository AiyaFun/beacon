import { getQueue } from '../jobs/queue';
import { createLogger } from '../logger';

const log = createLogger({ module: 'agent-kick' });

// ── 「让这次运行在后台往前跑一步」──────────────────────────────────────────────
//
// 【为什么单独一个小文件】run.ts 要在建完记录后叫它，browser-task 回执也要叫它，
// 而它们俩都在 run.ts 的下游。放进 run.ts 就是循环依赖，放进 jobs 里就得让
// jobs 反过来认识 agent。所以留一个只认「运行 id」的薄壳，真正的执行体
// 用**动态 import** 拿——依赖方向就永远是单向的。
//
// 【两种形态，同一个入口】
//   · bullmq（SaaS / 私有化）：投递给独立 worker 进程。web 进程立刻返回。
//   · 进程内（整机版 / 开发态 / 测试）：在 web 进程里脱离当前请求继续跑。
//     **不能走 getQueue().enqueue**——进程内队列的 enqueue 是同步 await 的，
//     那等于原地跑完，白改一场。
//
// 【为什么不用「返回 Promise 让调用方决定要不要 await」】那样迟早有人顺手 await 了，
// 于是又变回同步执行，而且是悄悄变回去的。这里返回 void，想等的人只有一条路：
// settleAgentKicks()，它的名字就写着「这是给测试和优雅停机用的」。

/** 进程内形态下还没跑完的那些。只为 settleAgentKicks 存在。 */
const inflight = new Set<Promise<void>>();

/**
 * 踢一脚：让这次运行在后台继续。**立刻返回，不等它跑完。**
 *
 * 调用点只有三处：建完运行、用户做完确认、等的事有结果了。
 * 重复踢是安全的——真正的并发防护是 run.ts 里的执行租约，不是调用方的自觉。
 */
export function kickAgentRun(runId: string): void {
  if (!runId) return;

  if (getQueue().kind === 'bullmq') {
    // 投递失败不能把调用方带走（用户已经看到「开始执行」了）。记日志 + 让运行留在
    // running：租约到期后 getAgentRunView 的自愈会再踢一次。
    void getQueue()
      .enqueue('run_agent_loop', { runId })
      .catch((err) => log.error('AI 执行入队失败', { runId, error: (err as Error).message }));
    return;
  }

  const task = (async () => {
    try {
      const { runAgentLoop } = await import('./run');
      await runAgentLoop(runId);
    } catch (err) {
      // 这里是**没有调用方**的地方：抛出去只会变成一条 unhandledRejection，
      // 而用户那边看到的是一次永远停在「进行中」的运行。runAgentLoop 自己
      // 会把失败写进库，这里兜的是它之前就炸了的情况。
      log.error('AI 执行后台跑失败', { runId, error: (err as Error).message });
    }
  })();

  inflight.add(task);
  void task.finally(() => inflight.delete(task));
}

/**
 * 等所有后台执行跑完。
 *
 * 给两种场景：① 测试要断言「跑完之后库里是什么样」；② 进程优雅停机。
 * 生产的请求路径**不该调它**——那就是把异步又变回同步。
 */
export async function settleAgentKicks(): Promise<void> {
  // 跑的过程中可能又踢出新的（确认→继续→再确认），所以要反复清空
  for (let i = 0; i < 50 && inflight.size > 0; i++) {
    await Promise.allSettled([...inflight]);
  }
}
