import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 上线前排查抓出来的六个缺陷，逐个钉死。
//
// 它们有一个共同点：**都不会报错，只会让用户看到一件与事实不符的事**——
// 补充的那句话没了、终止之后子任务还在做、上一次的答案挂在这一次的运行上、
// 时间线上同一个结果出现两遍、明明只派过一次却被告知「已经用过 2 次」、
// 运行中心里一条永远转圈的记录。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  throwNext: false,
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    if (h.throwNext) {
      h.throwNext = false;
      throw new Error('配额超限');
    }
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView, appendUserNote, cancelAgentRun, transition } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { appendNote } = await import('@/lib/agent/notes');
const { toolUsedTimes, toolCapReason, PER_RUN_TOOL_CAP } = await import('@/lib/agent/budget');
const { tickAgentRuns } = await import('@/lib/agent/tick');
const { wakeRunsWaitingOn, workflowWaitToken } = await import('@/lib/agent/wake');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.script = [];
  h.throwNext = false;
  await prisma.agentRunNote.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.workflowRun.deleteMany();
  await prisma.notification.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

describe('追问不能在模型抛错时蒸发', () => {
  it('排干之后立刻落库：这一轮炸了，那句话仍然在对话里', async () => {
    h.script = [{ text: '好' }];
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();

    // 跑完之后补一句 → 终态续跑，而续跑的第一次模型调用抛错
    h.throwNext = true;
    await appendUserNote(ctx, t.runId, '顺便看看小红书那边');
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: t.runId } });
    // 【关键】drainNotes 已经把它标成「已送达」了。如果落库发生在模型调用之后，
    // 这次抛错就会让它人间蒸发：note 表里是已消费、messages 里没有，两头都找不回来。
    expect(row?.messages, '模型抛错把用户那句补充吞掉了').toContain('顺便看看小红书那边');
    const pending = await prisma.agentRunNote.count({ where: { runId: t.runId, consumedAt: null } });
    expect(pending, '既没落进对话、也没退回未送达 —— 那句话就此丢了').toBe(0);
  });
});

describe('终止父运行要连带终止子运行', () => {
  it('子运行跟着停，且如实说明是谁停的', async () => {
    h.script = [{ text: '父跑起来了' }];
    const parent = await startAgentRun(ctx, '父任务');
    await settleAgentKicks();

    // 造一条挂在它下面、还活着的子运行
    const child = await prisma.agentRun.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
        goal: '子任务', status: 'running', parentRunId: parent.runId, messages: '[]',
      },
    });
    await prisma.agentRun.update({ where: { id: parent.runId }, data: { status: 'waiting_browser', waitingOn: `run:${child.id}` } });

    await cancelAgentRun(ctx, parent.runId);

    const after = await prisma.agentRun.findUnique({ where: { id: child.id } });
    expect(after?.status, '父运行终止了，子运行还在跑 —— 它会接着烧额度、接着写库').toBe('cancelled');
    expect(after?.error).toContain('终止');
  });

  it('已经跑完的子运行不会被拉回来', async () => {
    h.script = [{ text: '好' }];
    const parent = await startAgentRun(ctx, '父任务');
    await settleAgentKicks();
    const child = await prisma.agentRun.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
        goal: '子任务', status: 'done', answer: '做完了', parentRunId: parent.runId, messages: '[]',
      },
    });
    await prisma.agentRun.update({ where: { id: parent.runId }, data: { status: 'running' } });

    await cancelAgentRun(ctx, parent.runId);
    const after = await prisma.agentRun.findUnique({ where: { id: child.id } });
    expect(after?.status, '把已经完成的子运行改成了 cancelled').toBe('done');
    expect(after?.answer).toBe('做完了');
  });
});

describe('续跑要把上一段的答案清掉', () => {
  it('answer 落到 null，而不是被 Prisma 忽略掉', async () => {
    h.script = [{ text: '第一段的结论' }];
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    expect((await prisma.agentRun.findUnique({ where: { id: t.runId } }))?.answer).toBe('第一段的结论');

    // 追问 → 终态续跑。这一刻起它在跑，不该再挂着上一段的结论
    h.script = [];
    let seen: string | null | undefined;
    const orig = prisma.agentRun.findUnique;
    await appendUserNote(ctx, t.runId, '再改改');
    seen = (await prisma.agentRun.findUnique({ where: { id: t.runId } }))?.answer;
    void orig;
    expect(seen, 'undefined 会被 Prisma 整个忽略 —— 上一段的答案原样留着，用户以为它已经答完了').toBeNull();
    await settleAgentKicks();
  });
});

