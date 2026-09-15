import { prisma } from '../db';

// ── 一次执行的账：花了多少、做了什么、能不能用 ─────────────────────────────
//
// 【为什么单独一层】账本 LlmCallLog 很强（token / costUsd / source / mocked / degraded / runId），
// 但用户能看到的只有「用了 N 次调用 · 约 Nk tokens」一句话。真正要回答的是：
//   · 这次是真花了钱还是落了 Mock（mock 的产物是编的，不能当交付）
//   · 钱是平台垫的还是用户自己 Key 出的
//   · 预算用掉了几成（离被封顶还有多远）
//   · 调了多少次工具、被拒了几次、出了几次错
// 全是**现算的聚合**，不落库：账本与步骤表才是权威，这里只做一次读出来的汇总，
// 任何数字都能回到原始行核对（报告口径：账单合计必须与 LlmCallLog 一致）。
//
// 【刻意不做的】不把模型成本按工具拆分。账本上没有 toolCallId，硬拆只能靠时间戳猜——
// 猜出来的「精确到每个工具的成本」比不给更糟。先给运行级；以后要拆再加列。

export type CallSource = 'platform' | 'byok' | 'mock' | 'unknown';

export type CallRow = {
  source: string;
  mocked: boolean;
  degraded: boolean;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};

export type CallSummary = {
  /** 真实调用次数（不含 Mock）。与旧的 cost.calls 同口径 */
  calls: number;
  /** 落到 Mock 的次数：没配 Key / 渠道全空时的兜底。这些产物是编的 */
  mockedCalls: number;
  /** 接了真模型但失败被兜底的次数。看到它该去查供应商，不是查配置 */
  degradedCalls: number;
  promptTokens: number;
  completionTokens: number;
  /** 两头相加，与旧的 cost.tokens 同口径 */
  tokens: number;
  /** 估算美元成本（lib/llm/pricing 口径）。Mock 行恒为 0 */
  costUsd: number;
  /** 各来源的**真实调用**次数：钱是谁出的 */
  bySource: Record<CallSource, number>;
};

const EMPTY: CallSummary = {
  calls: 0, mockedCalls: 0, degradedCalls: 0,
  promptTokens: 0, completionTokens: 0, tokens: 0, costUsd: 0,
  bySource: { platform: 0, byok: 0, mock: 0, unknown: 0 },
};

/** 把账本行汇总成一份账。**纯函数**，用例直接测——汇总写错不会红，只会让账对不上。 */
export function summarizeCalls(rows: readonly CallRow[]): CallSummary {
  const out: CallSummary = { ...EMPTY, bySource: { ...EMPTY.bySource } };
  for (const r of rows) {
    if (r.mocked) {
      out.mockedCalls += 1;
      if (r.degraded) out.degradedCalls += 1;
      // Mock 行也可能带 token 数（有的供应商兜底时仍回了 usage），但不算真实消耗
      continue;
    }
    out.calls += 1;
    out.promptTokens += r.promptTokens;
    out.completionTokens += r.completionTokens;
    out.costUsd += r.costUsd;
    const src: CallSource = r.source === 'platform' || r.source === 'byok' || r.source === 'mock' ? r.source : 'unknown';
    out.bySource[src] += 1;
  }
  out.tokens = out.promptTokens + out.completionTokens;
  // 浮点累加会长出 1e-17 的尾巴，账面上不该出现
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  return out;
}

/**
 * 预算用掉了几成。**预算数的是调用次数**（AgentRun.callBudget 注释），
 * 所以分子也只能是次数——拿 token 或美元去比是两种单位。
 * 预算为 0 / 负数时返回 null：那不是「用了 0%」，是没有预算这回事。
 */
export function budgetUsedPct(calls: number, budget: number): number | null {
  if (!Number.isFinite(budget) || budget <= 0) return null;
  return Math.min(999, Math.round((calls / budget) * 100));
}

export type RunEconomics = CallSummary & {
  runId: string;
  status: string;
  /** 这次执行最多能烧多少次调用 */
  budget: number;
  budgetUsedPct: number | null;
  /** 工具调用次数（AgentStep.kind=tool_call） */
  toolCalls: number;
  /** 用户拒掉的写操作次数 */
  rejected: number;
  /** 工具报错次数 */
  errors: number;
  artifacts: number;
  /** 终态时从发起到结束的**周期时长**（含等确认/等额度/等执行器的时间，不是纯执行时间）；未结束为 null */
  durationMs: number | null;
};

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * 一次执行的经济账。运行不存在返回 null。
 *
 * 四张表各查一次、在内存里汇总：一次执行的账本行是几十条量级，
 * 用 groupBy 拆成三四条 SQL 反而更慢也更难核对。
 */
export async function runEconomics(runId: string): Promise<RunEconomics | null> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, callBudget: true, createdAt: true, updatedAt: true },
  });
  if (!run) return null;
  const [calls, steps, artifacts] = await Promise.all([
    prisma.llmCallLog.findMany({
      where: { runId },
      select: { source: true, mocked: true, degraded: true, promptTokens: true, completionTokens: true, costUsd: true },
    }),
    prisma.agentStep.groupBy({ by: ['kind'], where: { runId }, _count: { _all: true } }),
    prisma.agentArtifact.count({ where: { runId } }),
  ]);
  const byKind = new Map(steps.map((s) => [s.kind, s._count._all]));
  const summary = summarizeCalls(calls);
  return {
    ...summary,
    runId: run.id,
    status: run.status,
    budget: run.callBudget,
    budgetUsedPct: budgetUsedPct(summary.calls, run.callBudget),
    toolCalls: byKind.get('tool_call') ?? 0,
    rejected: byKind.get('rejected') ?? 0,
    errors: byKind.get('error') ?? 0,
    artifacts,
    durationMs: TERMINAL.has(run.status) ? Math.max(0, run.updatedAt.getTime() - run.createdAt.getTime()) : null,
  };
}

/** 一批运行的账（员工档案按 30 天汇总用）。没有 runId 的调用不在里面——那不是执行器花的。 */
export async function runsEconomics(runIds: readonly string[]): Promise<CallSummary> {
  if (runIds.length === 0) return { ...EMPTY, bySource: { ...EMPTY.bySource } };
  const calls = await prisma.llmCallLog.findMany({
    where: { runId: { in: [...runIds] } },
    select: { source: true, mocked: true, degraded: true, promptTokens: true, completionTokens: true, costUsd: true },
  });
  return summarizeCalls(calls);
}

/** 「$0.0123」/「不到 $0.0001」/「$0」——给界面的一句钱。 */
export function fmtUsd(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.0001) return '不到 $0.0001';
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}
