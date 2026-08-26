import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 执行改成「后台跑 + 可挂起」之后新增的四条性质：
//   ① 开跑立刻返回，真正的推理在后台继续（关掉页面也不会掐断）
//   ② 派活给插件可以**停下来等结果**，插件回执把它叫醒接着推理
//   ③ 叫醒矩阵要全：完成/判死/过期/取消四种结局都得有人来敲门，
//      少一种就是一次永远醒不来的运行（而用户看到的是「进行中」）
//   ④ 同一次运行不许被两条线同时往前推（执行租约）
//
// 全部是行为测试：断言库里的状态与对话内容，不断言「某处调了某个函数」——
// 后者换个等价写法就假绿，而这几条恰恰是「静默失效」型的坑。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  calls: [] as { messages: { role: string; content?: unknown; toolCallId?: string }[] }[],
  slowToolMs: 0,
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: unknown[]) => {
    h.calls.push({ messages: messages as { role: string }[] });
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '',
      provider: 'scripted',
      model: 'scripted',
      mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView, decidePendingCall } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { completeTask, cancelBrowserTask, expireStaleTasks } = await import('@/lib/browser-task');
const { wakeRunsWaitingOn, browserWaitToken } = await import('@/lib/agent/wake');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
let competitorId: string;

const call = (name: string, args: unknown, id = 'c1') => ({ id, name, arguments: JSON.stringify(args) });

beforeEach(async () => {
  h.script = [];
  h.calls = [];
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.browserTask.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.ingestToken.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };

  // 派活给插件的两个前置：工作区得有能干活的浏览器，竞对得在监控列表里
  await prisma.ingestToken.create({
    data: { workspaceId: ws.id, token: `bcn_test_${Math.random().toString(36).slice(2)}`, label: '测试设备', memberId: member.id },
  });
  // handle 是全局唯一键（platform+handle），且竞对表跨租户共享不在 beforeEach 里清——
  // 写死 'rival' 的话第二个用例就撞唯一约束
  const comp = await prisma.competitorAccount.create({
    data: { name: '对家', platform: 'douyin', handle: `rival-${Math.random().toString(36).slice(2, 10)}` },
  });
  competitorId = comp.id;
  await prisma.watchlistItem.create({ data: { workspaceId: ws.id, competitorId: comp.id } });
});

/** 派一次「要等结果」的采集，返回运行 id 与被排出来的任务 id。 */
async function startWaitingRun(): Promise<{ runId: string; taskId: string }> {
  h.script = [
    { toolCalls: [call('dispatch_browser_task', { kind: 'collect_competitor', competitor_id: competitorId, wait_for_result: true })] },
    { text: '拿到数据了，对家最近更新了不少。' },
  ];
  const started = await startAgentRun(ctx, '去采一下对家最新作品再告诉我');
  // 派活是写操作 → 先停在等确认；用户点确认后才真的排队
  await settleAgentKicks();
  const confirmed = await decidePendingCall(ctx, started.runId, true);
  expect(confirmed.status, '确认之后应该停在「等浏览器」').toBe('waiting_browser');

  const task = await prisma.browserTask.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } });
  return { runId: started.runId, taskId: task.id };
}

describe('开跑立刻返回，后台接着跑', () => {
  it('startAgentRun 返回时还没跑完，等后台跑完才有答案', async () => {
    h.script = [{ toolCalls: [call('list_topics', { limit: 3 })] }, { text: '你还没有选题。' }];

    const started = await startAgentRun(ctx, '我有哪些选题');
    // 关键：这一刻请求已经可以返回给用户了——**它没有等这次执行跑完**。
    expect(started.status).toBe('running');
    expect(started.answer).toBeUndefined();
    expect(started.steps, '返回的第一帧不该已经有步骤了').toHaveLength(0);
    // 【这里刻意不断言「模型一次都还没调」】那是在赌 JS 的调度顺序：
    // kick 里的动态 import 在模块缓存热了之后会很快轮到，而 startAgentRun 返回前
    // 还要 await 一次 viewOf 的查询——够那条后台线跑进 llmComplete 了。
    // 它偶尔红，而一个偶尔红的守卫最坏的地方是人会开始忽略它。
    //
    // 要防的退化（把 kick 改回同步 await）上面两条已经挡住了：那样 startAgentRun
    // 会等到跑完才返回，status 就是 done、answer 也有了。
    // 「kick 到底走没走异步路径」另有专门的守卫：tests/agent/kick-routing.test.ts。

    await settleAgentKicks();
    const done = await getAgentRunView(ctx, started.runId);
    expect(done.status).toBe('done');
    expect(done.answer).toContain('选题');
  });
});