describe('挂起类工具的次数上限不该被腰斩', () => {
  it('按 tool_call 记账：一次挂起调用只算一次（它会写两条 tool_result）', async () => {
    const run = await prisma.agentRun.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId, goal: 'g', status: 'running', messages: '[]' },
    });
    const cap = PER_RUN_TOOL_CAP.run_agent;
    expect(cap, 'run_agent 没有上限了？这条用例要跟着改').toBeGreaterThanOrEqual(2);

    // 模拟一次**挂起类**调用留下的流水：一条 tool_call + 挂起时一条 tool_result
    // + 被叫醒补结果时又一条 tool_result
    await prisma.agentStep.createMany({
      data: [
        { runId: run.id, seq: 1, kind: 'tool_call', tool: 'run_agent', args: '{}' },
        { runId: run.id, seq: 2, kind: 'tool_result', tool: 'run_agent', args: '{}', result: '派出去了', ok: true },
        { runId: run.id, seq: 3, kind: 'tool_result', tool: 'run_agent', args: '{}', result: '子任务跑完了', ok: true },
      ],
    });

    expect(await toolUsedTimes(run.id, 'run_agent'), '按 tool_result 数会把一次调用算成两次').toBe(1);
    expect(await toolCapReason(run.id, 'run_agent'), '只派过一次就被拦住了').toBeNull();
  });

  it('真的到上限了还是要拦（别把闸修没了）', async () => {
    const run = await prisma.agentRun.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId, goal: 'g', status: 'running', messages: '[]' },
    });
    const cap = PER_RUN_TOOL_CAP.run_agent;
    // 闸是在**本次 tool_call 已经落流水之后**判的，所以第 cap+1 次时库里有 cap+1 条
    for (let i = 0; i < cap; i++) {
      await prisma.agentStep.create({ data: { runId: run.id, seq: i + 1, kind: 'tool_call', tool: 'run_agent', args: '{}' } });
    }
    expect(await toolCapReason(run.id, 'run_agent'), `刚好第 ${cap} 次不该被拦`).toBeNull();
    await prisma.agentStep.create({ data: { runId: run.id, seq: cap + 1, kind: 'tool_call', tool: 'run_agent', args: '{}' } });
    expect(await toolCapReason(run.id, 'run_agent'), `第 ${cap + 1} 次必须拦住`).toContain('上限');
  });
});

describe('叫醒的流水要写在抢到那一步之后', () => {
  it('叫醒被触发两次，时间线上只留一条结果', async () => {
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
        goal: 'g', status: 'waiting_browser', waitingOn: 'workflow:wf1',
        pending: JSON.stringify({ id: 'c1', name: 'run_workflow', arguments: '{}' }),
        messages: '[]', steps: 3,
      },
    });

    // 【必须并发发起】第一版是先后调两次——而那样第二次的 findMany 会看到状态
    // 已经不是 waiting_browser，直接空手而归，**根本走不到写流水那一步**。
    // 于是把「先写流水再 transition」改回去它照样绿（mutation 当场抓到）。
    // 真正的竞态是两条线**同时读到还在挂起**：回执重投撞上定时巡检的自愈，
    // 两边都往下走，而 transition 只有一个能赢。
    const [a, b] = await Promise.all([
      wakeRunsWaitingOn(workflowWaitToken('wf1'), { ok: true, summary: '跑完了' }),
      wakeRunsWaitingOn(workflowWaitToken('wf1'), { ok: true, summary: '跑完了' }),
    ]);
    await settleAgentKicks();

    expect(a + b, '两条线都抢到了 —— 乐观锁没起作用').toBe(1);
    const dup = await prisma.agentStep.count({ where: { runId: run.id, seq: 4 } });
    expect(dup, '同一个结果在时间线上出现了两遍，seq 也与 steps 对不上').toBe(1);
  });
});

