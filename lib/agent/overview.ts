import { prisma } from '../db';
import { deriveAgentState, statOf, type AgentState, type RunStat } from './overview-state';
import { parseAgentConfig, isAutonomous } from './autonomous';
import { LIVE_STATUSES } from './run';
import { toolByName } from './tools';
import { artifactHref, artifactKindLabel } from './artifacts';
import { runsEconomics, type CallSummary } from './economics';
import { parseWeekdays, AUTO_PAUSE_FAILS } from '../workflow/schedule';
import { scheduleWhen } from '../workflow/schedule-format';
import { parseSteps, stepLabel } from '../workflow/steps';

// ── 数字员工档案：一处回答「它会什么、现在能不能干、正在干什么、最近交付如何」 ──
//
// 【为什么不建 Agent 表】员工 = WorkflowTemplate（会什么）+ 它名下的 AgentRun / WorkflowRun（干过什么）
// + ScheduledAgent（什么时候干）+ LlmCallLog（花了多少）+ AgentArtifact（做出了什么）。
// 这些表各自都是权威；再建一张「员工表」就是第二份真相，状态一定会漂。
// 档案是**只读聚合**：每个数字都能一键下钻回原始运行，空数据不补默认值。
//
// 状态口径（可用/忙碌/受阻/故障/停用）在 ./overview-state.ts，那是客户端也能 import 的纯文件。

export { deriveAgentState, successRate, statOf, AGENT_STATE_LABEL } from './overview-state';
export type { AgentState, StateInput, RunStat } from './overview-state';

export type OverviewRun = {
  id: string;
  kind: 'agent' | 'workflow';
  title: string;
  status: string;
  origin: string;
  at: string;
  error: string | null;
  href: string;
};

export type AgentOverviewView = {
  id: string;
  slug: string;
  name: string;
  emoji: string;
  description: string;
  persona: string;
  requires: string;
  mode: string;
  isBuiltin: boolean;
  installed: boolean;
  templateEnabled: boolean;
  state: AgentState;
  stateReason: string;
  /** 自主型：能用的工具（名 + 人话名 + 会不会花钱/改数据/签合约）；流水线型为空 */
  tools: { name: string; label: string; write: boolean; costly: boolean; contract: boolean }[];
  /** 流水线型：步骤的人话名；自主型为空 */
  stepLabels: string[];
  callBudget: number | null;
  defaultAuthMode: string | null;
  live: OverviewRun[];
  recent: OverviewRun[];
  stat7: RunStat;
  stat30: RunStat;
  /** 列表（最近执行 / 产物）只取了前 N 条；成功率与成本用的是全量计数，不受截断影响 */
  listTruncated: boolean;
  /** 近 30 天名下自主执行的账。流水线步骤的调用没有 runId 归因，不在里面（界面要说清） */
  cost30: CallSummary;
  costAttributableRuns: number;
  schedules: { id: string; when: string; enabled: boolean; failStreak: number; autoPaused: boolean; lastStatus: string | null; lastError: string | null; lastRunAt: string | null }[];
  presets: { id: string; title: string; enabled: boolean; authMode: string }[];
  channels: { id: string; provider: string; label: string; enabled: boolean }[];
  artifacts: { kind: string; kindLabel: string; label: string; href: string; at: string }[];
  lastError: { text: string; at: string; href: string } | null;
};

const DAY = 24 * 60 * 60_000;

/**
 * 一个模板的档案。模板不属于这个租户返回 null。
 */
