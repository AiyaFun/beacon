'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertNotDemo } from '@/lib/demo/guard';
import { createSchedule } from '@/lib/workflow/schedule-create';

// 定时智能体的增删改。跑的那一半在 lib/workflow/schedule.ts（worker 侧），
// **建的那一半在 lib/workflow/schedule-create.ts**——抽出去是因为 AI 也要能起草定时计划，
// 而它跑在后台、手上没有会话，调不了 server action。这里只剩会话与权限这一层。

export type ScheduleInput = {
  templateId: string;
  atHour: number;
  atMinute: number;
  weekdays: number[];
  /** 模型渠道 id：''/auto = 自动 */
  providerId?: string | null;
};

export async function actCreateSchedule(input: ScheduleInput) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  const { normalizeProviderChoice } = await import('@/lib/llm/selectable');
  const choice = await normalizeProviderChoice(s.tenantId, input.providerId);
  if (!choice.ok) return { ok: false as const, error: choice.error };

  const r = await createSchedule({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    memberId: s.memberId,
    tenantId: s.tenantId,
    templateId: input.templateId,
    atHour: input.atHour,
    atMinute: input.atMinute,
    weekdays: input.weekdays,
    providerId: choice.providerId,
  });
  if (!r.ok) return { ok: false as const, error: r.error };
  revalidatePath('/workflows');
  return { ok: true as const };
}

/** 改一条定时走哪条模型渠道（''/auto = 自动） */
export async function actSetScheduleModel(id: string, providerId: string | null) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  const { normalizeProviderChoice } = await import('@/lib/llm/selectable');
  const choice = await normalizeProviderChoice(s.tenantId, providerId);
  if (!choice.ok) return { ok: false as const, error: choice.error };
  const r = await prisma.scheduledAgent.updateMany({ where: { id, workspaceId: s.workspaceId }, data: { providerId: choice.providerId } });
  revalidatePath('/workflows');
  return r.count > 0 ? { ok: true as const } : { ok: false as const, error: '这条定时不存在' };
}

export async function actToggleSchedule(id: string, enabled: boolean) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  // 重新开启时把失败计数清零：不清的话「连续失败 3 次自动停用」会在下一次失败时立刻再停，
  // 用户根本没机会看出自己修好了没有
  const r = await prisma.scheduledAgent.updateMany({
    where: { id, workspaceId: s.workspaceId },
    data: enabled ? { enabled: true, failStreak: 0, lastError: null } : { enabled: false },
  });
  revalidatePath('/workflows');
  return { ok: r.count > 0 };
}

export async function actDeleteSchedule(id: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  // updateMany/deleteMany + workspaceId 条件：直接按 id 删会让别的工作区的计划被删掉
  const r = await prisma.scheduledAgent.deleteMany({ where: { id, workspaceId: s.workspaceId } });
  revalidatePath('/workflows');
  return { ok: r.count > 0 };
}

// ── 运营动作（2026-09-11 定时运营中心）：现在跑 / 跳过今天 ───────────────────
//
// 【为什么不另建 ScheduleException 表】「跳过今天」= 把 lastRunDay 写成今天，
// 这正是执行器判「今天跑过了」的那一列（lib/workflow/schedule.ts shouldRun）。
// 界面与执行器看同一个字段，不会出现「界面说跳过了、执行器照跑」这种双真相。

/**
 * 现在跑一次。`countsAsToday`=true 时同时把 lastRunDay 写成今天（补跑：今天到点不再跑第二次）；
 * false 时只是额外跑一次，今天到点照常跑。**由界面按实例是否已错过来定**，不让服务端猜。
 */
export async function actRunScheduleNow(id: string, countsAsToday: boolean): Promise<{ ok: true; runHref: string } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);

  const r = await prisma.scheduledAgent.findFirst({ where: { id, workspaceId: s.workspaceId } });
  if (!r) return { ok: false, error: '这条定时不存在' };
  const { beijingDayKey } = await import('@/lib/beijing');
  const today = beijingDayKey();
  if (countsAsToday && r.lastRunDay === today) return { ok: false, error: '今天已经跑过（或跳过）了，不能再算作今天这次' };

  if (r.targetKind === 'task') {
    if (!r.taskPresetId) return { ok: false, error: '这条定时没指到任何一键任务' };
    const { dispatchPreset } = await import('@/lib/agent/preset');
    const d = await dispatchPreset(
      { tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: r.accountId, memberId: s.memberId, role: s.role },
      { presetId: r.taskPresetId, origin: 'schedule', scheduledAgentId: r.id, providerIdOverride: r.providerId },
    );
    if (!d.ok) return { ok: false, error: d.error };
    // 成败由 AgentRun 到终态时回写（reportScheduleOutcome）；这里只记「派出去了」
    await prisma.scheduledAgent.update({
      where: { id: r.id },
      data: { lastRunAt: new Date(), lastStatus: 'running', lastError: null, ...(countsAsToday ? { lastRunDay: today } : {}) },
    });
    revalidatePath('/workflows');
    return { ok: true, runHref: `/assistant?run=${d.turn.runId}` };
  }

  if (!r.templateId) return { ok: false, error: '这条定时没指到任何智能体' };
  const { runWorkflow } = await import('@/lib/workflow/run');
  if (countsAsToday) {
    await prisma.scheduledAgent.update({ where: { id: r.id }, data: { lastRunDay: today, lastRunAt: new Date(), lastStatus: 'running', lastError: null } });
  }
  try {
    // trigger 记 manual：是人现在点的，不是定时器到点跑的——记录里要分得清
    const view = await runWorkflow(
      { tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: r.accountId, memberId: s.memberId, trigger: 'manual', providerId: r.providerId },
      r.templateId,
    );
    const ok = view.status === 'done';
    const bad = view.logs.find((l) => !l.ok);
    await prisma.scheduledAgent.update({
      where: { id: r.id },
      data: { lastRunAt: new Date(), lastStatus: ok ? 'done' : 'failed', lastError: ok ? null : (bad?.message ?? '未知原因').slice(0, 300) },
    });
    revalidatePath('/workflows');
    revalidatePath('/runs');
    return ok ? { ok: true, runHref: '/runs' } : { ok: false, error: `停在第 ${view.logs.length} 步：${bad?.message ?? '未知原因'}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

/** 跳过今天这一次：今天到点不跑，明天照常。 */
export async function actSkipScheduleToday(id: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  const { beijingDayKey } = await import('@/lib/beijing');
  const today = beijingDayKey();
  const r = await prisma.scheduledAgent.updateMany({
    // lastRunDay 已是今天 = 已跑或已跳过，不能把一次成功改写成「跳过」
    where: { id, workspaceId: s.workspaceId, NOT: { lastRunDay: today } },
    // 人工跳过是独立状态，不往 lastError 里塞文案（lastError 只放真错误）
    data: { lastRunDay: today, lastStatus: 'skipped_manual', lastError: null },
  });
  revalidatePath('/workflows');
  return r.count > 0 ? { ok: true as const } : { ok: false as const, error: '今天已经跑过或跳过了' };
}
