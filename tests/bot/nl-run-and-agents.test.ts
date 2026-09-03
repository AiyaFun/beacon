import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';

// 2026-09-02 用户真机反馈（微信 iLink）：说「给我今天的选题」，机器人回「听懂为：查看帮助」。
// 两件事：① 自然语言要能**直接执行**对应的任务（晨报秒回；「帮我写一篇…」派给执行器）；
//        ② 一个机器人要能切**不同的智能体**（不再只有渠道绑死的那一个）。

const h = vi.hoisted(() => ({
  llmText: '好的，收到。',
  systemSeen: '' as string,
  started: [] as { goal: string; opts: Record<string, unknown> }[],
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: string, _task: string, messages: { role: string; content: string }[]) => {
    h.systemSeen = messages.find((m) => m.role === 'system')?.content ?? '';
    return { text: h.llmText, provider: 'x', model: 'x', mocked: false, promptTokens: 1, completionTokens: 1 };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));
vi.mock('@/lib/agent/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/agent/run')>();
  return {
    ...real,
    startAgentRun: async (_ctx: unknown, goal: string, opts: Record<string, unknown> = {}) => {
      h.started.push({ goal, opts });
      return { runId: 'run-1', status: 'running', steps: [], answer: null, error: null };
    },
  };
});

const { handleInbound } = await import('@/lib/bot/router');
const { classifyIntent, matchPhrase, matchAgentSwitch } = await import('@/lib/bot/intent');

