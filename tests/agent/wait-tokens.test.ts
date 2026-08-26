import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 批 4-A：挂起令牌从「只能等浏览器插件」泛化成三种。
//
// 【这一片全是「不报错、只是永远醒不来」的失败形态】
//   · 先跑后挂 → 叫醒发生时没人在等，那条运行永久挂着
//   · 自愈只认 browser: → 另外两种错过一次实时叫醒就没救了
//   · 没有到期兜底 → 被等的那件事崩了，挂起会一直占着一个并发名额
// 三条都不会红、不会 404，只会让用户看到一条不动的任务。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  calls: 0,
}));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    h.calls++;
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView, transition } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const {
  browserWaitToken, workflowWaitToken, runWaitToken, settleIfResolved, WAIT_TTL_MS,
} = await import('@/lib/agent/wake');
const { tickAgentRuns } = await import('@/lib/agent/tick');
const { settleWorkflowKicks } = await import('@/lib/workflow/kick');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

// 后台任务的收尾统一在 tests/setup/per-file.ts 的 afterEach 里做（新文件不会忘了收）

beforeEach(async () => {
  h.script = []; h.calls = 0;
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.workflowRun.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  await prisma.notification.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

/** 造一条挂在某个令牌上的运行（省掉真的跑一遍） */
async function parked(token: string, waitingSince?: Date) {
  const run = await prisma.agentRun.create({
    data: {
      workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
      goal: '挂着等', status: 'waiting_browser', waitingOn: token,
      pending: JSON.stringify({ id: 'c1', name: 'run_agent', arguments: '{}' }),
      messages: JSON.stringify([{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_agent', arguments: '{}' }] }]),
    },
  });
  if (waitingSince) await prisma.agentRun.update({ where: { id: run.id }, data: { updatedAt: waitingSince } });
  return run.id;
}

async function makeWorkflowRun(status: string, error?: string) {
  const tpl = await prisma.workflowTemplate.create({
    data: { tenantId: ctx.tenantId, slug: `t-${Math.round(performance.now() * 1000)}`, name: '测试模板', emoji: '🤖', steps: '[]' },
  });
  return prisma.workflowRun.create({
    data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, templateId: tpl.id, status, error: error ?? null },
  });
}

describe('令牌格式统一在一处拼', () => {
  it('三种令牌各有各的前缀', () => {
    expect(browserWaitToken('a')).toBe('browser:a');
    expect(workflowWaitToken('b')).toBe('workflow:b');
    expect(runWaitToken('c')).toBe('run:c');
  });
});

describe('自愈：等工作流', () => {
  it('它已经跑完了 → 叫醒并带上结果', async () => {
    const wf = await makeWorkflowRun('done');
    const runId = await parked(workflowWaitToken(wf.id));
    h.script = [{ text: '智能体跑完了，我接着说' }];

    expect(await settleIfResolved(workflowWaitToken(wf.id))).toBe(true);
    await settleAgentKicks();
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('done');
  });

  it('它失败了 → 如实叫醒（不是把父运行也判死）', async () => {
    const wf = await makeWorkflowRun('failed', '第 2 步没过：没配生图渠道');
    const runId = await parked(workflowWaitToken(wf.id));
    h.script = [{ text: '那一步没成，我换个说法告诉你' }];

    expect(await settleIfResolved(workflowWaitToken(wf.id))).toBe(true);
    await settleAgentKicks();
    const row = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(row?.status, '被等的那件事失败了，父运行该接着推理而不是跟着死').toBe('done');
    const step = await prisma.agentStep.findFirst({ where: { runId, kind: 'tool_result' } });
    expect(step?.result).toContain('没配生图渠道');
  });

  it('记录被清理掉了 → 也要叫醒（等下去没有意义）', async () => {
    const token = workflowWaitToken('已经不存在的id');
    const runId = await parked(token);
    h.script = [{ text: '拿不到结果' }];
    expect(await settleIfResolved(token)).toBe(true);
    await settleAgentKicks();
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('done');
  });

  it('还在跑 → 什么都不做（别把没结果的当失败）', async () => {
    const wf = await makeWorkflowRun('running');
    await parked(workflowWaitToken(wf.id));
    expect(await settleIfResolved(workflowWaitToken(wf.id))).toBe(false);
  });
});

describe('自愈：等子运行', () => {
  async function makeChild(status: string, patch: Record<string, unknown> = {}) {
    return prisma.agentRun.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
        goal: '子任务', status, messages: '[]', ...patch,
      },
    });
  }

  it('子任务跑完 → 把它的回答交给父运行', async () => {
    const child = await makeChild('done', { answer: '子任务的结论是 A' });
    const parentId = await parked(runWaitToken(child.id));
    h.script = [{ text: '综合子任务的结论' }];

    expect(await settleIfResolved(runWaitToken(child.id))).toBe(true);
    await settleAgentKicks();
    const step = await prisma.agentStep.findFirst({ where: { runId: parentId, kind: 'tool_result' } });
    expect(step?.result).toContain('子任务的结论是 A');
  });

  // 【这条守的是「直接取消子运行」】用户在运行中心把子任务终止了，
  // 父运行还挂在那儿等——不叫醒它就是一条永久僵尸。
  it('子任务被终止 → 父运行也要被叫醒', async () => {
    const child = await makeChild('cancelled');
    const parentId = await parked(runWaitToken(child.id));
    h.script = [{ text: '那我不等了' }];

    expect(await settleIfResolved(runWaitToken(child.id))).toBe(true);
    await settleAgentKicks();
    const row = await prisma.agentRun.findUnique({ where: { id: parentId } });
    expect(row?.status).toBe('done');
    const step = await prisma.agentStep.findFirst({ where: { runId: parentId, kind: 'tool_result' } });
    expect(step?.result).toContain('终止');
  });

  it('子任务失败 → 如实交回失败原因', async () => {
    const child = await makeChild('failed', { error: '子任务撞上了额度上限' });
    const parentId = await parked(runWaitToken(child.id));
    h.script = [{ text: '子任务没成' }];
    await settleIfResolved(runWaitToken(child.id));
    await settleAgentKicks();
    const step = await prisma.agentStep.findFirst({ where: { runId: parentId, kind: 'tool_result' } });
    expect(step?.result).toContain('额度上限');
  });
});

describe('到期兜底：等不到就如实收尾', () => {
  // 【没有这一步的后果】被等的那件事崩了（worker 被杀、部署重启），父运行永久挂着——
  // 提拔只在终态发生、到期清理只删终态、读路径自愈也救不了它，
  // 于是它一直占着这个工作区的一个并发名额。三条挂死就把整个工作区堵住。
  it('等超过一天 → 判它等不到了，叫醒收尾', async () => {
    const wf = await makeWorkflowRun('running'); // 永远跑不完的那种
    const token = workflowWaitToken(wf.id);
    const long = new Date(Date.now() - WAIT_TTL_MS - 60_000);
    const runId = await parked(token, long);
    h.script = [{ text: '等太久了，我先给你现有的结论' }];

    expect(await settleIfResolved(token, long)).toBe(true);
    await settleAgentKicks();
    const row = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(row?.status).toBe('done');
    const step = await prisma.agentStep.findFirst({ where: { runId, kind: 'tool_result' } });
    expect(step?.result).toContain('太久');
  });

  it('还没到一天 → 接着等（别把慢当成死）', async () => {
    const wf = await makeWorkflowRun('running');
    const token = workflowWaitToken(wf.id);
    const recent = new Date(Date.now() - 60_000);
    await parked(token, recent);
    expect(await settleIfResolved(token, recent)).toBe(false);
  });

  it('不知道等了多久就不判死（宁可多等，也不能凭空收尾）', async () => {
    const wf = await makeWorkflowRun('running');
    const token = workflowWaitToken(wf.id);
    await parked(token);
    expect(await settleIfResolved(token, null)).toBe(false);
  });

  it('定时巡检会扫挂太久的（不能只靠有人打开页面）', async () => {
    const wf = await makeWorkflowRun('running');
    const token = workflowWaitToken(wf.id);
    const long = new Date(Date.now() - WAIT_TTL_MS - 60_000);
    const runId = await parked(token, long);
    h.script = [{ text: '收尾' }];

    const r = await tickAgentRuns();
    await settleAgentKicks();
    expect(r.settled).toBeGreaterThanOrEqual(1);
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).not.toBe('waiting_browser');
  });
});

