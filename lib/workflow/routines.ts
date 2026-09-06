import { prisma } from '../db';
import { parseAgentConfig, type BotRoutine } from '../agent/autonomous';
import { createSchedule } from './schedule-create';

// ── bot 的建议定时（2026-09-05，Grok Bot 的 Routines）────────────────────────
//
// 职能 bot 的模板里可以带几条「建议定时」（agentConfig.routines）。它们**默认关**：
// 装 bot 的时候页面问一次「要不要每天 8 点跑」，用户点了才真的建——
// 一张一键任务卡（TaskPreset，目标句 + 指定这个 bot）+ 一条指向它的定时（ScheduledAgent）。
// 不问就装等于替用户决定每天花一次额度；只建议不建等于功能不存在。
//
// 【幂等】同一条建议再开一次不会多出第二张卡、第二条定时：按「模板 + 标题」认卡，
// 按「卡 + 启用中」认定时。用户在定时页停掉之后再点「开启」会重新启用那条，不新建。

export type RoutineState = Record<string, number[]>;

export type RoutineView = BotRoutine & { index: number; enabled: boolean };

/** 每个模板哪几条建议定时已经在跑（给市场页画「已定时」/「开启」用）。 */
export async function enabledRoutines(workspaceId: string, templates: { id: string; agentConfig: string | null }[]): Promise<RoutineState> {
  const withRoutines = templates
    .map((t) => ({ id: t.id, routines: parseAgentConfig(t.agentConfig).routines ?? [] }))
    .filter((t) => t.routines.length > 0);
  if (withRoutines.length === 0) return {};
  const presets = await prisma.taskPreset.findMany({
    where: { workspaceId, agentTemplateId: { in: withRoutines.map((t) => t.id) } },
    select: { id: true, title: true, agentTemplateId: true },
  });
  if (presets.length === 0) return {};
  const live = await prisma.scheduledAgent.findMany({
    where: { workspaceId, targetKind: 'task', enabled: true, taskPresetId: { in: presets.map((p) => p.id) } },
    select: { taskPresetId: true },
  });
  const livePresets = new Set(live.map((l) => l.taskPresetId));
  const out: RoutineState = {};
  for (const t of withRoutines) {
    const on = t.routines
      .map((r, i) => (presets.some((p) => p.agentTemplateId === t.id && p.title === r.title && livePresets.has(p.id)) ? i : -1))
      .filter((i) => i >= 0);
    if (on.length) out[t.id] = on;
  }
  return out;
}

export type EnableRoutineInput = {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberId: string;
  templateId: string;
  index: number;
};

export async function enableRoutine(input: EnableRoutineInput): Promise<{ ok: true; presetId: string; scheduleId: string } | { ok: false; error: string }> {
  const t = await prisma.workflowTemplate.findFirst({
    where: { id: input.templateId, enabled: true, OR: [{ isBuiltin: true }, { tenantId: input.tenantId }] },
    select: { id: true, isBuiltin: true, agentConfig: true, mode: true },
  });
  if (!t) return { ok: false, error: '这个智能体不存在' };
  if (t.mode !== 'autonomous') return { ok: false, error: '只有职能型 bot 带建议定时' };
  // 内置的要先装上：没装的 bot 对 AI 不存在，到点派给它会撞「未安装」
  if (t.isBuiltin) {
    const inst = await prisma.workflowInstall.findFirst({ where: { tenantId: input.tenantId, templateId: t.id, enabled: true }, select: { id: true } });
    if (!inst) return { ok: false, error: '先把这个 bot 装上，再开它的定时' };
  }
  const cfg = parseAgentConfig(t.agentConfig);
  const routine = (cfg.routines ?? [])[input.index];
  if (!routine) return { ok: false, error: '这条建议定时不存在' };

  // 认卡：模板 + 标题
  let preset = await prisma.taskPreset.findFirst({
    where: { workspaceId: input.workspaceId, agentTemplateId: t.id, title: routine.title },
    select: { id: true },
  });
  if (!preset) {
    preset = await prisma.taskPreset.create({
      data: {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        title: routine.title,
        goal: routine.goal,
        agentTemplateId: t.id,
        // 到点没人在跟前，逐步确认等于永远卡在第一步；bot 自己的缺省档（发布官是 confirm_each）仍由
        // dispatchPreset 的 capAuthMode 收紧，这里不会放宽它
        authMode: cfg.defaultAuthMode ?? 'unattended',
        preauthorizedTools: '[]',
        createdBy: input.memberId,
      },
      select: { id: true },
    });
  } else {
    await prisma.taskPreset.update({ where: { id: preset.id }, data: { enabled: true } });
  }

  // 认定时：卡 + 任意状态。停掉的重新启用，别再建一条
  const existing = await prisma.scheduledAgent.findFirst({
    where: { workspaceId: input.workspaceId, targetKind: 'task', taskPresetId: preset.id },
    select: { id: true, enabled: true },
  });
  if (existing) {
    if (!existing.enabled) await prisma.scheduledAgent.update({ where: { id: existing.id }, data: { enabled: true, failStreak: 0 } });
    return { ok: true, presetId: preset.id, scheduleId: existing.id };
  }
  const r = await createSchedule({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    memberId: input.memberId,
    targetKind: 'task',
    taskPresetId: preset.id,
    atHour: routine.atHour,
    atMinute: 0,
    weekdays: routine.weekdays ?? [],
  });
  if (!r.ok) return r;
  return { ok: true, presetId: preset.id, scheduleId: r.id };
}
