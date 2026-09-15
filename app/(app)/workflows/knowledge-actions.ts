'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertNotDemo } from '@/lib/demo/guard';
import { prisma } from '@/lib/db';
import { bindKnowledge, setBindingEnabled, removeBinding, isKnowledgeSourceType } from '@/lib/agent/knowledge';

// 员工知识绑定的动作层（2026-09-11 P1）。范围声明只能由有内容权限的人改；演示租户只读。

export async function actBindKnowledge(templateId: string, input: { sourceType: string; sourceId: string; purpose?: string; priority?: number }) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  if (!isKnowledgeSourceType(input.sourceType)) return { ok: false as const, error: '来源类型不合法' };
  // 模板得是这个租户看得见的（内置或自建）
  const tpl = await prisma.workflowTemplate.findFirst({ where: { id: templateId, OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] }, select: { id: true } });
  if (!tpl) return { ok: false as const, error: '这个智能体不存在' };
  const r = await bindKnowledge(s.workspaceId, templateId, s.memberId, { sourceType: input.sourceType, sourceId: input.sourceId, purpose: input.purpose, priority: input.priority });
  if (!r.ok) return r;
  revalidatePath('/workflows');
  return { ok: true as const, id: r.id };
}

export async function actSetBindingEnabled(id: string, enabled: boolean) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  const ok = await setBindingEnabled(s.workspaceId, id, enabled);
  revalidatePath('/workflows');
  return ok ? { ok: true as const } : { ok: false as const, error: '这条绑定不存在' };
}

export async function actRemoveBinding(id: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  const ok = await removeBinding(s.workspaceId, id);
  revalidatePath('/workflows');
  return ok ? { ok: true as const } : { ok: false as const, error: '这条绑定不存在' };
}
