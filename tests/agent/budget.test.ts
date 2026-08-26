import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 批 2 的钱袋守卫。
//
// 【为什么预算的单位必须是「模型调用次数」而不是「轮数」】
// 轮数只数模型说了几次话，而**一次工具调用内部可能自己调十几次模型**：
// run_advisor 是十几席专家各一次、generate_topics 是八条选题各精排一次。
// 按轮数封顶等于没有封顶——24 轮 × 每轮 5 个工具 × 每个十几次 ≈ 三千次调用，
// 而 free 档一天总共 30 次。一个人的一次任务能把全团队当天的额度吃干。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  calls: [] as { tools: { name: string }[] }[],
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, _m: unknown, opts?: { tools?: { name: string }[] }) => {
    h.calls.push({ tools: opts?.tools ?? [] });
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { PER_RUN_TOOL_CAP, toolCapReason, callsUsed, budgetForTenant } = await import('@/lib/agent/budget');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
const call = (name: string, args: unknown, id = 'c1') => ({ id, name, arguments: JSON.stringify(args) });

beforeEach(async () => {
  h.script = [];
  h.calls = [];
  await prisma.llmCallLog.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.draft.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

/** 伪造「这次执行已经烧了 n 次调用」（真实链路由 gateway 记账，这里被 mock 掉了） */
async function burn(runId: string, n: number) {
  await prisma.llmCallLog.createMany({
    data: Array.from({ length: n }, () => ({
      tenantId: ctx.tenantId, fn: 'chat', runId, provider: 'p', model: 'm', mocked: false,
    })),
  });
}

describe('总预算数的是调用次数，不是轮数', () => {
  it('账本里属于这次执行的调用数就是用量', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    await burn(turn.runId, 7);
    expect(await callsUsed(turn.runId)).toBe(7);
    // 别的执行的调用不算在我头上
    const other = await startAgentRun(ctx, '另一个');
    await settleAgentKicks();
    await burn(other.runId, 3);
    expect(await callsUsed(turn.runId)).toBe(7);
  });

  it('Mock 调用不计入用量（它不花钱）', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    await prisma.llmCallLog.create({
      data: { tenantId: ctx.tenantId, fn: 'chat', runId: turn.runId, provider: 'mock', model: 'mock', mocked: true },
    });
    expect(await callsUsed(turn.runId)).toBe(0);
  });

  it('预算按套餐分档，档位查不到时落到最保守的那档', async () => {
    const paid = await budgetForTenant(ctx.tenantId); // personal
    const freeTenant = await prisma.tenant.create({ data: { name: 'F', plan: 'free' } });
    const free = await budgetForTenant(freeTenant.id);
    expect(paid).toBeGreaterThan(free);
    expect(await budgetForTenant('不存在的租户')).toBe(free);
  });

  // 【核心行为】烧到预算就走收尾轮：不再给工具，让它说清做到哪儿了，如实判 failed。
  it('调用数到顶时强制收尾：不再给工具、如实判没做完、但带上阶段性成果', async () => {
    const turn = await startAgentRun(ctx, '干很多活');
    await settleAgentKicks();

    // 把这次执行的预算烧光，然后再踢一脚让它接着跑
    const row = await prisma.agentRun.findUnique({ where: { id: turn.runId }, select: { callBudget: true } });
    await burn(turn.runId, row!.callBudget);
    await prisma.agentRun.update({ where: { id: turn.runId }, data: { status: 'running', answer: null, error: null } });

    h.calls = [];
    h.script = [{ text: '我查了三样数据，还没来得及写稿。' }];
    const { kickAgentRun } = await import('@/lib/agent/kick');
    kickAgentRun(turn.runId);
    await settleAgentKicks();

    const view = await getAgentRunView(ctx, turn.runId);
    expect(view.status).toBe('failed');
    expect(view.answer, '收尾那段话要带给用户').toContain('还没来得及');
    expect(view.error, '要说清是额度用完了，不是别的错').toMatch(/额度|上限/);
    expect(h.calls[0]?.tools.length, '收尾轮不许再带工具').toBe(0);
  });
});

describe('单个工具在一次任务里的次数上限', () => {
  // 总预算拦得住「烧了多少」，拦不住「一步烧完」：一次 run_advisor 是 12–16 次调用，
  // 模型连开三场会诊就把 free 档的预算清空，而用户要的只是一篇稿子。
  it('会诊、选题推荐这类高扇出的工具都有单次上限', () => {
    expect(PER_RUN_TOOL_CAP.run_advisor).toBe(1);
    expect(PER_RUN_TOOL_CAP.generate_topics).toBeLessThanOrEqual(2);
    expect(PER_RUN_TOOL_CAP.run_agent).toBeDefined();
  });

  it('没到上限放行，到了就给一句模型能懂的拒绝理由', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();

    expect(await toolCapReason(turn.runId, 'run_advisor')).toBeNull();

    // 【记账认 tool_call 不认 tool_result】一次**挂起类**调用（派子运行、派活给插件）
    // 会写两条 tool_result——挂起时一条、被叫醒补结果时又一条。按 tool_result 数的话
    // run_agent 的上限 2 实际只有 1，用户只派过一次却被告知「已经用过 2 次」。
    // tool_call 每次真实调用恰好一条，普通路径与确认路径都一样。
    //
    // 【按生产里的真实次序摆】主循环是「先写 tool_call 流水（时间线要看得见模型想干什么）
    // → 再问这道闸」，所以 toolCapReason 看到的计数**含本次**，判据是 used > cap。
    // 少摆一条「本次」的话，这条用例就在验一个生产里不存在的状态。
    const cap = PER_RUN_TOOL_CAP.run_advisor;
    for (let i = 0; i < cap; i++) {
      await prisma.agentStep.create({
        data: { runId: turn.runId, seq: 90 + i, kind: 'tool_call', tool: 'run_advisor', args: '{}' },
      });
      expect(await toolCapReason(turn.runId, 'run_advisor'), `第 ${i + 1} 次没到上限，不该拦`).toBeNull();
    }
    await prisma.agentStep.create({
      data: { runId: turn.runId, seq: 99, kind: 'tool_call', tool: 'run_advisor', args: '{}' },
    });
    const reason = await toolCapReason(turn.runId, 'run_advisor');
    expect(reason, `第 ${cap + 1} 次必须拦住`).toBeTruthy();
    expect(reason, '要告诉模型「别再调了」，而不是像临时故障').toMatch(/上限|不能再调/);
  });

  it('没有列上限的工具不限次（总预算兜底）', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    for (let i = 0; i < 5; i++) {
      await prisma.agentStep.create({
        data: { runId: turn.runId, seq: 200 + i, kind: 'tool_result', tool: 'list_topics', args: '{}', result: 'ok', ok: true },
      });
    }
    expect(await toolCapReason(turn.runId, 'list_topics')).toBeNull();
  });

  // 【端到端】模型连着两次派同一个高扇出工具，第二次必须被挡下来，
  // 且**如实回灌给模型**而不是抛错——抛错会让它以为是临时故障再重试一遍，
  // 那是白白多烧一次。
  it('端到端：超过上限的那次调用会被挡下，且如实告诉模型', async () => {
    // 【为什么先手工造流水，而不是让模型真的连调三次】
    // run_advisor / generate_topics 这些高扇出工具**内部自己也调模型**，
    // 而模型在这个测试里是一段剧本——它们会把剧本提前吃掉，后面的轮次就对不上了。
    // 要验的是「闸挡不挡得住」，所以直接把「已经调过 N 次」这个前提摆好。
    const turn = await startAgentRun(ctx, '开个会诊', {
      authMode: 'preauthorized',
      preauthorizedTools: ['run_advisor'],
    });
    await settleAgentKicks();

    // 造出「这次任务里 run_advisor 已经用过一次」（它的上限就是 1）。
    // 摆的是 tool_call：闸按它记账（见上一条用例里的理由），而且**本次调用的
    // tool_call 在闸之前就落流水**，所以判据是 used > cap 而不是 >=。
    await prisma.agentStep.create({
      data: { runId: turn.runId, seq: 50, kind: 'tool_call', tool: 'run_advisor', args: '{}' },
    });

    h.calls = [];
    h.script = [
      { toolCalls: [call('run_advisor', { topic: '再开一场' }, 'a2')] },
      { text: '不能再开会诊了，我用上一场的结论给你建议。' },
    ];
    await prisma.agentRun.update({ where: { id: turn.runId }, data: { status: 'running', answer: null, error: null } });
    const { kickAgentRun } = await import('@/lib/agent/kick');
    kickAgentRun(turn.runId);
    await settleAgentKicks();

    const view = await getAgentRunView(ctx, turn.runId);
    const capped = view.steps.filter((s) => s.kind === 'tool_result' && !s.ok && /上限/.test(s.result));
    expect(capped.length, '超过上限的那次没有被挡下来').toBeGreaterThanOrEqual(1);
    // 被挡下**不该让整次执行失败**：如实回灌给模型，它换个做法接着跑。
    // 抛错的话它会以为是临时故障再重试一遍——那是白白多烧一次。
    expect(view.status).toBe('done');
    expect(view.answer).toContain('不能再开会诊');
  }, 20_000);
});