describe('先建行再挂起：竞态下也救得回来', () => {
  // 【为什么这个竞态在新的两种令牌上是常态】browser 那种要等用户开浏览器（以小时计），
  // 挂起早就完成了；而工作流/子运行可能**秒级跑完**——叫醒发生时 park 还没写完。
  // 这时实时叫醒扑空，全靠自愈补一刀。
  it('叫醒发生在挂起之前（跑得太快），自愈仍能救活', async () => {
    const wf = await makeWorkflowRun('done'); // 已经跑完了，叫醒早就扑过空
    const token = workflowWaitToken(wf.id);
    const runId = await parked(token); // 现在才挂上去
    h.script = [{ text: '拿到结果了' }];

    // 用户打开页面（读路径自愈）
    const view = await getAgentRunView(ctx, runId);
    await settleAgentKicks();
    expect(view.status === 'waiting_browser' || view.status === 'running' || view.status === 'done').toBe(true);
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('done');
  });
});

describe('挂起时界面上说的话要对得上在等什么', () => {
  // 三种等待里用户该做的事完全不同：等插件要去开浏览器，另外两种什么都不用做。
  // 全印成「等你的浏览器插件」的话，等智能体的人会跑去开浏览器，而那件事跟浏览器无关。
  it('等工作流 / 等子运行 / 等插件，各说各的', async () => {
    const wf = await makeWorkflowRun('running');
    const a = await parked(workflowWaitToken(wf.id));
    expect((await getAgentRunView(ctx, a)).waitingFor).toContain('智能体');

    const child = await prisma.agentRun.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId, goal: '子', status: 'running', messages: '[]' },
    });
    const b = await parked(runWaitToken(child.id));
    expect((await getAgentRunView(ctx, b)).waitingFor).toContain('子任务');

    const c = await parked(browserWaitToken('nonexistent-but-parked'));
    // browser 那条会被自愈判成「任务不在了」并叫醒，所以只验文案分支本身
    const view = await getAgentRunView(ctx, c);
    await settleAgentKicks();
    expect(view.waitingFor === undefined || view.waitingFor.includes('插件')).toBe(true);
  });
});

