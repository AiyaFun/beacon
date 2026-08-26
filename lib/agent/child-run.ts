import { prisma } from '../db';
import { toJson, parseJson } from '../json';
import { createLogger } from '../logger';
import { runWaitToken } from './wake';
import { capAuthMode, capPreauthorized, resolveAgentTools, type AgentConfig } from './autonomous';
import { toolsFor } from './tool-config';
import type { ToolContext, ToolResult, AuthMode } from './tools';

const log = createLogger({ module: 'agent-child' });

// ── 派一个自主智能体 = 起一次子运行 ──────────────────────────────────────────
//
// 流水线型智能体展开的是一串定死的步骤；自主型没有步骤可展开——它本身就是
// 另一条「模型想 → 调工具 → 再想」的循环。所以派它 = **起第二次 AgentRun**，
// 父运行挂起等它（`run:<childId>` 令牌，叫醒机制与等工作流完全一样）。
//
// 【三条硬规则，每一条都是「不拦就有洞」】
//   ① 白名单 = 父 ∩ 子智能体能用的     —— 不然是一条洗白名单的三步链路
//   ② 授权档继承但不得超过父           —— 不然「派个智能体」成了绕过自己确认闸的捷径
//   ③ 嵌套只许一层                     —— 不然一个配错的智能体能自己派自己，指数级烧额度

export type StartChildInput = {
  templateId: string;
  templateName: string;
  config: AgentConfig;
  goal: string;
};

export async function startChildRun(ctx: ToolContext, input: StartChildInput): Promise<ToolResult> {
  if (!ctx.runId) {
    // 没有「我是谁」就没法定授权上界，也没法挂起等它——这种情况只可能是
    // 有人在 AI 执行之外直接调了这个工具。宁可拒绝，不要用一个猜的上界去起子运行。
    return { ok: false, error: '这个动作只能在一次 AI 执行里用', summary: '没有执行上下文' };
  }

  const parent = await prisma.agentRun.findUnique({
    where: { id: ctx.runId },
    select: {
      id: true, workspaceId: true, accountId: true, memberId: true,
      authMode: true, preauthorizedTools: true, parentRunId: true, callBudget: true,
    },
  });
  if (!parent) return { ok: false, error: '找不到当前这次执行', summary: '上下文丢了' };

  // 规则③：我自己就是子运行的话，不许再往下派
  if (parent.parentRunId) {
    return {
      ok: false,
      error: '这次任务本身就是别的智能体派出来的，不能再往下派一层。要做的话请直接自己做，或者告诉用户分两次来。',
      summary: '嵌套只许一层',
    };
  }

  // 这个用户自己有权用的工具（角色 ∩ 工作区开关）——**上界永远是它**
  const ws = await prisma.workspace.findUnique({
    where: { id: ctx.workspaceId },
    select: { agentToolConfig: true },
  });
  const { disabledTools } = await import('./tool-config');
  const allowed = toolsFor(ctx.role, disabledTools(ws?.agentToolConfig)).map((t) => t.name);

  // 规则①：白名单取交集，绝不按子模板重新全勾
  const childTools = resolveAgentTools(input.config, allowed);
  if (childTools.length === 0) {
    return {
      ok: false,
      error: `「${input.templateName}」要用的工具你都没有权限用（或被工作区关掉了），派不动它`,
      summary: '这个智能体在你的权限下没有可用工具',
    };
  }
  const parentPre = parseJson<string[]>(parent.preauthorizedTools, []);

  // 规则②：授权档不得超过父
  const childAuth: AuthMode = capAuthMode(parent.authMode, input.config.defaultAuthMode);
  const childPre = childAuth === 'preauthorized' ? capPreauthorized(parentPre, childTools) : [];

  const { startAgentRun } = await import('./run');
  const child = await startAgentRun(
    {
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      memberId: ctx.memberId,
      role: ctx.role,
    },
    input.goal,
    {
      // origin 跟着父走的语义：它不是用户在页面上派的，但确认仍然归发起人
      origin: 'manual',
      authMode: childAuth,
      preauthorizedTools: childPre,
      callBudget: input.config.callBudget,
      parentRunId: parent.id,
      agentTemplateId: input.templateId,
      agentSystemPrompt: input.config.systemPrompt,
      toolAllowlist: childTools,
    },
  );

  log.info('派出子运行', {
    parentRunId: parent.id, childRunId: child.runId,
    template: input.templateName, authMode: childAuth, tools: childTools.length,
  });

  return {
    ok: true,
    waitFor: runWaitToken(child.runId),
    data: { childRunId: child.runId, tools: childTools.length },
    summary: `已经把这件事交给「${input.templateName}」，它正在跑（跑完会自动接着做）`,
  };
}

/** 子运行到终态时叫醒父运行。挂在状态迁移那个咽喉上（lib/agent/run.ts 的 afterTransition）。 */
export async function wakeParentIfChild(runId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { parentRunId: true, status: true, answer: true, error: true },
  });
  if (!run?.parentRunId) return;

  const { wakeRunsWaitingOn } = await import('./wake');
  const ok = run.status === 'done';
  await wakeRunsWaitingOn(runWaitToken(runId), {
    ok,
    summary: ok
      ? (run.answer || '子任务已经跑完了')
      : (run.error || (run.status === 'cancelled' ? '子任务被终止了' : '子任务没跑成')),
    data: { childRunId: runId, status: run.status },
  });
}

export { toJson };
