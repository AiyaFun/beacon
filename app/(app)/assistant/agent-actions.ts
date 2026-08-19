'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';
import { DemoReadonlyError } from '@/lib/demo/guard';
import {
  startAgentRun,
  decidePendingCall,
  cancelAgentRun,
  getAgentRunView,
  availableTools,
  type AgentTurn,
} from '@/lib/agent/run';
import type { ToolContext } from '@/lib/agent/tools';

// 执行模式（AI 直接操作系统）的 server action 层。
// 与 actAsk 同一套「按设计拒绝」口径：配额/权限/演示只读这三类错误结构化返回，
// 不裸抛给 Next 的 error boundary（生产会把 message 脱敏成通用英文串，自救指引全丢）。

export type AgentResult = { ok: boolean; turn?: AgentTurn; error?: string };

async function ctxOf(): Promise<ToolContext> {
  const s = await getSession();
  requireRole(s, 'content.create'); // 执行模式会烧 token 并改数据，按创作动作管
  return {
    tenantId: s.tenantId,
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    memberId: s.memberId,
    role: s.role,
  };
}

function designed(e: unknown): string | null {
  if (e instanceof QuotaExceededError || e instanceof RbacError || e instanceof DemoReadonlyError) return e.message;
  return null;
}

export async function actStartAgent(goal: string): Promise<AgentResult> {
  try {
    const ctx = await ctxOf();
    const turn = await startAgentRun(ctx, goal);
    revalidatePath('/assistant');
    return { ok: true, turn };
  } catch (e) {
    const msg = designed(e);
    if (msg) return { ok: false, error: msg };
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

export async function actDecideAgentStep(runId: string, approve: boolean): Promise<AgentResult> {
  try {
    const ctx = await ctxOf();
    const turn = await decidePendingCall(ctx, runId, approve);
    revalidatePath('/assistant');
    return { ok: true, turn };
  } catch (e) {
    const msg = designed(e);
    if (msg) return { ok: false, error: msg };
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

export async function actCancelAgent(runId: string): Promise<AgentResult> {
  try {
    const ctx = await ctxOf();
    return { ok: true, turn: await cancelAgentRun(ctx, runId) };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

export async function actGetAgentRun(runId: string): Promise<AgentResult> {
  try {
    const ctx = await ctxOf();
    return { ok: true, turn: await getAgentRunView(ctx, runId) };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

export async function actListAgentTools() {
  const s = await getSession();
  return availableTools(s.role);
}
