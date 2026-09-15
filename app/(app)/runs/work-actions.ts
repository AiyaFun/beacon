'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertNotDemo } from '@/lib/demo/guard';
import { createWorkItem, advanceWorkItem, acceptWorkItem, rejectWorkItem, cancelWorkItem, linkWorkItem, attachRun, syncFromRuns, getWorkItem } from '@/lib/workitem/core';
import { parseAgentConfig, isAutonomous, resolveAgentTools } from '@/lib/agent/autonomous';
import { toolsFor, disabledTools } from '@/lib/agent/tool-config';

// 内容工单的动作层（2026-09-11 P1）。流程规则在 lib/workitem/core.ts，这里只管会话与权限。

type R = { ok: boolean; error?: string };

async function guard() {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  return s;
}

export async function actCreateWorkItem(input: { title: string; accountId: string; agentTemplateId?: string | null; dueAt?: string | null; inputs?: string; acceptance?: string; draftId?: string | null }): Promise<R & { id?: string }> {
  const s = await guard();
  const r = await createWorkItem(s.workspaceId, s.memberId, {
    title: input.title, accountId: input.accountId, agentTemplateId: input.agentTemplateId ?? null,
    dueAt: input.dueAt ? new Date(input.dueAt) : null, inputs: input.inputs, acceptance: input.acceptance, draftId: input.draftId ?? null,
  });
  revalidatePath('/runs');
  return r;
}

export async function actAdvanceWorkItem(id: string, to: string): Promise<R> {
  const s = await guard();
  const r = await advanceWorkItem(s.workspaceId, id, s.memberId, to);
  revalidatePath('/runs');
  return r;
}

export async function actAcceptWorkItem(id: string, note = ''): Promise<R> {
  const s = await guard();
  const r = await acceptWorkItem(s.workspaceId, id, s.memberId, note);
  revalidatePath('/runs');
  return r;
}

export async function actRejectWorkItem(id: string, reason: string): Promise<R> {
  const s = await guard();
  const r = await rejectWorkItem(s.workspaceId, id, s.memberId, reason);
  revalidatePath('/runs');
  return r;
}

export async function actCancelWorkItem(id: string): Promise<R> {
  const s = await guard();
  const r = await cancelWorkItem(s.workspaceId, id, s.memberId);
  revalidatePath('/runs');
  return r;
}

export async function actLinkWorkItem(id: string, kind: 'draft' | 'publish_record', refId: string): Promise<R> {
  const s = await guard();
  const r = await linkWorkItem(s.workspaceId, id, s.memberId, { kind, refId });
  revalidatePath('/runs');
  return r;
}

/** 从运行产物把草稿/发布计划挂上来（只补空位） */
export async function actSyncWorkItem(id: string): Promise<R> {
  const s = await guard();
  await syncFromRuns(s.workspaceId, id);
  revalidatePath('/runs');
  return { ok: true };
}

/**
 * 把这单派给它的数字员工跑一次。目标 = 标题 + 输入 + 验收标准；产物跑完后由 sync 挂回来。
 * 派的是自主型模板：白名单与发起人权限求交集（只收窄）；授权档走缺省。
 */
export async function actDispatchWorkItem(id: string): Promise<R & { runHref?: string }> {
  const s = await guard();
  const item = await getWorkItem(s.workspaceId, id);
  if (!item) return { ok: false, error: '工单不存在' };
  if (!item.agentTemplateId) return { ok: false, error: '这单没指定数字员工，先在工单上选一个' };
  if (item.status !== 'open') return { ok: false, error: '这单已经关了' };
  const tpl = await prisma.workflowTemplate.findFirst({ where: { id: item.agentTemplateId, enabled: true, OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] } });
  if (!tpl) return { ok: false, error: '数字员工不存在或已停用' };
  if (!isAutonomous(tpl.mode)) return { ok: false, error: '这个员工是流水线型：去「技能 · 连接器」页点它的「跑一遍」' };
  const cfg = parseAgentConfig(tpl.agentConfig);
  const ws = await prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } });
  const allowlist = resolveAgentTools(cfg, toolsFor(s.role, disabledTools(ws?.agentToolConfig)).map((t) => t.name));
  const goal = [
    `【内容工单】${item.title}`,
    item.inputs ? `输入：${item.inputs}` : '',
    item.acceptance ? `验收标准：${item.acceptance}` : '',
    item.draftId ? `已有草稿 id=${item.draftId}（用 read_draft 读，在它基础上改，不要另起炉灶）` : '',
    item.rejectReason ? `上次驳回原因：${item.rejectReason}（这次要改掉）` : '',
    `当前阶段：${item.stage}。做完后把结果写成一段可验收的说明。`,
  ].filter(Boolean).join('\n');
  const { startAgentRun } = await import('@/lib/agent/run');
  try {
    const turn = await startAgentRun(
      { tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: item.accountId, memberId: s.memberId, role: s.role },
      goal,
      { origin: 'manual', agentTemplateId: tpl.id, agentSystemPrompt: cfg.systemPrompt, toolAllowlist: allowlist, callBudget: cfg.callBudget, authMode: cfg.defaultAuthMode },
    );
    await attachRun(s.workspaceId, id, turn.runId, s.memberId);
    // 还在候选选题阶段就派了活：自动进「起稿」，起稿是它接下来要做的事
    if (item.stage === 'topic') await advanceWorkItem(s.workspaceId, id, s.memberId, 'drafting');
    revalidatePath('/runs');
    return { ok: true, runHref: `/assistant?run=${turn.runId}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}
