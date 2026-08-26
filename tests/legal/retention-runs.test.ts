import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { sweepRetention, RUN_LOG_RETENTION_DAYS } from '@/lib/legal/retention';

// 运行记录的到期清理。
//
// 【为什么要有清理】AgentRun 存整段对话（含工具返回）、AgentStep 一步一行、WorkflowRun 存每步日志，
// 三张表此前**没有任何清理路径**。手动跑的时候增长温和；加了定时智能体之后
// 一个工作区每天能自动产生 5 条，一年一千八百多条，而且没人会回头看半年前的。
//
// 【这份用例真正防的是「删多了」】保留期清理是不可逆的批量删除，
// 删错一条用户永远拿不回来。所以两个方向都要钉：该删的删掉、**不该删的一条都不许动**。

const DAY = 86_400_000;
let wsId = '';
let accId = '';
let tplId = '';

const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  wsId = ws.id;
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: wsId, name: 'a', platform: 'x' } });
  accId = acc.id;
  const tpl = await prisma.workflowTemplate.create({
    data: { slug: `t-${wsId}`, name: 'tpl', steps: '[]', isBuiltin: false, tenantId: tenant.id },
  });
  tplId = tpl.id;
});

/** updatedAt 是 @updatedAt，create 时给不了——建完再用 updateMany 压回去 */
async function agentRun(status: string, daysAgo: number) {
  const r = await prisma.agentRun.create({
    data: { workspaceId: wsId, memberId: 'm1', goal: 'g', status, messages: '[]' },
  });
  await prisma.agentRun.updateMany({ where: { id: r.id }, data: { updatedAt: ago(daysAgo) } });
  return r.id;
}

async function workflowRun(status: string, daysAgo: number) {
  const r = await prisma.workflowRun.create({
    data: { workspaceId: wsId, accountId: accId, templateId: tplId, status },
  });
  await prisma.workflowRun.updateMany({ where: { id: r.id }, data: { updatedAt: ago(daysAgo) } });
  return r.id;
}

describe('运行记录到期清理', () => {
  it('过了保留期的已结束运行会被删掉', async () => {
    const oldDone = await agentRun('done', RUN_LOG_RETENTION_DAYS + 5);
    const oldFailed = await workflowRun('failed', RUN_LOG_RETENTION_DAYS + 5);

    const r = await sweepRetention();
    expect(r.runLogs.agentRuns).toBe(1);
    expect(r.runLogs.workflowRuns).toBe(1);
    expect(await prisma.agentRun.findUnique({ where: { id: oldDone } })).toBeNull();
    expect(await prisma.workflowRun.findUnique({ where: { id: oldFailed } })).toBeNull();
  });

  it('保留期内的一条都不许动', async () => {
    const fresh = await agentRun('done', 3);
    const freshWf = await workflowRun('done', 3);

    const r = await sweepRetention();
    expect(r.runLogs.agentRuns).toBe(0);
    expect(r.runLogs.workflowRuns).toBe(0);
    expect(await prisma.agentRun.findUnique({ where: { id: fresh } })).not.toBeNull();
    expect(await prisma.workflowRun.findUnique({ where: { id: freshWf } })).not.toBeNull();
  });

  it('还没结束的不许按时间删——那会把一个活着的会话从中间截断', async () => {
    // awaiting_confirm = 模型停下来等用户点确认。用户隔了很久回来点，仍然要能接着走
    const waiting = await agentRun('awaiting_confirm', RUN_LOG_RETENTION_DAYS + 30);
    const running = await agentRun('running', RUN_LOG_RETENTION_DAYS + 30);
    const wfRunning = await workflowRun('running', RUN_LOG_RETENTION_DAYS + 30);

    const r = await sweepRetention();
    expect(r.runLogs.agentRuns).toBe(0);
    expect(r.runLogs.workflowRuns).toBe(0);
    expect(await prisma.agentRun.findUnique({ where: { id: waiting } })).not.toBeNull();
    expect(await prisma.agentRun.findUnique({ where: { id: running } })).not.toBeNull();
    expect(await prisma.workflowRun.findUnique({ where: { id: wfRunning } })).not.toBeNull();
  });

  it('AgentStep 随 AgentRun 级联删除，不留孤儿行', async () => {
    const runId = await agentRun('done', RUN_LOG_RETENTION_DAYS + 5);
    await prisma.agentStep.create({ data: { runId, seq: 1, kind: 'tool_call', tool: 'list_topics' } });
    expect(await prisma.agentStep.count({ where: { runId } })).toBe(1);

    await sweepRetention();
    expect(await prisma.agentStep.count({ where: { runId } })).toBe(0);
  });

  it('保留期是个有限正数（写成 0 会当天就删光，写成 Infinity 等于没清理）', () => {
    expect(RUN_LOG_RETENTION_DAYS).toBeGreaterThan(7);
    expect(RUN_LOG_RETENTION_DAYS).toBeLessThanOrEqual(400);
  });
});