describe('跑飞的智能体流水线要如实判死', () => {
  it('两小时没动静的判 failed，并把等它的执行叫醒', async () => {
    const tpl = await prisma.workflowTemplate.create({
      data: { slug: `t-${Date.now()}`, name: '模板', tenantId: ctx.tenantId },
    });
    const wf = await prisma.workflowRun.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, templateId: tpl.id, status: 'running', stepIndex: 2 },
    });
    // 心跳停在三小时前
    await prisma.workflowRun.update({
      where: { id: wf.id },
      data: { updatedAt: new Date(Date.now() - 3 * 60 * 60_000) },
    });
    const waiter = await prisma.agentRun.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
        goal: 'g', status: 'waiting_browser', waitingOn: workflowWaitToken(wf.id),
        pending: JSON.stringify({ id: 'c1', name: 'run_workflow', arguments: '{}' }),
        messages: '[]', steps: 1,
      },
    });

    const r = await tickAgentRuns();
    await settleAgentKicks();

    expect(r.reapedWorkflows, '跑飞的流水线没人收 —— 运行中心里它永远转圈').toBe(1);
    const after = await prisma.workflowRun.findUnique({ where: { id: wf.id } });
    expect(after?.status).toBe('failed');
    expect(after?.error, '没说断在第几步，用户不知道哪些做过了').toContain('第 3 步');

    const w = await prisma.agentRun.findUnique({ where: { id: waiter.id } });
    expect(w?.status, '等它的那次执行没被叫醒，要干等 24 小时的挂起兜底').not.toBe('waiting_browser');
  });

  it('还在动的不许碰', async () => {
    const tpl = await prisma.workflowTemplate.create({
      data: { slug: `t2-${Date.now()}`, name: '模板2', tenantId: ctx.tenantId },
    });
    const wf = await prisma.workflowRun.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, templateId: tpl.id, status: 'running', stepIndex: 1 },
    });
    const r = await tickAgentRuns();
    expect(r.reapedWorkflows).toBe(0);
    expect((await prisma.workflowRun.findUnique({ where: { id: wf.id } }))?.status).toBe('running');
  });
});

// transition 在这份文件里只用于类型引用，避免 lint 报未使用
void transition;
void getAgentRunView;
void appendNote;

// ── 它想调工具，却把调用写成了正文 ──────────────────────────────────────────
//
// 真机第一次派「写篇初稿」就撞上：MiniMax 上一轮还在发正规工具调用，下一轮忽然吐出
//   「接下来，我会根据这个选题生成一篇初稿并保存。请稍等。」
//   ```typescript
//   functions.create_draft({"platform":"wechat","title":"…"})
//   ```
// 而这一轮的 toolCalls 是空的。执行器把这段**承诺**当成最终答案、判 done——
// 用户要一篇稿子，拿到一句「请稍等」，任务写着「已完成」，库里一个字都没多。
const { looksLikeUnsentToolCall } = await import('@/lib/agent/run');
const T = [{ name: 'create_draft' }, { name: 'list_topics' }];

describe('把写成正文的工具调用认出来', () => {
  it('认得出三种常见的写法', () => {
    expect(looksLikeUnsentToolCall('好的。\n```typescript\nfunctions.create_draft({"platform":"wechat"})\n```', T)).toBe(true);
    expect(looksLikeUnsentToolCall('<invoke name="create_draft">…', T)).toBe(true);
    expect(looksLikeUnsentToolCall('{"tool": "create_draft", "args": {}}', T)).toBe(true);
  });

  it('🔒 不许误伤：名字不是这次能用的工具就不算', () => {
    // 只看「长得像调用」的话，一篇讲代码的稿子会被反复打回
    expect(looksLikeUnsentToolCall('functions.doSomethingElse({})', T)).toBe(false);
    expect(looksLikeUnsentToolCall('教你写 functions.map(fn) 这种高阶函数', T)).toBe(false);
  });

  it('🔒 不许误伤：正文里提一句工具名不算', () => {
    // 只看「出现了工具名」的话，它如实汇报自己做过什么也会被当成没发出去的调用
    expect(looksLikeUnsentToolCall('我用 list_topics 查了一下，你有 6 条选题。', T)).toBe(false);
    expect(looksLikeUnsentToolCall('接下来可以用 create_draft 建稿子。', T)).toBe(false);
  });

  it('🔒 没有可用工具时一律不算（不然会在空工具的运行里空转）', () => {
    expect(looksLikeUnsentToolCall('functions.create_draft({})', [])).toBe(false);
  });
});

