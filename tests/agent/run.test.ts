import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 执行器（AI 全域调用）。把模型桩成一段**剧本**：第 N 轮返回什么工具调用/什么回答，
// 由用例自己排。真模型的不确定性不该进单测，要验的是执行器的规矩：
// 写操作必须停下来问人、拒绝要如实回灌、Mock 模型一律不许假装执行、步数要封顶。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[]; mocked?: boolean; degraded?: boolean }[],
  calls: [] as { messages: unknown[]; tools: { name: string }[] }[],
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: unknown[], opts?: { tools?: { name: string }[] }) => {
    h.calls.push({ messages, tools: opts?.tools ?? [] });
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '',
      provider: 'scripted',
      model: 'scripted',
      mocked: next.mocked ?? false,
      degraded: next.degraded,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));

// 人设/记忆是旁路，桩成空避免牵进一堆 DB 依赖
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, decidePendingCall, getAgentRunView, MAX_ROUNDS } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');

// 【执行已经改成后台跑了】startAgentRun / decidePendingCall 现在**立刻返回**一个
// status=running 的快照，真正的推理在后台继续（lib/agent/kick.ts）。
// 所以用例要的「跑完之后是什么样」得等一下再读回来——settleAgentKicks 就是为此存在的
//（生产的请求路径绝不该调它，那等于把异步又变回同步）。
//
// 这两个小包装刻意**不放宽任何断言**：等的是同一次运行，读的是同一张表。
// 这一组测的是**确认闸本身**，所以显式走逐步确认档（2026-09-03 起缺省已是「直接跑完」）
async function runToEnd(c: typeof ctx, goal: string) {
  const started = await startAgentRun(c, goal, { authMode: 'confirm_each' });
  await settleAgentKicks();
  return getAgentRunView(c, started.runId);
}

async function decideToEnd(c: typeof ctx, runId: string, approve: boolean) {
  await decidePendingCall(c, runId, approve);
  await settleAgentKicks();
  return getAgentRunView(c, runId);
}

let ctx: {
  tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string;
};

