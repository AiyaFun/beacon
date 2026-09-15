import { prisma } from '../db';
import { parseAgentConfig, isAutonomous, resolveAgentTools } from '../agent/autonomous';
import { toolsFor, disabledTools } from '../agent/tool-config';
import { runEconomics } from '../agent/economics';
import type { WorkflowContext } from './run';
import type { WorkflowStep, HandoffDeliverable } from './steps';

// ── 固定角色接力（2026-09-11 P2；同日审计后改成**持久等待**）────────────────────
//
// 【为什么不在进程里轮询】第一版在 Web/worker 进程里每 4 秒查一次子运行、最长等 60 分钟：
// 进程一重启（每次部署都会），等待就丢了——子运行照跑，父流水线永远停在那一步，
// 巡检两小时后把它判成「跑飞」。这不是可以默认开放的接力。
// 现在：这一跳只负责**派出**子运行并返回 wait 令牌；流水线把 `waitingOn = run:<id>` 写进 WorkflowRun
// 就退出；子运行到终态由 lib/agent/run.ts 的终态钩子叫醒（lib/workflow/resume.ts），
// 从同一步接着跑；漏叫醒和超时由 lib/agent/tick.ts 巡检兜底。等待跨进程、跨部署都成立。
//
// 硬规则不变：子运行只嵌一层（bot 白名单里没有 run_agent）；权限只收窄；上一跳没交出合格产物
// 下一跳不启动；每跳成本写进步骤消息；bot 停在等确认不替用户点头（流水线一直等到他点）。

type HandoffStep = Extract<WorkflowStep, { kind: 'handoff' }>;

export type HandoffStart = { ok: true; wait: string; message: string } | { ok: false; message: string };
export type HandoffOutcome = { ok: boolean; message: string; runId?: string; draftId?: string | null; brief?: { title: string; text: string } };

/** 上一跳的交付拼进这一跳的目标：模型只看得到这段文字，不会自己去翻上一跳的对话。 */
export function composeHandoffGoal(step: { goal: string }, prev: { draftId: string | null; briefs: { title: string; text: string }[] }): string {
  const parts = [step.goal.trim()];
  if (prev.draftId) parts.push(`【上一跳交付的草稿】id=${prev.draftId}（用 read_draft 读它，在它基础上做，不要另起炉灶）`);
  const last = prev.briefs[prev.briefs.length - 1];
  if (last) parts.push(`【上一跳交付的内容】${last.title}\n${last.text.slice(0, 3000)}`);
  parts.push('【交付要求】做完后把结果写成一段可直接交给下一位同事的结构化说明。');
  return parts.join('\n\n').slice(0, 6000);
}

/** 这一跳交出的东西合不合格。**纯函数**，用例直接测。 */
export function deliverableSatisfied(
  want: HandoffDeliverable,
  run: { status: string; answer: string | null },
  artifacts: readonly { kind: string; refId: string }[],
): { ok: boolean; why: string; draftId?: string } {
  if (run.status !== 'done') return { ok: false, why: `这一跳没跑完（${run.status}）` };
  if (want === 'answer') return (run.answer ?? '').trim().length >= 20 ? { ok: true, why: '' } : { ok: false, why: '这一跳没有交出可用的说明（回答太短或为空）' };
  const kinds = want === 'draft' ? ['draft', 'draft_version'] : [want];
  const hit = artifacts.find((a) => kinds.includes(a.kind));
  if (!hit) return { ok: false, why: `这一跳没有登记「${want}」类产物，下一跳不启动` };
  return { ok: true, why: '', ...(want === 'draft' ? { draftId: hit.refId } : {}) };
}

