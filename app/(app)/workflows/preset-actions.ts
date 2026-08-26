'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';
import { DemoReadonlyError } from '@/lib/demo/guard';
import { dispatchPreset } from '@/lib/agent/preset';
import { toJson } from '@/lib/json';
import type { AgentTurn } from '@/lib/agent/run';

// 一键任务的增删改与派发。
//
// 【为什么不做成新页面】零新路由：它挂在 /workflows 的 #presets 锚点区块里。
// 定时也在那一页——「配一次、以后一键或到点自动跑」本来就是同一件事的两种触发。

function designed(e: unknown): string | null {
  if (e instanceof QuotaExceededError || e instanceof RbacError || e instanceof DemoReadonlyError) return e.message;
  return null;
}

export type PresetResult = { ok: boolean; error?: string; turn?: AgentTurn; id?: string };

export async function actSavePreset(input: {
  id?: string;
  title: string;
  goal: string;
  agentTemplateId?: string | null;
  authMode: string;
  preauthorizedTools: string[];
}): Promise<PresetResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');

    const title = input.title.trim().slice(0, 60);
    const goal = input.goal.trim().slice(0, 2000);
    if (!title) return { ok: false, error: '给这张卡起个名字' };
    if (!goal) return { ok: false, error: '写清楚要它做什么' };

    // 【无人值守不能从这里配】它只对挂了定时的才有意义（人不在跟前）。
    // 页面上点一下的时候人就在跟前，没有理由不问他——
    // 真要无人值守，去给这张卡挂一条定时（那边会按 origin='schedule' 放行）。
    const authMode = input.authMode === 'preauthorized' ? 'preauthorized' : 'confirm_each';
    const tools = authMode === 'preauthorized' ? [...new Set(input.preauthorizedTools)] : [];

    // 指定的智能体必须是这个租户看得见的（内置或自建）
    if (input.agentTemplateId) {
      const owned = await prisma.workflowTemplate.count({
        where: { id: input.agentTemplateId, OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] },
      });
      if (!owned) return { ok: false, error: '选的那个智能体不存在' };
    }

    const data = {
      title,
      goal,
      agentTemplateId: input.agentTemplateId || null,
      authMode,
      preauthorizedTools: toJson(tools),
    };

    if (input.id) {
      // 归属校验：id 是客户端给的
      const owned = await prisma.taskPreset.count({ where: { id: input.id, workspaceId: s.workspaceId } });
      if (!owned) return { ok: false, error: '这张卡不存在或不属于当前工作区' };
      await prisma.taskPreset.update({ where: { id: input.id }, data });
      revalidatePath('/workflows');
      revalidatePath('/');
      return { ok: true, id: input.id };
    }

    const created = await prisma.taskPreset.create({
      data: { ...data, tenantId: s.tenantId, workspaceId: s.workspaceId, createdBy: s.memberId },
    });
    revalidatePath('/workflows');
    revalidatePath('/');
    return { ok: true, id: created.id };
  } catch (e) {
    const msg = designed(e);
    return { ok: false, error: msg ?? (e as Error).message.slice(0, 300) };
  }
}

export async function actTogglePreset(id: string, enabled: boolean): Promise<PresetResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const r = await prisma.taskPreset.updateMany({ where: { id, workspaceId: s.workspaceId }, data: { enabled } });
    if (r.count === 0) return { ok: false, error: '这张卡不存在或不属于当前工作区' };
    revalidatePath('/workflows');
    revalidatePath('/');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: designed(e) ?? (e as Error).message.slice(0, 300) };
  }
}

export async function actDeletePreset(id: string): Promise<PresetResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const r = await prisma.taskPreset.deleteMany({ where: { id, workspaceId: s.workspaceId } });
    if (r.count === 0) return { ok: false, error: '这张卡不存在或不属于当前工作区' };
    // 指着它的定时会在下次到点时如实报错并累加连败——**刻意不在这里连带删定时**：
    // 用户删的是卡，不是那条定时；悄悄把定时也删了他不会知道
    revalidatePath('/workflows');
    revalidatePath('/');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: designed(e) ?? (e as Error).message.slice(0, 300) };
  }
}

/** 点一下卡片就派出去。goalOverride 允许当场改一改这次要做什么。 */
export async function actDispatchPreset(id: string, goalOverride?: string): Promise<PresetResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const r = await dispatchPreset(
      {
        tenantId: s.tenantId,
        workspaceId: s.workspaceId,
        accountId: s.accountId,
        memberId: s.memberId,
        role: s.role,
      },
      { presetId: id, origin: 'preset', goalOverride },
    );
    if (!r.ok) return { ok: false, error: r.error };
    revalidatePath('/');
    return { ok: true, turn: r.turn };
  } catch (e) {
    return { ok: false, error: designed(e) ?? (e as Error).message.slice(0, 300) };
  }
}