beforeEach(async () => {
  h.script = [];
  h.calls = [];
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

const call = (name: string, args: unknown, id = 'c1') => ({ id, name, arguments: JSON.stringify(args) });

describe('Mock 模型下一律不许假装执行', () => {
  it('没接真模型 → 整次运行判失败，并说清楚原因', async () => {
    h.script = [{ text: '好的，我已经帮你建好草稿了！', mocked: true }];
    const turn = await runToEnd(ctx, '帮我建个草稿');
    expect(turn.status).toBe('failed');
    expect(turn.error).toContain('模型');
    expect(turn.answer).toBeUndefined();
    // 关键：库里不能真的多出东西，也不能出现「已完成」的步骤
    expect(await prisma.draft.count()).toBe(0);
  });

  it('真模型调用失败被 Mock 兜底（degraded）同样中止，而不是把示例内容当结果', async () => {
    h.script = [{ text: '（示例）已完成', mocked: true, degraded: true }];
    const turn = await runToEnd(ctx, '随便做点什么');
    expect(turn.status).toBe('failed');
    expect(turn.error).toContain('调用失败');
  });
});

describe('读工具直接执行，写工具必须先问人', () => {
  it('只读工具无需确认，一轮跑完给出回答', async () => {
    h.script = [
      { toolCalls: [call('list_topics', { limit: 5 })] },
      { text: '你现在还没有选题，我建议先跑一轮推荐。' },
    ];
    const turn = await runToEnd(ctx, '我有哪些选题');
    expect(turn.status).toBe('done');
    expect(turn.answer).toContain('选题');
    expect(turn.steps.map((s) => s.kind)).toEqual(['tool_call', 'tool_result', 'answer']);
  });

  it('写工具停在确认前，**此时数据库不许有任何变化**', async () => {
    h.script = [{ toolCalls: [call('create_draft', { title: 'AI 建的稿', platform: 'douyin', content: '正文' })] }];
    const turn = await runToEnd(ctx, '帮我建一篇草稿');

    expect(turn.status).toBe('awaiting_confirm');
    expect(turn.pending?.tool).toBe('create_draft');
    expect(turn.pending?.args.title).toBe('AI 建的稿');
    expect(await prisma.draft.count()).toBe(0); // 还没点确认，就不该有草稿
  });

  it('确认后才真的执行，并把结果回灌给模型', async () => {
    h.script = [
      { toolCalls: [call('create_draft', { title: 'AI 建的稿', platform: 'douyin', content: '正文' })] },
      { text: '已经建好《AI 建的稿》了。' },
    ];
    const first = await runToEnd(ctx, '帮我建一篇草稿');
    expect(first.status).toBe('awaiting_confirm');

    const second = await decideToEnd(ctx, first.runId, true);
    expect(second.status).toBe('done');
    const drafts = await prisma.draft.findMany();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].title).toBe('AI 建的稿');

    // 回灌给模型的那条消息必须带上 tool_call_id，否则下一轮多数端点直接 400
    const lastCall = h.calls[h.calls.length - 1];
    const toolMsg = (lastCall.messages as { role: string; toolCallId?: string }[]).find((m) => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('c1');
  });

  it('拒绝 → 不执行，且如实告诉模型「用户拒绝了」', async () => {
    h.script = [
      { toolCalls: [call('create_draft', { title: '不想要的稿', platform: 'douyin' })] },
      { text: '好的，那我不建了。' },
    ];
    const first = await runToEnd(ctx, '建草稿');
    const second = await decideToEnd(ctx, first.runId, false);

    expect(second.status).toBe('done');
    expect(await prisma.draft.count()).toBe(0);
    expect(second.steps.some((s) => s.kind === 'rejected')).toBe(true);

    const lastCall = h.calls[h.calls.length - 1];
    const toolMsg = (lastCall.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('拒绝');
  });

  it('同一轮里排在待确认之后的调用不许先斩后奏', async () => {
    h.script = [
      {
        toolCalls: [
          call('create_draft', { title: '先建稿', platform: 'douyin' }, 'c1'),
          call('list_topics', { limit: 3 }, 'c2'),
        ],
      },
    ];
    const turn = await runToEnd(ctx, '建稿并看看选题');
    expect(turn.status).toBe('awaiting_confirm');
    // c2 是只读的，但它排在待确认那步后面 —— 不能已经执行过
    expect(turn.steps.filter((s) => s.kind === 'tool_result')).toHaveLength(0);
  });
});

describe('权限与越权', () => {
  it('viewer 拿不到写工具，模型硬要调也执行不了', async () => {
    // 成员在库里就得是 viewer：执行循环的权限**按库里发起人的角色算**，
    // 不认调用方随手传进来的 role（见下面那条守卫用例，那是一条安全性质）
    const viewer = await prisma.member.create({ data: { tenantId: ctx.tenantId, name: '看客', role: 'viewer' } });
    const viewerCtx = { ...ctx, memberId: viewer.id, role: 'viewer' };
    h.script = [
      { toolCalls: [call('create_draft', { title: 'X', platform: 'douyin' })] },
      { text: '看来我没有这个权限。' },
    ];
    const turn = await runToEnd(viewerCtx, '建草稿');

    // 工具清单里就不该有写工具
    const toolNames = h.calls[0].tools.map((t) => t.name);
    expect(toolNames).not.toContain('create_draft');
    // 即使模型硬调，也不会停下来等确认（它没这个权限），而是回灌一条权限错误
    expect(turn.status).toBe('done');
    expect(await prisma.draft.count()).toBe(0);
    expect(turn.steps.some((s) => s.kind === 'tool_result' && !s.ok)).toBe(true);
  });

  it('权限按库里发起人的角色算，传进来的 role 说了不算', async () => {
    // 执行改成后台跑之后，循环是从库里把上下文重建出来的（叫它的地方——队列 worker、
    // 插件回执——手上没有会话）。这条守的是重建时**不能信任调用方给的角色**：
    // 信了的话，一个降权前发起、降权后才被叫醒的运行，就成了绕过权限的通道。
    const viewer = await prisma.member.create({ data: { tenantId: ctx.tenantId, name: '看客', role: 'viewer' } });
    h.script = [
      { toolCalls: [call('create_draft', { title: '越权稿', platform: 'douyin' })] },
      { text: '我没有这个权限。' },
    ];
    // 谎报成 owner：库里这个人是 viewer
    const turn = await runToEnd({ ...ctx, memberId: viewer.id, role: 'owner' }, '建草稿');

    expect(h.calls[0].tools.map((t) => t.name), '给模型的清单要按库里的角色过滤').not.toContain('create_draft');
    expect(await prisma.draft.count(), '谎报角色不该建出草稿').toBe(0);
    expect(turn.status).toBe('done');
  });

  it('别人不能替发起人点确认', async () => {
    h.script = [{ toolCalls: [call('create_draft', { title: 'X', platform: 'douyin' })] }];
    const first = await runToEnd(ctx, '建草稿');
    await expect(decidePendingCall({ ...ctx, memberId: 'someone-else' }, first.runId, true)).rejects.toThrow(/发起/);
    expect(await prisma.draft.count()).toBe(0);
  });

  it('不存在的工具不会把整次运行搞崩', async () => {
    h.script = [
      { toolCalls: [call('delete_everything', {})] },
      { text: '没有这个能力。' },
    ];
    const turn = await runToEnd(ctx, '删掉所有东西');
    expect(turn.status).toBe('done');
    expect(turn.steps.some((s) => s.kind === 'tool_result' && !s.ok)).toBe(true);
  });

  it('跨工作区的 id 读不到（模型可能把别处见过的 id 直接拿来用）', async () => {
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const otherWs = await prisma.workspace.create({ data: { tenantId: other.id, name: 'OW' } });
    const otherAcc = await prisma.creatorAccount.create({
      data: { workspaceId: otherWs.id, name: '别人的号', platform: 'douyin', personaCard: '{}' },
    });
    const otherDraft = await prisma.draft.create({ data: { accountId: otherAcc.id, title: '别人的稿', platform: 'douyin' } });

    h.script = [
      { toolCalls: [call('read_draft', { draftId: otherDraft.id })] },
      { text: '读不到这篇。' },
    ];
    const turn = await runToEnd(ctx, '读那篇稿');
    const result = turn.steps.find((s) => s.kind === 'tool_result');
    expect(result?.ok).toBe(false);
    expect(result?.result).toContain('不属于');
  });
});

describe('封顶', () => {
  it('模型来回打转时轮数封顶，如实说没做完', async () => {
    // 每轮都调一个只读工具，永不给答案
    h.script = Array.from({ length: MAX_ROUNDS + 5 }, (_, i) => ({ toolCalls: [call('list_topics', { limit: 1 }, `c${i}`)] }));
    const turn = await runToEnd(ctx, '一直查');
    expect(turn.status).toBe('failed');
    expect(turn.error).toContain('上限');
  }, 20_000);

  // 到顶了不直接判死，先让它把话说完：原来用户拿到的是一句「跑到上限了」外加一片空白，
  // 而它可能已经查了五样东西、写好了一半。多花一次调用换一段「我做到哪儿了」，
  // 这次执行才对用户有价值。**仍然判 failed**——没做完就是没做完。
  it('到顶时强制一轮收尾：给出阶段性成果，且那一轮不许再带工具', async () => {
    h.script = [
      ...Array.from({ length: MAX_ROUNDS }, (_, i) => ({ toolCalls: [call('list_topics', { limit: 1 }, `c${i}`)] })),
      { text: '我查了三轮选题，挑出两条可用的，但还没来得及写稿。' },
    ];
    const turn = await runToEnd(ctx, '一直查');

    expect(turn.status).toBe('failed');
    expect(turn.answer, '收尾那段话要带给用户').toContain('挑出两条');
    expect(turn.error).toContain('上限');

    // 收尾那一轮**不给工具**：给了它又会接着干活，那就不叫收尾了
    const lastCall = h.calls[h.calls.length - 1];
    expect(lastCall.tools.length, '收尾轮不该带工具').toBe(0);
    // 前面每一轮都是带工具的正常干活轮
    expect(h.calls[0].tools.length).toBeGreaterThan(0);
  }, 20_000);

  // 【这条守的是「上限数的到底是什么」】原先封顶判的是**步骤流水条数**，而一轮调一次工具
  // 就记两条（tool_call + tool_result）——写着 12 轮的上限实际约等于 6 次工具调用，
  // 用户看到的是「才做了几步就说到上限了」。
  //
  // 断言写成「模型真的被调满了 MAX_ROUNDS 次」：改回按 steps 判的话，
  // 模型只会被调 6 次左右，这条当场变红。
  it('封顶数的是模型轮数，不是步骤流水条数', async () => {
    h.script = Array.from({ length: MAX_ROUNDS + 5 }, (_, i) => ({ toolCalls: [call('list_topics', { limit: 1 }, `c${i}`)] }));
    const turn = await runToEnd(ctx, '一直查');
    expect(turn.status).toBe('failed');

    // MAX_ROUNDS 轮干活 + 1 轮收尾（那一轮不带工具，只让它说清做到哪儿了）
    expect(h.calls.length).toBe(MAX_ROUNDS + 1);
    const row = await prisma.agentRun.findUnique({ where: { id: turn.runId }, select: { rounds: true, steps: true } });
    expect(row?.rounds).toBe(MAX_ROUNDS);
    // 流水条数远多于轮数（每轮两条），正是它不能拿来当轮数用的原因
    expect(row!.steps).toBeGreaterThan(MAX_ROUNDS);
  }, 20_000);
});