describe('端到端：派一个智能体 → 挂起 → 它跑完 → 自动接着做', () => {
  // 【这一组补的是「只测纯函数」的漏洞】上面那些用例都是手工造出挂起状态再调自愈，
  // 于是「run_agent 到底挂没挂起」「工作流跑完到底叫没叫醒」这两件事一条都没验到——
  // mutation 把它们各自改坏，用例照样全绿。
  async function realTemplate() {
    return prisma.workflowTemplate.create({
      data: {
        tenantId: ctx.tenantId, slug: `e2e-${Math.round(performance.now() * 1000)}`,
        name: '端到端模板', emoji: '🤖', enabled: true,
        // analyze 步不调模型也不写业务表，跑得动且没有副作用
        steps: JSON.stringify([{ kind: 'analyze', target: 'performance' }]),
      },
    });
  }

  // 【为什么直接验工具的返回值，而不是「跑一遍看它停在 waiting_browser」】
  // 那个挂起是**中间状态**：测试里的工作流几乎瞬间跑完，settleAgentKicks 之后
  // 它早就被叫醒、接着跑完了——断言中间态会变成一条跟时序赛跑的用例。
  // 而「有没有交回一个等待令牌」才是「不再同步跑完」这件事的本质，且与时序无关。
  it('run_agent 交回的是等待令牌，不再把整次执行钉住几十分钟', async () => {
    const tpl = await realTemplate();
    const { toolByName } = await import('@/lib/agent/tools');
    const r = await toolByName('run_agent')!.run(ctx, { agent_id: tpl.id });
    await settleWorkflowKicks();

    expect(r.ok).toBe(true);
    expect(r.waitFor, 'run_agent 没有交回等待令牌（多半又变回同步跑完了）').toMatch(/^workflow:/);
    expect(r.summary).toContain('正在跑');
    // 那条工作流记录真的建出来了（令牌指向的是一条存在的运行）
    const wfRunId = r.waitFor!.slice('workflow:'.length);
    expect(await prisma.workflowRun.count({ where: { id: wfRunId } })).toBe(1);
  });

  it('挂在工作流上时，界面说的是「等智能体」而不是「等浏览器插件」', async () => {
    const wf = await makeWorkflowRun('running');
    const runId = await parked(workflowWaitToken(wf.id));
    expect((await getAgentRunView(ctx, runId)).waitingFor).toContain('智能体');
  });

  it('那条工作流跑完时会主动叫醒挂着的执行', async () => {
    const tpl = await realTemplate();
    const { createWorkflowRun, executeWorkflowRun } = await import('@/lib/workflow/run');
    const wfCtx = {
      tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, accountId: ctx.accountId,
      memberId: ctx.memberId, draftId: null, trigger: 'agent' as const,
    };
    // 先建行、再挂起——次序反了（先跑后挂）就是这套机制最容易犯的错
    const wfRunId = await createWorkflowRun(wfCtx, tpl.id);
    const parentId = await parked(workflowWaitToken(wfRunId));

    h.script = [{ text: '智能体跑完了，我接着说' }];
    await executeWorkflowRun(wfCtx, wfRunId);
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: parentId } });
    expect(row?.status, '工作流跑完了却没人叫醒挂着的那条').toBe('done');
    expect(row?.waitingOn, '醒来之后要把等待令牌清掉').toBeNull();
  });

  it('读路径自愈会带上「等了多久」，所以打开页面就能收掉挂死的', async () => {
    const wf = await makeWorkflowRun('running'); // 永远跑不完
    const long = new Date(Date.now() - WAIT_TTL_MS - 60_000);
    const runId = await parked(workflowWaitToken(wf.id), long);
    h.script = [{ text: '等太久了，先收尾' }];

    // 【只走 getAgentRunView】不直接调 settleIfResolved——要验的正是
    // 「读路径有没有把 updatedAt 传下去」，不传的话到期判定永远不成立
    await getAgentRunView(ctx, runId);
    await settleAgentKicks();

    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status,
      '打开页面也收不掉挂死的运行（多半是自愈没传「等了多久」）').toBe('done');
  });
});
