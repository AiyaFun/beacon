import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { handleInbound } from '@/lib/bot/router';
import { looksLikeChat } from '@/lib/bot/intent';
import { loadConversation, BOT_CHAT_TTL_MS, MAX_TURNS } from '@/lib/bot/conversation';

// 群里 @机器人 对话：多轮上下文、账号归属、以及「什么时候算在跟我说话」。
//
// 这套用例最该守住两条：
//   ① 问句不能被静默收录成选题（用户问了没得到答案，等于机器人坏了）；
//   ② 选题不能被当成问句聊掉（他丢进来的灵感就丢了）。

const CTX = { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1' };

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.hotItem.deleteMany({});
  await prisma.competitorAccount.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.botIntegration.create({
    data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x', pushEvents: '[]' },
  });
});
afterEach(() => vi.restoreAllMocks());

async function withAccount(id = 'a1', name = '测试号') {
  await prisma.creatorAccount.create({ data: { id, workspaceId: 'w1', name, platform: 'douyin', status: 'active' } });
}

// 让对话走真实路径但不真的调模型
async function mockLlm(text = '这是回答') {
  const gw = await import('@/lib/llm/gateway');
  return vi.spyOn(gw, 'llmComplete').mockResolvedValue({
    text, mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
  } as any);
}

describe('looksLikeChat · 确定性「在跟我说话」判定', () => {
  it.each([
    '我这条视频为什么没火',
    '帮我看看这个标题行不行',
    '请问小红书什么时候发比较好',
    '你觉得这个选题能做吗',
    '我们账号要不要转型',
  ])('「%s」→ 对话', (s) => {
    expect(looksLikeChat(s)).toBe(true);
  });

  it('🔒 疑问句形式的好标题不能被当成提问（那是选题，收录才对）', () => {
    expect(looksLikeChat('为什么年轻人不买房了？')).toBe(false);
    expect(looksLikeChat('露营装备测评')).toBe(false);
    expect(looksLikeChat('三招搞定短视频开头')).toBe(false);
  });
});

describe('handleInbound · 对话', () => {
  it('/问 → 走对话，且绝不落成选题', async () => {
    await withAccount();
    const spy = await mockLlm('开头三秒放冲突。');
    const reply = await handleInbound('w1', '/问 短视频开头怎么写', CTX);
    expect(reply).toContain('开头三秒');
    expect(spy).toHaveBeenCalled();
    expect(await prisma.topicIdea.count()).toBe(0);
  });

  it('自然语言问句（含人称）→ 对话，不加「听懂为」前缀', async () => {
    await withAccount();
    await mockLlm('因为你的完播率偏低。');
    const reply = await handleInbound('w1', '我这条视频为什么没火', CTX);
    expect(reply).toContain('完播率');
    expect(reply).not.toContain('听懂为');
    expect(await prisma.topicIdea.count()).toBe(0);
  });

  it('🔒 普通选题文本仍按老行为收录（对话没抢走收录）', async () => {
    await withAccount();
    await mockLlm();
    const reply = await handleInbound('w1', '露营装备测评', CTX);
    expect(reply).toContain('已收录');
    expect(await prisma.topicIdea.count({ where: { accountId: 'a1' } })).toBe(1);
  });

  it('多轮：第二问带上了第一轮的上下文', async () => {
    await withAccount();
    const spy = await mockLlm('答案一');
    await handleInbound('w1', '/问 第一个问题', CTX);

    spy.mockResolvedValue({
      text: '答案二', mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
    } as any);
    await handleInbound('w1', '/问 那第二条呢', CTX);

    const messages = spy.mock.calls[spy.mock.calls.length - 1][2] as { role: string; content: string }[];
    expect(messages.map((m) => m.content).join('\n')).toContain('第一个问题');
    expect(messages.map((m) => m.content).join('\n')).toContain('答案一');

    const row = await prisma.botConversation.findFirst({ where: { integrationId: 'bi1', chatId: 'oc_1' } });
    expect(JSON.parse(row!.turns)).toHaveLength(4); // 两问两答
  });

  it('上下文只留最近若干轮，不无限膨胀', async () => {
    await withAccount();
    await mockLlm('答');
    for (let i = 0; i < 6; i++) await handleInbound('w1', `/问 第${i}问`, CTX);
    const row = await prisma.botConversation.findFirst({ where: { integrationId: 'bi1', chatId: 'oc_1' } });
    expect(JSON.parse(row!.turns).length).toBeLessThanOrEqual(MAX_TURNS);
  });

  it('🔒 静默超过 TTL → 视为新会话，不接旧话茬', async () => {
    await prisma.botConversation.create({
      data: {
        workspaceId: 'w1', integrationId: 'bi1', chatId: 'oc_1',
        turns: JSON.stringify([{ role: 'user', content: '很久以前的问题' }]),
        turnsAt: new Date(Date.now() - BOT_CHAT_TTL_MS - 1000),
      },
    });
    const state = await loadConversation({ workspaceId: 'w1', integrationId: 'bi1', chatId: 'oc_1' });
    expect(state.turns).toEqual([]);
  });

  it('/重置 → 清掉上下文（账号绑定保留）', async () => {
    await withAccount();
    await mockLlm('答');
    await handleInbound('w1', '/问 一个问题', CTX);
    await handleInbound('w1', '/账号 测试号', CTX);
    const reply = await handleInbound('w1', '/重置', CTX);
    expect(reply).toContain('全新一轮');
    const state = await loadConversation({ workspaceId: 'w1', integrationId: 'bi1', chatId: 'oc_1' });
    expect(state.turns).toEqual([]);
    expect(state.accountId).toBe('a1'); // 绑定不受影响
  });

  it('缺会话信息（无 integrationId/chatId）→ 照常回答，只是不记上下文', async () => {
    await withAccount();
    await mockLlm('照常回答');
    const reply = await handleInbound('w1', '/问 在吗');
    expect(reply).toContain('照常回答');
    expect(await prisma.botConversation.count()).toBe(0);
  });

  it('🔒 AI 降级/Mock → 必须标注是示例，不能被当成结论', async () => {
    await withAccount();
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw, 'llmComplete').mockResolvedValue({
      text: '示例内容', mocked: true, degraded: true, promptTokens: 0, completionTokens: 0, model: 'mock', provider: 'mock',
    } as any);
    const reply = await handleInbound('w1', '/问 怎么涨粉', CTX);
    expect(reply).toContain('示例');
  });

  it('配额超限 → 原样告诉用户，不抛异常也不假装回答', async () => {
    await withAccount();
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw, 'llmComplete').mockRejectedValue(new Error('本月 AI 配额已用完'));
    const reply = await handleInbound('w1', '/问 怎么涨粉', CTX);
    expect(reply).toContain('配额');
  });

  it('没有账号也能聊（不拿「先建账号」把人挡在门外）', async () => {
    await mockLlm('也能答');
    const reply = await handleInbound('w1', '/问 怎么起号', CTX);
    expect(reply).toContain('也能答');
  });
});

