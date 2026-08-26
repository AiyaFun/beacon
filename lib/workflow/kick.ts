import { createLogger } from '../logger';
import type { WorkflowContext } from './run';

const log = createLogger({ module: 'workflow-kick' });

// ── 「让这条工作流在后台跑起来」──────────────────────────────────────────────
//
// 与 lib/agent/kick.ts 是同一个形状，理由也一样：
//
// 【绝不能走 getQueue().enqueue】进程内队列的 enqueue 是**同步 await** 的
//（见 lib/jobs/queue.ts 的 InProcessQueue）。走它等于原地把工作流跑完，
// 而调用方——AI 执行器——正打算跑完之后把自己挂起来等结果。
// 于是次序变成「跑完 → 叫醒（这时没有人在等）→ 才挂起」，那条运行**永远醒不来**。
// agent 那边踩过一次，注释里写着「白改一场」。
//
// 【为什么不返回 Promise】返回的话迟早有人顺手 await 了，于是又悄悄变回同步。
// 返回 void，想等的只有一条路：settleWorkflowKicks()，它的名字就写着这是给测试用的。

const inflight = new Set<Promise<void>>();

export function kickWorkflowRun(ctx: WorkflowContext, runId: string): void {
  if (!runId) return;
  const task = (async () => {
    try {
      const { executeWorkflowRun } = await import('./run');
      await executeWorkflowRun(ctx, runId);
    } catch (err) {
      // 这里**没有调用方**：抛出去只会变成一条 unhandledRejection。
      // executeWorkflowRun 自己会把失败写进 WorkflowRun.error，
      // 而挂在它上面的 AI 执行由那边的叫醒/自愈/到期三道兜底负责。
      log.error('工作流后台跑失败', { runId, error: (err as Error).message });
    }
  })();
  inflight.add(task);
  void task.finally(() => inflight.delete(task));
}

/** 等所有后台工作流跑完。给测试与优雅停机——生产请求路径不该调它。 */
export async function settleWorkflowKicks(): Promise<void> {
  for (let i = 0; i < 20 && inflight.size > 0; i++) {
    await Promise.allSettled([...inflight]);
  }
}
