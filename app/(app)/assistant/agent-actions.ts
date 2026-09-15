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
  appendUserNote,
  type AgentTurn,
} from '@/lib/agent/run';
import type { ToolContext } from '@/lib/agent/tools';
import type { DispatchAuthValue } from '@/components/DispatchAuth';

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

export async function actStartAgent(goal: string, auth?: DispatchAuthValue, modelId?: string): Promise<AgentResult> {
  try {
    const ctx = await ctxOf();
    // 按任务选模型：界面上挑的那条渠道跟这句话一起送过来；归属按租户校验
    const { normalizeProviderChoice } = await import('@/lib/llm/selectable');
    const choice = await normalizeProviderChoice(ctx.tenantId, modelId);
    if (!choice.ok) return { ok: false, error: choice.error };
    // 【授权只认这一下点击】origin 写死 'manual'：这个 action 是**页面上的派发**，
    // 客户端传不了别的来源。缺省「直接跑完」（DEFAULT_AUTH），用户在派发卡上改成
    // 「每一步先问我」或勾一批预授权时才收紧——三档之外的值一律按缺省。
    const mode = auth?.authMode === 'preauthorized' || auth?.authMode === 'confirm_each' ? auth.authMode : 'unattended';
    const turn = await startAgentRun(ctx, goal, {
      origin: 'manual',
      authMode: mode,
      preauthorizedTools: mode === 'preauthorized' ? (auth?.preauthorizedTools ?? []) : [],
      providerId: choice.providerId,
    });
    revalidatePath('/assistant');
    return { ok: true, turn };
  } catch (e) {
    const msg = designed(e);
    if (msg) return { ok: false, error: msg };
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

/**
 * 跑着跑着（或跑完之后）再说一句话。
 *
 * 还在跑 → 记下来，下一轮它就读到了；已经结束 → **同一条运行接着跑**
 *（不新开一条：新的那条不知道前面查过什么、建过什么，用户说「刚才那篇标题再改改」
 * 它只能从头再查一遍）。归属与「只有发起人能追问」由 appendUserNote 在服务端判。
 */
export async function actAppendNote(runId: string, text: string): Promise<AgentResult> {
  try {
    const ctx = await ctxOf();
    const turn = await appendUserNote(ctx, runId, text);
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

