'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertNotDemo } from '@/lib/demo/guard';
import { setAiToolStatus, deleteAiTool, type AiToolStatus } from '@/lib/agent/ai-tools/store';

// AI 自写工具的审核动作（2026-09-09）。
//
// 这是 draft → enabled 唯一的通路：模型起草，人看过代码点启用。工具层没有任何路径能改状态。
// 归属按工作区；演示租户不许动（它的工具清单是示例）。

export type AiToolActionResult = { ok: boolean; error?: string };

export async function actSetAiToolStatus(id: string, status: AiToolStatus): Promise<AiToolActionResult> {
  const s = await getSession();
  try {
    assertNotDemo(s.tenantId);
    // 启用等于允许 AI 之后调用它——和「配定时 / 拼智能体」一档，按创作动作管
    requireRole(s, 'content.create');
    if (!['draft', 'enabled', 'disabled'].includes(status)) return { ok: false, error: '状态不合法' };
    const ok = await setAiToolStatus(s.workspaceId, id, status);
    if (!ok) return { ok: false, error: status === 'enabled' ? '这个版本不提供 AI 自写工具，或工具不存在' : '工具不存在' };
    revalidatePath('/skills');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '操作失败' };
  }
}

export async function actDeleteAiTool(id: string): Promise<AiToolActionResult> {
  const s = await getSession();
  try {
    assertNotDemo(s.tenantId);
    requireRole(s, 'content.create');
    const ok = await deleteAiTool(s.workspaceId, id);
    if (!ok) return { ok: false, error: '工具不存在' };
    revalidatePath('/skills');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' };
  }
}
