// 「这次 LLM 调用是定时任务替用户跑的吗」——账本上的归因（2026-08-30）。
//
// ── 为什么需要它 ──
// 退款政策用「本单生效窗口内有没有真实 AI 调用」判断用户有没有消耗
//（lib/pay/order.ts 的 consumedCountForOrder → lib/pay/refund-amount.ts）。
// 而它数的是租户名下**所有**非 Mock 调用，包括这些用户没碰过的：
//   daily_recommend(05:00) / replenish_evergreen(05:20) / optimize_memory(05:30) /
//   generate_reviews(09:00) / weekly_review(周一 08:00) / run_scheduled_agents(每 10 分钟)
//
// 于是：用户 23:00 买了 ¥2999 永久买断，去睡觉；05:00 定时任务替他跑了一轮推荐；
// 早上他想退款 —— consumedCount > 0 → 从「未消耗，全额退」变成「转人工」。
// 他什么都没做，睡了一觉，自助全额退款的权利就没了。
//
// ── 为什么用 AsyncLocalStorage 而不是模块级变量 ──
// worker 进程里定时任务与别的异步工作是交错跑的，模块级的「当前任务名」会串味：
// A 任务设上、B 任务的调用读到 A 的名字；更糟的是整机版里 worker 与 web 同进程，
// 会把用户当场发起的调用也标成定时任务的 —— 那就从少算变成了多算。
// ALS 按异步上下文隔离，是这件事唯一正确的做法。
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ job: string }>();

/** 在定时任务的上下文里跑 fn。期间发生的 LLM 调用都会被记成这个任务名下的。 */
export function runInJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ job }, fn);
}

/** 当前这次调用是哪个定时任务发起的；用户当场发起的返回 null。 */
export function currentJob(): string | null {
  return store.getStore()?.job ?? null;
}