describe('派活给插件后挂起，回执把它叫醒', () => {
  it('等结果期间：状态是等浏览器，且不出确认卡', async () => {
    const { runId } = await startWaitingRun();
    const view = await getAgentRunView(ctx, runId);

    expect(view.status).toBe('waiting_browser');
    // pending 这一列身兼两职（等你点头/等浏览器），但只有前者该渲染确认卡。
    // 不按状态分的话，用户会看到一张点了也没用的卡片
    expect(view.pending, '等浏览器时不该出确认卡').toBeUndefined();
    expect(view.waitingFor).toContain('插件');
    // 步骤流水上要立刻能看到「已排给插件」，而不是一片空白
    expect(view.steps.some((s) => s.kind === 'tool_result' && s.result.includes('已排给插件'))).toBe(true);
  });

  it('插件交活 → 自动接着推理，结果按 tool_call_id 补回对话里', async () => {
    const { runId, taskId } = await startWaitingRun();

    // 插件领活再交活（completeTask 只认 claimed 状态）
    await prisma.browserTask.update({ where: { id: taskId }, data: { status: 'claimed' } });
    await completeTask(ctx.workspaceId, taskId, { ok: true, result: '采到 12 条新作品' });
    await settleAgentKicks();

    const view = await getAgentRunView(ctx, runId);
    expect(view.status).toBe('done');
    expect(view.answer).toContain('对家');

    // 挂起时对话里留着一个悬空的 tool_call，叫醒时必须**按 id 补上那条回复**——
    // 少了它，下一轮请求里 tool_calls 没有对应的 tool 消息，多数端点直接 400
    const last = h.calls[h.calls.length - 1];
    const toolMsg = last.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c1');
    expect(toolMsg, '悬空的 tool_call 必须被补上回复').toBeTruthy();
    expect(String(toolMsg?.content)).toContain('采到 12 条');
  });

  it('叫醒矩阵：判死 / 过期 / 取消 三种结局也都能把它叫醒', async () => {
    // ① 判死（不可重试的 kind 或试满次数）
    {
      const { runId, taskId } = await startWaitingRun();
      h.script = [{ text: '没采到，可能是没登录。' }];
      await prisma.browserTask.update({ where: { id: taskId }, data: { status: 'claimed', attempts: 99 } });
      await completeTask(ctx.workspaceId, taskId, { ok: false, error: '目标平台未登录' });
      await settleAgentKicks();
      const v = await getAgentRunView(ctx, runId);
      expect(v.status, '插件判死后运行不该还挂着').toBe('done');
    }

    await prisma.agentStep.deleteMany();
    await prisma.agentRun.deleteMany();
    await prisma.browserTask.deleteMany();

    // ② 过期（插件一直没来领，48 小时到了）
    {
      const { runId, taskId } = await startWaitingRun();
      h.script = [{ text: '你的浏览器这两天没打开，我没拿到数据。' }];
      await prisma.browserTask.update({ where: { id: taskId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expireStaleTasks();
      await settleAgentKicks();
      const v = await getAgentRunView(ctx, runId);
      expect(v.status, '任务过期后运行不该还挂着').toBe('done');
    }

    await prisma.agentStep.deleteMany();
    await prisma.agentRun.deleteMany();
    await prisma.browserTask.deleteMany();

    // ③ 用户自己取消了这次采集
    {
      const { runId, taskId } = await startWaitingRun();
      h.script = [{ text: '好的，那我不采了。' }];
      await cancelBrowserTask(ctx.workspaceId, taskId);
      await settleAgentKicks();
      const v = await getAgentRunView(ctx, runId);
      expect(v.status, '取消采集后运行不该还挂着').toBe('done');
    }
  });

  it('还能重试的失败**不叫醒**（下一轮多半就成了，别让 AI 拿着假失败去回答）', async () => {
    const { runId, taskId } = await startWaitingRun();
    await prisma.browserTask.update({ where: { id: taskId }, data: { status: 'claimed', attempts: 1 } });
    await completeTask(ctx.workspaceId, taskId, { ok: false, error: '网络抖了一下' });
    await settleAgentKicks();

    expect((await getAgentRunView(ctx, runId)).status, '还会重试就该继续等').toBe('waiting_browser');
    expect((await prisma.browserTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('pending');
  });

  it('自愈：结果早就有了却没人来叫醒（进程在中间挂了），下次一看就补上', async () => {
    const { runId, taskId } = await startWaitingRun();
    h.script = [{ text: '数据我拿到了。' }];

    // 绕过 completeTask 直接改库 = 模拟「回执落库了，叫醒那一步没跑成」
    await prisma.browserTask.update({ where: { id: taskId }, data: { status: 'done', result: '采到 7 条' } });
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('waiting_browser');

    // 用户打开页面看这次运行——getAgentRunView 顺手自愈
    await getAgentRunView(ctx, runId);
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, runId)).status).toBe('done');
  });

  it('等浏览器的运行也能终止（不然一次派错的活要挂满 48 小时）', async () => {
    const { runId } = await startWaitingRun();
    const { cancelAgentRun } = await import('@/lib/agent/run');
    const v = await cancelAgentRun(ctx, runId);
    expect(v.status).toBe('cancelled');
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.waitingOn, '终止时要把「在等什么」一起清掉').toBeNull();
  });
});

describe('执行租约：同一次运行不许被两条线同时推', () => {
  it('已经有人在跑时，再踢一脚不会开出第二条推理线', async () => {
    h.script = [{ toolCalls: [call('list_topics', { limit: 1 })] }, { text: '好了。' }];
    const started = await startAgentRun(ctx, '查一下');
    // ⚠️ 先把开跑那一脚等干净再摆场景。不等的话这条用例自己就是个竞态：
    // startAgentRun 踢出去的后台运行可能在下面设租约**之前**就抢到锁调了模型，
    // 于是 h.calls 不为 0 而断言红——机器一忙就红，单跑又是绿的
    await settleAgentKicks();
    h.calls = [];

    // 手工把这次运行摆回「待推进 + 租约被别人按住」的状态
    await prisma.agentRun.update({
      where: { id: started.runId },
      data: { status: 'running', leaseUntil: new Date(Date.now() + 60_000) },
    });

    const { runAgentLoop } = await import('@/lib/agent/run');
    await runAgentLoop(started.runId);
    expect(h.calls.length, '租约被别人持有时不该调模型').toBe(0);

    // 租约过期后才轮得到接手
    await prisma.agentRun.update({ where: { id: started.runId }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    await runAgentLoop(started.runId);
    expect(h.calls.length).toBeGreaterThan(0);
  });

  it('叫醒被触发两次也只往前推一次', async () => {
    const { runId, taskId } = await startWaitingRun();
    h.script = [{ text: '拿到了。' }];
    const token = browserWaitToken(taskId);

    const first = await wakeRunsWaitingOn(token, { ok: true, summary: '采到 3 条' });
    const second = await wakeRunsWaitingOn(token, { ok: true, summary: '采到 3 条' });
    await settleAgentKicks();

    expect(first).toBe(1);
    expect(second, '第二次叫醒该扑空（状态已经不是 waiting_browser 了）').toBe(0);
  });
});

describe('上下文重建', () => {
  it('发起人已经不在团队里 → 如实判死，不留一个永远跑不动的僵尸', async () => {
    h.script = [{ toolCalls: [call('list_topics', { limit: 1 })] }];
    const started = await startAgentRun(ctx, '查一下');
    await settleAgentKicks();

    // 让它回到「待推进」的状态，再把发起人删掉
    await prisma.agentRun.update({
      where: { id: started.runId },
      data: { status: 'running', leaseUntil: null },
    });
    await prisma.member.delete({ where: { id: ctx.memberId } });

    const { runAgentLoop } = await import('@/lib/agent/run');
    await runAgentLoop(started.runId);

    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.runId } });
    expect(row.status).toBe('failed');
    expect(row.error).toContain('成员');
  });
});