/** 派出这一跳的子运行。不等它——返回 wait 令牌由流水线持久化。 */
export async function startHandoffStep(ctx: WorkflowContext, step: HandoffStep, state: { draftId: string | null; briefs: { title: string; text: string }[] }): Promise<HandoffStart> {
  const tpl = await prisma.workflowTemplate.findFirst({
    where: { slug: step.bot, enabled: true, OR: [{ isBuiltin: true }, { tenantId: ctx.tenantId }] },
    select: { id: true, name: true, mode: true, agentConfig: true },
  });
  if (!tpl) return { ok: false, message: `接力对象「${step.bot}」不存在或已停用` };
  if (!isAutonomous(tpl.mode)) return { ok: false, message: `接力对象「${tpl.name}」不是自主型智能体，接不了活` };
  const [member, ws] = await Promise.all([
    prisma.member.findUnique({ where: { id: ctx.memberId }, select: { role: true } }),
    prisma.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { agentToolConfig: true } }),
  ]);
  if (!member) return { ok: false, message: '发起人已不在团队里，接力按他的权限跑不下去' };
  const cfg = parseAgentConfig(tpl.agentConfig);
  const allowed = toolsFor(member.role, disabledTools(ws?.agentToolConfig)).map((t) => t.name);
  const toolAllowlist = resolveAgentTools(cfg, allowed);
  if (toolAllowlist.length === 0) return { ok: false, message: `「${tpl.name}」在你的权限下一个工具都用不了` };

  const { startAgentRun } = await import('../agent/run');
  try {
    const turn = await startAgentRun(
      { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId, role: member.role },
      composeHandoffGoal(step, state),
      {
        origin: 'workflow',
        agentTemplateId: tpl.id,
        agentSystemPrompt: cfg.systemPrompt,
        toolAllowlist,
        callBudget: step.maxCalls ?? cfg.callBudget,
        // 后台接力没人在场：无人值守；签合约类工具照样会停下来问（机制级，见 tool-types.contract）
        authMode: 'unattended',
        providerId: ctx.providerId ?? null,
      },
    );
    return { ok: true, wait: turn.runId, message: `已派给「${tpl.name}」，等它交付（/assistant?run=${turn.runId}）` };
  } catch (err) {
    return { ok: false, message: `派不出「${tpl.name}」：${(err as Error).message.slice(0, 200)}` };
  }
}

/** 子运行到了终态：验交付、算成本、把草稿/说明交给下一跳。 */
export async function settleHandoffStep(step: HandoffStep, childRunId: string): Promise<HandoffOutcome> {
  const [run, artifacts, eco] = await Promise.all([
    prisma.agentRun.findUnique({ where: { id: childRunId }, select: { status: true, answer: true, error: true, agentTemplateId: true } }),
    prisma.agentArtifact.findMany({ where: { runId: childRunId }, select: { kind: true, refId: true, label: true } }),
    runEconomics(childRunId),
  ]);
  if (!run) return { ok: false, message: '接力的那次执行记录不见了', runId: childRunId };
  const tpl = run.agentTemplateId ? await prisma.workflowTemplate.findUnique({ where: { id: run.agentTemplateId }, select: { name: true, emoji: true } }) : null;
  const name = tpl ? `${tpl.emoji} ${tpl.name}` : step.bot;
  const cost = eco ? `${eco.calls} 次调用 · $${eco.costUsd.toFixed(4)}${eco.mockedCalls ? ` · ${eco.mockedCalls} 次落 Mock` : ''}` : '';
  const check = deliverableSatisfied(step.deliverable, { status: run.status, answer: run.answer }, artifacts);
  if (!check.ok) {
    return { ok: false, runId: childRunId, message: `${check.why}${run.error ? `：${run.error.slice(0, 160)}` : ''}（${cost}）/assistant?run=${childRunId}` };
  }
  return {
    ok: true,
    runId: childRunId,
    draftId: check.draftId ?? null,
    brief: run.answer ? { title: `${name} 的交付`, text: run.answer } : undefined,
    message: `${name} 交付了${step.deliverable === 'answer' ? '一段说明' : artifacts.map((a) => a.label).join('、') || step.deliverable}（${cost}）/assistant?run=${childRunId}`,
  };
}
