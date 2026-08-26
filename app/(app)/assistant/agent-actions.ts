'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
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
  availableTools,
  type AgentTurn,
} from '@/lib/agent/run';
import { disabledTools } from '@/lib/agent/tool-config';
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

export async function actStartAgent(goal: string, auth?: DispatchAuthValue): Promise<AgentResult> {
  try {
    const ctx = await ctxOf();
    // 【授权只认这一下点击】origin 写死 'manual'：这个 action 是**页面上的派发**，
    // 客户端传不了别的来源。无人值守档在 startAgentRun 里会被打回 confirm_each
    // （它只能由定时/预设配出来），所以这里即使被人塞一个 unattended 也没有用。
    const turn = await startAgentRun(ctx, goal, {
      origin: 'manual',
      authMode: auth?.authMode === 'preauthorized' ? 'preauthorized' : 'confirm_each',
      preauthorizedTools: auth?.preauthorizedTools ?? [],
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

export async function actListAgentTools() {
  const s = await getSession();
  // 同 /assistant 页：被工作区关掉的插件不列出来。两处都要过一遍——
  // 少过一处，用户就会在某个界面上看到一个调不动的工具
  const ws = await prisma.workspace.findUnique({
    where: { id: s.workspaceId },
    select: { agentToolConfig: true },
  });
  return availableTools(s.role, disabledTools(ws?.agentToolConfig));
}