export async function agentOverview(tenantId: string, workspaceId: string, templateId: string, now = new Date()): Promise<AgentOverviewView | null> {
  const tpl = await prisma.workflowTemplate.findFirst({
    where: { id: templateId, OR: [{ isBuiltin: true }, { tenantId }] },
  });
  if (!tpl) return null;
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since7 = new Date(now.getTime() - 7 * DAY);

  const [install, agentRuns, workflowRuns, presets, channels] = await Promise.all([
    prisma.workflowInstall.findUnique({ where: { tenantId_templateId: { tenantId, templateId } }, select: { enabled: true } }),
    prisma.agentRun.findMany({
      where: { workspaceId, agentTemplateId: templateId, OR: [{ createdAt: { gte: since30 } }, { status: { in: [...LIVE_STATUSES] } }] },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: { id: true, goal: true, status: true, origin: true, error: true, createdAt: true, updatedAt: true },
    }),
    prisma.workflowRun.findMany({
      where: { workspaceId, templateId, OR: [{ createdAt: { gte: since30 } }, { status: 'running' }] },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: { id: true, status: true, trigger: true, error: true, createdAt: true, updatedAt: true },
    }),
    prisma.taskPreset.findMany({ where: { workspaceId, agentTemplateId: templateId }, select: { id: true, title: true, enabled: true, authMode: true } }),
    prisma.botIntegration.findMany({ where: { workspaceId, agentTemplateId: templateId }, select: { id: true, provider: true, label: true, enabled: true } }),
  ]);

  const presetIds = presets.map((p) => p.id);
  const [schedules, artifacts, cost30] = await Promise.all([
    prisma.scheduledAgent.findMany({
      where: { workspaceId, OR: [{ templateId }, ...(presetIds.length ? [{ taskPresetId: { in: presetIds } }] : [])] },
      orderBy: [{ atHour: 'asc' }, { atMinute: 'asc' }],
    }),
    agentRuns.length
      ? prisma.agentArtifact.findMany({
        where: { runId: { in: agentRuns.map((r) => r.id) } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { kind: true, refId: true, label: true, createdAt: true },
      })
      : Promise.resolve([]),
    runsEconomics(agentRuns.filter((r) => r.createdAt >= since30).map((r) => r.id)),
  ]);
  // 成功率按数据库计数算（不受上面 take 200 截断）：AgentRun + WorkflowRun 各按状态分组
  const countBy = async (since: Date) => {
    const [a, w] = await Promise.all([
      prisma.agentRun.groupBy({ by: ['status'], where: { workspaceId, agentTemplateId: templateId, createdAt: { gte: since }, status: { in: ['done', 'failed', 'cancelled'] } }, _count: { _all: true } }),
      prisma.workflowRun.groupBy({ by: ['status'], where: { workspaceId, templateId, createdAt: { gte: since }, status: { in: ['done', 'failed', 'cancelled'] } }, _count: { _all: true } }),
    ]);
    const rows: { status: string }[] = [];
    for (const g of [...a, ...w]) for (let i = 0; i < g._count._all; i += 1) rows.push({ status: g.status });
    return statOf(rows);
  };
  const [stat7, stat30] = await Promise.all([countBy(since7), countBy(since30)]);

  const runs: (OverviewRun & { createdAt: Date; updatedAt: Date })[] = [
    ...agentRuns.map((r) => ({
      id: r.id, kind: 'agent' as const, title: r.goal, status: r.status, origin: r.origin,
      at: r.updatedAt.toISOString(), error: r.error, href: `/assistant?run=${r.id}`,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
    ...workflowRuns.map((r) => ({
      id: r.id, kind: 'workflow' as const, title: `${tpl.emoji} ${tpl.name}`, status: r.status, origin: r.trigger,
      at: r.updatedAt.toISOString(), error: r.error, href: '/runs',
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })),
  ].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const liveSet = new Set<string>([...LIVE_STATUSES, 'running']);
  const live = runs.filter((r) => liveSet.has(r.status));
  const finished = runs.filter((r) => !liveSet.has(r.status));
  const brokenSchedules = schedules.filter((s) => s.failStreak >= 2 || (!s.enabled && s.failStreak >= AUTO_PAUSE_FAILS)).length;
  const installed = !!install?.enabled;
  const { state, reason } = deriveAgentState({
    installed,
    templateEnabled: tpl.enabled,
    liveStatuses: live.map((r) => r.status),
    lastFinished: finished[0] ? { status: finished[0].status, error: finished[0].error } : null,
    brokenSchedules,
  });

  const cfg = isAutonomous(tpl.mode) ? parseAgentConfig(tpl.agentConfig) : null;
  const tools = (cfg?.tools ?? []).map((name) => {
    const t = toolByName(name);
    return { name, label: t?.label ?? name, write: !!t?.write, costly: !!t?.costly, contract: !!t?.contract };
  });
  const lastFailed = finished.find((r) => r.status === 'failed' && r.error);
  const brokenSchedule = schedules.find((s) => s.lastError);
  const lastError = lastFailed
    ? { text: lastFailed.error!, at: lastFailed.at, href: lastFailed.href }
    : brokenSchedule?.lastError
      ? { text: brokenSchedule.lastError, at: (brokenSchedule.lastRunAt ?? brokenSchedule.updatedAt).toISOString(), href: '/workflows#schedules' }
      : null;

  const strip = (r: OverviewRun & { createdAt: Date; updatedAt: Date }): OverviewRun => {
    const { createdAt: _c, updatedAt: _u, ...rest } = r;
    void _c; void _u;
    return rest;
  };

  return {
    id: tpl.id,
    slug: tpl.slug,
    name: tpl.name,
    emoji: tpl.emoji,
    description: tpl.description,
    persona: tpl.persona,
    requires: tpl.requires,
    mode: tpl.mode,
    isBuiltin: tpl.isBuiltin,
    installed,
    templateEnabled: tpl.enabled,
    state,
    stateReason: reason,
    tools,
    stepLabels: cfg ? [] : parseSteps(tpl.steps).map(stepLabel),
    callBudget: cfg ? (cfg.callBudget ?? null) : null,
    defaultAuthMode: cfg ? (cfg.defaultAuthMode ?? null) : null,
    live: live.map(strip),
    recent: finished.slice(0, 10).map(strip),
    stat7,
    stat30,
    listTruncated: agentRuns.length >= 200 || workflowRuns.length >= 200,
    cost30,
    costAttributableRuns: agentRuns.filter((r) => r.createdAt >= since30).length,
    schedules: schedules.map((s) => ({
      id: s.id,
      when: scheduleWhen(parseWeekdays(s.weekdays), s.atHour, s.atMinute),
      enabled: s.enabled,
      failStreak: s.failStreak,
      autoPaused: !s.enabled && s.failStreak >= AUTO_PAUSE_FAILS,
      lastStatus: s.lastStatus,
      lastError: s.lastError,
      lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    })),
    presets,
    channels,
    artifacts: artifacts.map((a) => ({
      kind: a.kind, kindLabel: artifactKindLabel(a.kind), label: a.label, href: artifactHref(a.kind, a.refId), at: a.createdAt.toISOString(),
    })),
    lastError,
  };
}

export type AgentStateLite = { state: AgentState; reason: string };

/**
 * 一批模板的状态（列表页用）。三次查询搞定，不逐个算档案。
 */
export async function agentStatesFor(
  tenantId: string,
  workspaceId: string,
  templates: readonly { id: string; installed: boolean }[],
): Promise<Record<string, AgentStateLite>> {
  const ids = templates.map((t) => t.id);
  if (ids.length === 0) return {};
  const [tplRows, liveAgent, liveWorkflow, lastAgent, schedules, presets] = await Promise.all([
    prisma.workflowTemplate.findMany({ where: { id: { in: ids } }, select: { id: true, enabled: true } }),
    prisma.agentRun.findMany({
      where: { workspaceId, agentTemplateId: { in: ids }, status: { in: [...LIVE_STATUSES] } },
      select: { agentTemplateId: true, status: true },
    }),
    prisma.workflowRun.findMany({ where: { workspaceId, templateId: { in: ids }, status: 'running' }, select: { templateId: true } }),
    // 每个模板各取最近一次已结束的执行（逐个 findFirst：模板数是个位数，比 take 50 再挑更不会漏）
    Promise.all(ids.map((id) => prisma.agentRun.findFirst({
      where: { workspaceId, agentTemplateId: id, status: { in: ['done', 'failed', 'cancelled'] } },
      orderBy: { updatedAt: 'desc' },
      select: { agentTemplateId: true, status: true, error: true },
    }))).then((rows) => rows.filter((r): r is NonNullable<typeof r> => !!r)),
    prisma.scheduledAgent.findMany({ where: { workspaceId }, select: { templateId: true, taskPresetId: true, failStreak: true, enabled: true } }),
    prisma.taskPreset.findMany({ where: { workspaceId, agentTemplateId: { in: ids } }, select: { id: true, agentTemplateId: true } }),
  ]);
  void tenantId;
  const enabledOf = new Map(tplRows.map((t) => [t.id, t.enabled]));
  const presetOwner = new Map(presets.map((p) => [p.id, p.agentTemplateId!]));
  const out: Record<string, AgentStateLite> = {};
  for (const t of templates) {
    const liveStatuses = [
      ...liveAgent.filter((r) => r.agentTemplateId === t.id).map((r) => r.status),
      ...liveWorkflow.filter((r) => r.templateId === t.id).map(() => 'running'),
    ];
    const last = lastAgent.find((r) => r.agentTemplateId === t.id) ?? null;
    const brokenSchedules = schedules.filter((s) => {
      const owner = s.templateId ?? (s.taskPresetId ? presetOwner.get(s.taskPresetId) : null);
      return owner === t.id && (s.failStreak >= 2 || (!s.enabled && s.failStreak >= AUTO_PAUSE_FAILS));
    }).length;
    out[t.id] = deriveAgentState({
      installed: t.installed,
      templateEnabled: enabledOf.get(t.id) ?? true,
      liveStatuses,
      lastFinished: last ? { status: last.status, error: last.error } : null,
      brokenSchedules,
    });
  }
  return out;
}
