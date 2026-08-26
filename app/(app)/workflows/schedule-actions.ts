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
};

export async function actCreateSchedule(input: ScheduleInput) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);

  const r = await createSchedule({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    memberId: s.memberId,
    tenantId: s.tenantId,
    templateId: input.templateId,
    atHour: input.atHour,
    atMinute: input.atMinute,
    weekdays: input.weekdays,
  });
  if (!r.ok) return { ok: false as const, error: r.error };
  revalidatePath('/workflows');
  return { ok: true as const };
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