describe('handleInbound · 本群当前账号', () => {
  it('/账号 名字 → 绑定，之后收录挂到它名下', async () => {
    await withAccount('a1', '甲号');
    await withAccount('a2', '乙号');

    const bind = await handleInbound('w1', '/账号 乙号', CTX);
    expect(bind).toContain('乙号');

    await handleInbound('w1', '露营装备测评', CTX);
    const topic = await prisma.topicIdea.findFirst();
    expect(topic?.accountId).toBe('a2'); // 🔒 归属：不是「第一个活跃账号」
  });

  it('/账号 不带参数 → 报告现状与可选项', async () => {
    await withAccount('a1', '甲号');
    await withAccount('a2', '乙号');
    const reply = await handleInbound('w1', '/账号', CTX);
    expect(reply).toContain('甲号');
    expect(reply).toContain('乙号');
  });

  it('🔒 多账号未绑定 + /分析 → 要求指定，绝不替用户猜', async () => {
    await withAccount('a1', '甲号');
    await withAccount('a2', '乙号');
    const reply = await handleInbound('w1', '/分析', CTX);
    expect(reply).toContain('不替你猜');
    expect(reply).toContain('甲号');
  });

  it('/分析 账号名 → 按名字定位（名字写错时给出可选项）', async () => {
    await withAccount('a1', '甲号');
    await withAccount('a2', '乙号');
    const reply = await handleInbound('w1', '/分析 不存在的号', CTX);
    expect(reply).toContain('没找到');
    expect(reply).toContain('甲号');
  });

  it('绑定的账号被停用 → 退回下一档而不是写进无人可见的孤儿记录', async () => {
    await withAccount('a1', '甲号');
    await handleInbound('w1', '/账号 甲号', CTX);
    await prisma.creatorAccount.update({ where: { id: 'a1' }, data: { status: 'archived' } });
    await withAccount('a2', '乙号');

    await handleInbound('w1', '露营装备测评', CTX);
    const topic = await prisma.topicIdea.findFirst();
    expect(topic?.accountId).toBe('a2');
  });
});
