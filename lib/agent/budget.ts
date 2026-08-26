import { prisma } from '../db';
import { effectivePlan } from '../pay/plan';

// ── 一次执行最多能烧多少 ──────────────────────────────────────────────────────
//
// 【为什么预算的单位是「模型调用次数」而不是「轮数」】
// 轮数只数模型说了几次话，而**一次工具调用内部可能自己调十几次模型**：
//   run_advisor      —— 十几席专家并行发言，每人一次
//   generate_topics  —— 八条选题各精排一次
//   run_agent        —— 一整条流水线，每步都可能是一次生成
// 按轮数封顶等于没有封顶：24 轮 × 每轮最多 5 个工具 × 每个工具十几次 ≈ 三千次调用，
// 而 free 档一天总共 30 次。一个人的一次任务能把全团队当天的额度吃干。
//
// 用量按 LlmCallLog.runId 现算（批 0 加的那一列），不自己维护计数器——
// 账本才是事实来源，另记一份迟早会与它对不上。

/** 各档的缺省预算（一次执行最多几次模型调用）。策略值，可后调。 */
const PLAN_BUDGET: Record<string, number> = {
  free: 15,
  trial: 60,
  personal: 60,
  byok: 60,
  enterprise: 120,
};
const FALLBACK_BUDGET = PLAN_BUDGET.free;

/** 自主智能体可以把自己的预算配到多高（配置形数据，不能无上限）。 */
export const MAX_CONFIGURABLE_BUDGET = 100;

/**
 * 单次执行里，某个 costly 工具最多允许被调几次。
 *
 * 【为什么这层还要有】总预算拦得住「烧了多少」，拦不住「一步就烧完」：
 * 一次 run_advisor 是 12–16 次调用，模型连开三场会诊就把 free 档的预算清空，
 * 而用户要的只是一篇稿子。没列在这里的工具不限次（总预算兜底）。
 */
export const PER_RUN_TOOL_CAP: Record<string, number> = {
  run_advisor: 1,
  generate_topics: 2,
  run_agent: 2,
  generate_image: 4,
};

export async function budgetForTenant(tenantId: string): Promise<number> {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, planExpiresAt: true } });
    // 到期即降档，与配额那边同一个懒判断（不依赖任何定时任务）
    const plan = effectivePlan(t?.plan ?? 'free', t?.planExpiresAt ?? null);
    return PLAN_BUDGET[plan] ?? FALLBACK_BUDGET;
  } catch {
    return FALLBACK_BUDGET;
  }
}

/** 这次执行到目前为止真的烧了多少次模型调用。 */
export async function callsUsed(runId: string): Promise<number> {
  return prisma.llmCallLog.count({ where: { runId, mocked: false } });
}

/** 这次执行里某个工具已经被调了几次（数的是真的执行过的，不含被拒绝/被跳过的）。 */
export async function toolUsedTimes(runId: string, tool: string): Promise<number> {
  // 【数 tool_call 不数 tool_result】一次**挂起类**调用（run_agent 派子运行、
  // 派活给插件）会写两条 tool_result：挂起时一条、被叫醒补结果时又一条。
  // 按 tool_result 数的话 run_agent 的上限 2 实际只有 1——第二次就被拦，
  // 而用户看到的是「这一步在本次任务里已经用过 2 次」，他明明只派过一次。
  // tool_call 每次真实调用恰好一条，普通路径与确认路径都一样。
  return prisma.agentStep.count({ where: { runId, tool, kind: 'tool_call' } });
}

/**
 * 这个工具这次还能不能再调。返回一句给模型看的拒绝理由，或 null 表示放行。
 *
 * 【为什么把话说给模型听而不是直接失败】模型收到「这一步不能再调了」会换个做法
 * 或者如实告诉用户；直接抛错则会让它以为是临时故障而重试，白白多烧几次。
 */
export async function toolCapReason(runId: string, tool: string): Promise<string | null> {
  const cap = PER_RUN_TOOL_CAP[tool];
  if (!cap) return null;
  // 【当前这一次已经记在里面了】tool_call 那条流水在闸之前就写了（时间线要看得见
  // 模型想干什么），所以 used 含本次。上限判据相应是 used > cap 而不是 >=。
  const used = await toolUsedTimes(runId, tool);
  if (used <= cap) return null;
  return `这一步在本次任务里已经用到上限了（单次任务最多 ${cap} 次），不能再调。`
    + '如果确实还需要，请告诉用户让他另外发起一次。';
}