describe('端到端：写成正文就把它叫回来，不许当成答完了', () => {
  it('叫回来之后它用正规调用重发，任务才算完', async () => {
    h.script = [
      // 第一轮：把调用写成正文
      { text: '接下来我会建一篇初稿。\n```\nfunctions.list_topics({"limit":3})\n```' },
      // 被叫回来之后：发正规调用
      { toolCalls: [{ id: 'c1', name: 'list_topics', arguments: '{"limit":3}' }] },
      { text: '查完了，你有若干选题。' },
    ];
    const t = await startAgentRun(ctx, '看看我的选题');
    await settleAgentKicks();

    const v = await getAgentRunView(ctx, t.runId);
    expect(v.status).toBe('done');
    // 【关键】那句承诺不能变成最终答案
    expect(v.answer, '把「我接下来会…」当成了交付').not.toContain('接下来我会建一篇初稿');
    expect(v.answer).toContain('查完了');
    // 时间线上要留下痕迹：用户得知道中间发生过一次重发
    expect(v.steps.some((s) => /写成了正文/.test(String(s.result ?? ''))), '重发这件事没留在时间线上').toBe(true);
    expect(v.steps.some((s) => s.kind === 'tool_result' && s.tool === 'list_topics'), '重发之后那一步没真的执行').toBe(true);
  });

  it('叫两次还不会用工具就照常收工（不许无限空转）', async () => {
    const bad = '我这就去做。\n```\nfunctions.list_topics({})\n```';
    h.script = [{ text: bad }, { text: bad }, { text: bad }, { text: bad }, { text: bad }];
    const t = await startAgentRun(ctx, '看看我的选题');
    await settleAgentKicks();

    const v = await getAgentRunView(ctx, t.runId);
    expect(['done', 'failed'], '既没收工也没判死 —— 多半在空转').toContain(v.status);
    const nudges = v.steps.filter((s) => /写成了正文/.test(String(s.result ?? ''))).length;
    expect(nudges, `叫了 ${nudges} 次，上限该是 2`).toBeLessThanOrEqual(2);
  });
});

describe('走确认闸执行的写操作，产物也要进清单', () => {
  it('确认后建出来的草稿，出现在产物清单里', async () => {
    // 【为什么这条必须有】产物登记挂在 executeCall 的 ctx.runId 上，而
    // decidePendingCall 的 ctx 来自 server action、**天生不带 runId**。
    // 少带这一下，产物就静默丢弃——而默认档下写操作**全都**走确认闸，
    // 等于整个产物清单是死的。真机第一次验就撞上：草稿建出来了，清单是空的。
    const { decidePendingCall } = await import('@/lib/agent/run');
    h.script = [
      { toolCalls: [{ id: 'd1', name: 'create_draft', arguments: JSON.stringify({ platform: 'wechat', title: '测试稿' }) }] },
      { text: '建好了。' },
    ];
    const t = await startAgentRun(ctx, '建一篇稿子');
    await settleAgentKicks();

    const paused = await getAgentRunView(ctx, t.runId);
    expect(paused.status, '写操作没停下来等确认').toBe('awaiting_confirm');

    await decidePendingCall(ctx, t.runId, true);
    await settleAgentKicks();

    const done = await getAgentRunView(ctx, t.runId);
    const arts = (done as { artifacts?: { kind: string; href: string }[] }).artifacts ?? [];
    expect(arts.length, '确认后建出来的东西没进产物清单（用户点不进去）').toBeGreaterThan(0);
    expect(arts[0].kind).toBe('draft');
    expect(arts[0].href, '产物没有可点的地址').toMatch(/\/studio\?draft=/);
    // 库里确实建出来了才算数（不然是清单在自说自话）
    expect(await prisma.draft.count({ where: { accountId: ctx.accountId } })).toBeGreaterThan(0);
  });
});
