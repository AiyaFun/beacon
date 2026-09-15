import { prisma } from '../db';
import { createLogger } from '../logger';
import type { WorkflowContext } from './run';

const log = createLogger({ module: 'workflow-resume' });

// ── 接力续跑：子运行到终态 → 找回正等它的流水线 → 从同一步接着跑 ────────────────
//
// 入口两个：① lib/agent/run.ts 的终态钩子（正常路径，秒级）；② lib/agent/tick.ts 巡检（钩子漏了兜底）。
// 上下文从 WorkflowRun 行重建（tenant 由工作区反查、发起人从 memberId 列、模型渠道从 providerId 列），
// 不依赖派出时的任何进程内对象——这正是它能跨部署重启的原因。

export async function contextForWorkflowRun(runId: string): Promise<WorkflowContext | null> {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!run) return null;
  const ws = await prisma.workspace.findUnique({ where: { id: run.workspaceId }, select: { tenantId: true } });
  if (!ws) return null;
  let memberId = run.memberId;
  if (!memberId) {
    // 老行没记发起人：按租户 owner 跑（权限只可能更宽，而 bot 白名单本身就是收窄的）
    const owner = await prisma.member.findFirst({ where: { tenantId: ws.tenantId, role: 'owner' }, select: { id: true } });
    memberId = owner?.id ?? null;
  }
  if (!memberId) return null;
  return { tenantId: ws.tenantId, workspaceId: run.workspaceId, accountId: run.accountId, memberId, draftId: run.draftId, trigger: run.trigger as WorkflowContext['trigger'], providerId: run.providerId };
}

/** 子运行 childRunId 到终态了：有流水线在等它就叫起来接着跑。返回是否叫到了。 */
export async function resumeWorkflowAfterChild(childRunId: string): Promise<boolean> {
  const token = `run:${childRunId}`;
  const waiting = await prisma.workflowRun.findFirst({ where: { waitingOn: token, status: 'running' }, select: { id: true } });
  if (!waiting) return false;
  const ctx = await contextForWorkflowRun(waiting.id);
  if (!ctx) {
    await prisma.workflowRun.updateMany({ where: { id: waiting.id, status: 'running' }, data: { status: 'failed', waitingOn: null, error: '接力续跑时找不到发起人或工作区，已如实标记失败' } });
    return false;
  }
  const { kickWorkflowRun } = await import('./kick');
  kickWorkflowRun(ctx, waiting.id, { childRunId });
  log.info('接力子运行到终态，流水线续跑', { workflowRunId: waiting.id, childRunId });
  return true;
}
