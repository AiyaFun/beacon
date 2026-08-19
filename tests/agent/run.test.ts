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

const { startAgentRun, decidePendingCall, MAX_STEPS } = await import('@/lib/agent/run');

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
    const turn = await startAgentRun(ctx, '帮我建个草稿');
    expect(turn.status).toBe('failed');
    expect(turn.error).toContain('模型');
    expect(turn.answer).toBeUndefined();
    // 关键：库里不能真的多出东西，也不能出现「已完成」的步骤
    expect(await prisma.draft.count()).toBe(0);
  });

  it('真模型调用失败被 Mock 兜底（degraded）同样中止，而不是把示例内容当结果', async () => {
    h.script = [{ text: '（示例）已完成', mocked: true, degraded: true }];
    const turn = await startAgentRun(ctx, '随便做点什么');
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
    const turn = await startAgentRun(ctx, '我有哪些选题');
    expect(turn.status).toBe('done');
    expect(turn.answer).toContain('选题');
    expect(turn.steps.map((s) => s.kind)).toEqual(['tool_call', 'tool_result', 'answer']);
  });

  it('写工具停在确认前，**此时数据库不许有任何变化**', async () => {
    h.script = [{ toolCalls: [call('create_draft', { title: 'AI 建的稿', platform: 'douyin', content: '正文' })] }];
    const turn = await startAgentRun(ctx, '帮我建一篇草稿');

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
    const first = await startAgentRun(ctx, '帮我建一篇草稿');
    expect(first.status).toBe('awaiting_confirm');

    const second = await decidePendingCall(ctx, first.runId, true);
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
    const first = await startAgentRun(ctx, '建草稿');
    const second = await decidePendingCall(ctx, first.runId, false);

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
    const turn = await startAgentRun(ctx, '建稿并看看选题');
    expect(turn.status).toBe('awaiting_confirm');
    // c2 是只读的，但它排在待确认那步后面 —— 不能已经执行过
    expect(turn.steps.filter((s) => s.kind === 'tool_result')).toHaveLength(0);
  });
});

describe('权限与越权', () => {
  it('viewer 拿不到写工具，模型硬要调也执行不了', async () => {
    const viewerCtx = { ...ctx, role: 'viewer' };
    h.script = [
      { toolCalls: [call('create_draft', { title: 'X', platform: 'douyin' })] },
      { text: '看来我没有这个权限。' },
    ];
    const turn = await startAgentRun(viewerCtx, '建草稿');

    // 工具清单里就不该有写工具
    const toolNames = h.calls[0].tools.map((t) => t.name);
    expect(toolNames).not.toContain('create_draft');
    // 即使模型硬调，也不会停下来等确认（它没这个权限），而是回灌一条权限错误
    expect(turn.status).toBe('done');
    expect(await prisma.draft.count()).toBe(0);
    expect(turn.steps.some((s) => s.kind === 'tool_result' && !s.ok)).toBe(true);
  });

  it('别人不能替发起人点确认', async () => {
    h.script = [{ toolCalls: [call('create_draft', { title: 'X', platform: 'douyin' })] }];
    const first = await startAgentRun(ctx, '建草稿');
    await expect(decidePendingCall({ ...ctx, memberId: 'someone-else' }, first.runId, true)).rejects.toThrow(/发起/);
    expect(await prisma.draft.count()).toBe(0);
  });

  it('不存在的工具不会把整次运行搞崩', async () => {
    h.script = [
      { toolCalls: [call('delete_everything', {})] },
      { text: '没有这个能力。' },
    ];
    const turn = await startAgentRun(ctx, '删掉所有东西');
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
    const turn = await startAgentRun(ctx, '读那篇稿');
    const result = turn.steps.find((s) => s.kind === 'tool_result');
    expect(result?.ok).toBe(false);
    expect(result?.result).toContain('不属于');
  });
});

describe('封顶', () => {
  it('模型来回打转时步数封顶，如实说没做完', async () => {
    // 每轮都调一个只读工具，永不给答案
    h.script = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({ toolCalls: [call('list_topics', { limit: 1 }, `c${i}`)] }));
    const turn = await startAgentRun(ctx, '一直查');
    expect(turn.status).toBe('failed');
    expect(turn.error).toContain('上限');
  }, 20_000);
});
