import { prisma } from '../db';
import { parseJson } from '../json';
import { createLogger } from '../logger';
import { parseAgentConfig, resolveAgentTools, isAutonomous, capAuthMode } from './autonomous';
import { toolsFor, disabledTools } from './tool-config';
import type { ToolContext, AuthMode } from './tools';
import type { AgentTurn } from './run';

const log = createLogger({ module: 'agent-preset' });

// ── 一键任务：预先设定好的「目标 + 让谁干 + 授权到什么程度」──────────────────
//
// 【为什么需要它】派活现在要打一段字、选一个智能体、勾一次授权范围——
// 而绝大多数人反复要的就是那么三五件事。每次重打一遍不只是麻烦：
// **授权范围每次都要重勾，勾错了没人拦得住**。存成一张卡，点一下就派。
//
// 它同时是定时的载体：到点了派一条预设任务，就是「无人值守的 Codex 式任务」。

export type DispatchPresetInput = {
  presetId: string;
  /** 谁触发的。schedule 那种才允许无人值守（人不在跟前才有那个必要） */
  origin: 'preset' | 'schedule';
  /** 定时派的话记下是哪一条——连败自停闸靠它回写 */
  scheduledAgentId?: string;
  /** 临时改一下这次的目标（页面上点卡片时可以改，定时不给改） */
  goalOverride?: string;
};

export type DispatchResult =
  | { ok: true; turn: AgentTurn }
  | { ok: false; error: string };

/**
 * 派一条预设任务。
 *
 * 【授权怎么定】卡上存的那份是**上界**，但仍然要过 startAgentRun 里那几道闸：
 *   · 无人值守只有定时/预设能用（页面上点的那一下人就在跟前，没有理由不问他）；
 *   · 自主智能体的工具白名单与用户自己的权限求交集。
 * 卡是「用户当时定好的」，不是「绕过检查的通行证」。
 */
export async function dispatchPreset(ctx: ToolContext, input: DispatchPresetInput): Promise<DispatchResult> {
  const preset = await prisma.taskPreset.findFirst({
    where: { id: input.presetId, workspaceId: ctx.workspaceId },
  });
  if (!preset) return { ok: false, error: '这条一键任务不存在或不属于当前工作区' };
  if (!preset.enabled) return { ok: false, error: '这条一键任务已经停用了' };

  const goal = (input.goalOverride ?? preset.goal).trim();
  if (!goal) return { ok: false, error: '这条一键任务没写要做什么' };

  // 指了智能体的话，把它的配置取出来
  let agentSystemPrompt: string | undefined;
  let toolAllowlist: string[] | undefined;
  let callBudget: number | undefined;
  let authMode = preset.authMode as AuthMode;

  if (preset.agentTemplateId) {
    const tpl = await prisma.workflowTemplate.findFirst({
      where: {
        id: preset.agentTemplateId, enabled: true,
        OR: [{ isBuiltin: true }, { tenantId: ctx.tenantId }],
      },
      select: { id: true, name: true, mode: true, agentConfig: true },
    });
    // 智能体被删/停用了：**如实报错而不是悄悄退回通用助手**——
    // 用户配这张卡时选的就是那个智能体，换一个来跑不是他要的
    if (!tpl) return { ok: false, error: '这条一键任务指定的智能体已经不在了，去改一下这张卡' };

    if (isAutonomous(tpl.mode)) {
      const cfg = parseAgentConfig(tpl.agentConfig);
      const ws = await prisma.workspace.findUnique({
        where: { id: ctx.workspaceId }, select: { agentToolConfig: true },
      });
      const allowed = toolsFor(ctx.role, disabledTools(ws?.agentToolConfig)).map((t) => t.name);
      const tools = resolveAgentTools(cfg, allowed);
      if (tools.length === 0) {
        return { ok: false, error: `「${tpl.name}」要用的工具你都没有权限用（或被工作区关掉了）` };
      }
      agentSystemPrompt = cfg.systemPrompt || undefined;
      toolAllowlist = tools;
      callBudget = cfg.callBudget;
      // 卡上那份与智能体自己那份，取**更严的**
      authMode = capAuthMode(preset.authMode, cfg.defaultAuthMode ?? preset.authMode);
    }
    // 流水线型的智能体：这里不展开它的步骤，让模型自己去 run_agent
    //（那条路已经有完整的挂起/叫醒机制，不必再造一遍）
  }

  const { startAgentRun } = await import('./run');
  const turn = await startAgentRun(ctx, goal, {
    origin: input.origin,
    authMode,
    preauthorizedTools: parseJson<string[]>(preset.preauthorizedTools, []),
    callBudget,
    agentTemplateId: preset.agentTemplateId ?? undefined,
    agentSystemPrompt,
    toolAllowlist,
    scheduledAgentId: input.scheduledAgentId,
  });

  log.info('派出一键任务', {
    presetId: preset.id, runId: turn.runId, origin: input.origin, authMode,
  });
  return { ok: true, turn };
}

/**
 * 定时派出去的运行到终态了：回写那条定时的成败。
 *
 * 【为什么必须在这里做】连败自停闸原来靠 `await runWorkflow` 的同步返回值记账——
 * 而派一条 AI 执行是异步的，派发那一刻它还没跑。照抄旧写法的话 failStreak 永远不累加，
 * **一条配坏的定时会每天准点烧配额且永不自动停用**（那正是这道闸存在的理由）。
 *
 * 挂在状态迁移那个咽喉上（lib/agent/run.ts 的 afterTransition），所以不会漏。
 */
export async function reportScheduleOutcome(runId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { scheduledAgentId: true, status: true, error: true },
  });
  if (!run?.scheduledAgentId) return;

  const ok = run.status === 'done';
  // 【额度用完不算「坏」】与流水线那边同一个口径：配额超限是「今天没轮到」，
  // 不是「这条计划配错了」。累加 failStreak 会把一条好计划在三个额度紧张的日子后停掉。
  const quotaSkipped = !ok && /额度|配额/.test(run.error ?? '');

  const sa = await prisma.scheduledAgent.findUnique({
    where: { id: run.scheduledAgentId },
    select: { id: true, failStreak: true, workspaceId: true, accountId: true },
  });
  if (!sa) return;

  await prisma.scheduledAgent.update({
    where: { id: sa.id },
    data: {
      lastStatus: ok ? 'done' : quotaSkipped ? 'skipped' : 'failed',
      lastError: ok ? null : (run.error ?? '没跑成').slice(0, 300),
      failStreak: ok || quotaSkipped ? 0 : sa.failStreak + 1,
    },
  });

  if (!ok && !quotaSkipped) {
    const { autoPauseIfBroken } = await import('../workflow/schedule');
    // 连败够数就停用并告警——**与流水线那边共用同一个函数**，
    // 两条路径各写一份判定迟早会有一边的阈值忘了改
    await autoPauseIfBroken(
      { id: sa.id, workspaceId: sa.workspaceId, accountId: sa.accountId },
      sa.failStreak + 1,
    ).catch(() => {});
  }
}