const GROUP = { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1', senderId: 'ou_alice', isGroup: true };

async function withBot(allowCommands: string[]) {
  await prisma.botIntegration.create({
    data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x', pushEvents: '[]', allowCommands: JSON.stringify(allowCommands) },
  });
}
async function withMember() {
  await prisma.member.create({ data: { id: 'm1', tenantId: 't1', name: '爱丽丝', role: 'editor', status: 'active', oaIdentity: 'feishu:ou_alice' } });
}
async function withAgent(name: string, persona: string) {
  return prisma.workflowTemplate.create({
    data: { tenantId: 't1', slug: `t-${name}-${Date.now()}`, name, persona, steps: '[]', mode: 'autonomous', agentConfig: '{"tools":["list_drafts"]}' },
  });
}

beforeEach(async () => {
  h.llmText = '好的，收到。';
  h.systemSeen = '';
  h.started = [];
  await prisma.tenant.deleteMany({});
  await prisma.workflowTemplate.deleteMany({ where: { tenantId: { not: null } } });
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' } });
});

describe('① 今日选题：秒回，不过 LLM，不再被听成「帮助」', () => {
  it.each(['给我今天的选题', '今天的选题', '今日选题', '晨报', '看看今天的推荐', '今天推荐什么'])('「%s」→ brief', (s) => {
    expect(matchPhrase(s)).toEqual({ cmd: 'brief' });
  });

  it('有推荐时把晨报端到群里（纯文本，无 Markdown 记号）', async () => {
    await withBot([]);
    await prisma.topicIdea.create({
      data: { accountId: 'a1', title: '秋季通勤穿搭三件套', state: 'recommended', totalScore: 87, queue: 'today', angle: '从一件外套讲起', sourceType: 'hot' },
    });
    const r = await handleInbound('w1', '给我今天的选题', GROUP);
    expect(r).toContain('今日选题晨报');
    expect(r).toContain('秋季通勤穿搭三件套');
    expect(r).toContain('切入角：从一件外套讲起');
    expect(r).not.toContain('**');
    expect(r).not.toContain('查看帮助');
  });

  it('没有推荐时如实说，并指路', async () => {
    await withBot([]);
    const r = await handleInbound('w1', '今天的选题', GROUP);
    expect(r).toContain('还没有推荐选题');
    expect(r).toContain('/topics');
  });

  it('斜杠 /晨报 同一条路', async () => {
    await withBot([]);
    expect(await handleInbound('w1', '/晨报', GROUP)).toContain('还没有推荐选题');
  });
});

describe('② 让它去做的句子：开了派任务就直接派给执行器', () => {
  it('classifyIntent：开了派任务 → run；没开 → 照旧对话（不会判成一个执行不了的意图）', async () => {
    expect(await classifyIntent('w1', '帮我写一篇秋季穿搭的笔记', { canRun: true })).toEqual({ cmd: 'run' });
    expect(await classifyIntent('w1', '把这三个竞对号都采一遍', { canRun: true })).toEqual({ cmd: 'run' });
    expect(await classifyIntent('w1', '帮我写一篇秋季穿搭的笔记', { canRun: false })).toEqual({ cmd: 'chat' });
  });

  it('🔒 疑问句不派：「这篇该怎么写」仍是对话', async () => {
    expect(await classifyIntent('w1', '帮我看看这篇该怎么写', { canRun: true })).toEqual({ cmd: 'chat' });
  });

  it('群里说「帮我写一篇…」→ 真的调了 startAgentRun，goal 是原话', async () => {
    await withBot(['chat', 'topic', 'dispatch']);
    await withMember();
    const r = await handleInbound('w1', '帮我写一篇秋季穿搭的笔记', GROUP);
    expect(r).toContain('派给 AI 执行器');
    expect(r).toContain('任务已开始');
    expect(h.started).toHaveLength(1);
    expect(h.started[0].goal).toBe('帮我写一篇秋季穿搭的笔记');
    expect(h.started[0].opts.origin).toBe('bot'); // 与 /执行 同一条路：直接跑完
  });

  it('没开派任务：先答一句，再说清为什么只是「说」没有「做」', async () => {
    await withBot(['chat', 'topic']);
    const r = await handleInbound('w1', '帮我写一篇秋季穿搭的笔记', GROUP);
    expect(r).toContain('好的，收到。');
    expect(r).toContain('开启「派任务」');
    expect(h.started).toHaveLength(0);
  });

  it('🔒 没绑身份的人说「帮我写」也派不出去（身份闸不因为自然语言而变松）', async () => {
    await withBot(['chat', 'topic', 'dispatch']);
    const r = await handleInbound('w1', '帮我写一篇秋季穿搭的笔记', GROUP);
    expect(r).toContain('先绑定身份');
    expect(h.started).toHaveLength(0);
  });
});

describe('③ 多个智能体：一个机器人在不同会话里切不同的智能体', () => {
  it('🔒 两份 schema 与迁移 SQL 都有 BotConversation.agentTemplateId', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const seg = /model BotConversation \{[\s\S]*?\n\}/.exec(readFileSync(join(process.cwd(), f), 'utf8'))?.[0] ?? '';
      expect(seg, f).toContain('agentTemplateId');
    }
    expect(readFileSync(join(process.cwd(), 'prisma/postgres/48-bot-conversation-agent.sql'), 'utf8')).toContain('"agentTemplateId"');
  });

  it('matchAgentSwitch 只给候选名，不判真伪', () => {
    expect(matchAgentSwitch('换成选题助手')).toBe('选题助手');
    expect(matchAgentSwitch('切换到 选题助手 智能体')).toBe('选题助手');
    expect(matchAgentSwitch('用「小红书日更」来')).toBe('小红书日更');
    expect(matchAgentSwitch('今天有什么热点')).toBeNull();
  });

  it('/智能体 列出可用的并标出当前；「换成 X」切换；之后对话以它的身份出面；/智能体 默认 切回', async () => {
    await withBot(['chat', 'topic']);
    const topicBot = await withAgent('选题助手', '要选题、要标题时派我');
    await withAgent('数据分析师', '看数据、找原因时派我');

    const list = await handleInbound('w1', '/智能体', GROUP);
    expect(list).toContain('选题助手');
    expect(list).toContain('数据分析师');
    expect(list).toContain('通用运营助手');

    const sw = await handleInbound('w1', '换成选题助手', GROUP);
    expect(sw).toContain('由「选题助手」出面');
    const row = await prisma.botConversation.findUnique({ where: { integrationId_chatId: { integrationId: 'bi1', chatId: 'oc_1' } } });
    expect(row?.agentTemplateId).toBe(topicBot.id);

    await handleInbound('w1', '/问 在吗', GROUP);
    expect(h.systemSeen).toMatch(/^你是「烽火台」的智能体「选题助手」/);
    expect(h.systemSeen).toContain('要选题、要标题时派我');

    const back = await handleInbound('w1', '/智能体 默认', GROUP);
    expect(back).toContain('通用运营助手');
    await handleInbound('w1', '/问 在吗', GROUP);
    expect(h.systemSeen).toContain('AI 运营助手');
  });

  it('🔒 名字对不上就不当切换：「用 3 个字概括」照常往下走，不改会话', async () => {
    await withBot(['chat', 'topic']);
    await withAgent('选题助手', 'x');
    h.llmText = '{"cmd":"chat","confidence":0.9}';
    const r = await handleInbound('w1', '用 3 个字概括', GROUP);
    const row = await prisma.botConversation.findUnique({ where: { integrationId_chatId: { integrationId: 'bi1', chatId: 'oc_1' } } });
    expect(row?.agentTemplateId ?? null).toBeNull();
    // 而且不能把它当成一次失败的切换回「没有叫 X 的智能体」——那句话该走正常流程（对话/收录）
    expect(r).not.toContain('没有叫');
    expect(r).not.toContain('智能体');
  });

  it('切了智能体之后派活也交给它：startAgentRun 带上 agentTemplateId 与身份提示', async () => {
    await withBot(['chat', 'topic', 'dispatch']);
    await withMember();
    const tpl = await withAgent('选题助手', '要选题时派我');
    await handleInbound('w1', '/智能体 选题助手', GROUP);
    const r = await handleInbound('w1', '/执行 给我出 5 个标题', GROUP);
    expect(r).toContain('已交给「选题助手」');
    expect(h.started[0].opts.agentTemplateId).toBe(tpl.id);
    expect(String(h.started[0].opts.agentSystemPrompt)).toContain('要选题时派我');
  });

  it('本会话没选时用渠道默认的那个', async () => {
    const tpl = await withAgent('渠道默认体', '渠道绑的');
    await prisma.botIntegration.create({
      data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x', pushEvents: '[]', allowCommands: '["chat","topic"]', agentTemplateId: tpl.id },
    });
    await handleInbound('w1', '/问 在吗', GROUP);
    expect(h.systemSeen).toContain('渠道默认体');
    expect(await handleInbound('w1', '/智能体', GROUP)).toContain('渠道默认');
  });
});
