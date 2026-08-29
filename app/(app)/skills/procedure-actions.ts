'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { disabledTools } from '@/lib/agent/tool-config';
import { distillProcedure, replayProcedure } from '@/lib/skill/distill';

// 流程技能的三个动作（2026-08-29）。
//
// 【为什么单独一个文件】skills/actions.ts 管的是 ContentSkill（提示词模板）那一套，
// 含市场、安装、导入。流程技能是另一类东西（做法，不是模板），混进去会让那个文件
// 的每个函数都要先判「这是哪种技能」。分开写，两边各自清楚。

export type ProcResult = { ok: boolean; error?: string; skillId?: string; runId?: string };

/** 把一次跑完的执行存成技能。 */
export async function actDistillProcedure(runId: string): Promise<ProcResult> {
  const s = await getSession();
  try {
    // 存技能会烧一次模型调用（提炼名字和说明），按创作动作管
    requireRole(s, 'content.create');
    const ctx = { tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: s.accountId, memberId: s.memberId, role: s.role };
    const r = await distillProcedure(ctx, runId);
    if (r.ok) revalidatePath('/skills');
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '存技能失败' };
  }
}

/** 用一个流程技能起一次执行。 */
export async function actRunProcedure(skillId: string): Promise<ProcResult> {
  const s = await getSession();
  try {
    requireRole(s, 'content.create');
    const ctx = { tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: s.accountId, memberId: s.memberId, role: s.role };
    const ws = await prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } });
    const r = await replayProcedure(ctx, skillId, s.role, disabledTools(ws?.agentToolConfig));
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath('/skills');
    return { ok: true, runId: r.turn?.runId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '跑技能失败' };
  }
}

/** 删掉一个流程技能。 */
export async function actDeleteProcedure(skillId: string): Promise<ProcResult> {
  const s = await getSession();
  try {
    requireRole(s, 'content.create');
    // 按 workspaceId 圈定：跨工作区删不掉（RLS 之外再加一道，删除是不可逆动作）
    const r = await prisma.procedureSkill.deleteMany({ where: { id: skillId, workspaceId: s.workspaceId } });
    if (r.count === 0) return { ok: false, error: '找不到这个技能' };
    revalidatePath('/skills');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' };
  }
}
