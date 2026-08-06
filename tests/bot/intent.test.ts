import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { matchPhrase, classifyIntent } from '@/lib/bot/intent';
import { handleInbound } from '@/lib/bot/router';

// 自然语言 → 指令。
// 这里最该守住的不是「认得多准」，而是「认不准时不要乱执行」——
// 兜底一律 ingest（只进候选池，无副作用），那是这个功能上线前的老行为。

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.hotItem.deleteMany({});
  await prisma.competitorAccount.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
});
afterEach(() => vi.restoreAllMocks());

async function withAccount() {
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' } });
}

describe('matchPhrase · 确定性短语（免费、瞬时、不过 LLM）', () => {
  it.each(['今天有什么热点', '看看热榜', '有热点吗', '热榜', '最近有啥热搜'])('「%s」→ hot', (s) => {
    expect(matchPhrase(s)).toEqual({ cmd: 'hot' });
  });

  it.each(['帮助', '你能做什么', '怎么用', '有哪些指令'])('「%s」→ help', (s) => {
    expect(matchPhrase(s)).toEqual({ cmd: 'help' });
  });

  it.each(['优化', '跑一次优化', '触发优化'])('「%s」→ optimize', (s) => {
    expect(matchPhrase(s)).toEqual({ cmd: 'optimize' });
  });

  it('🔒 含关键词但本身是选题的句子，不能被裸关键词误伤', () => {
    // 这几句都含「热点」「优化」，但它们是内容点子，不是在向助手提要求
    expect(matchPhrase('秋季穿搭热点盘点')).toBeNull();
    expect(matchPhrase('小红书笔记怎么做优化')).toBeNull();
    expect(matchPhrase('热点事件营销的三个坑')).toBeNull();
  });

  it('普通选题文本 → 不匹配任何短语', () => {
    expect(matchPhrase('露营装备测评')).toBeNull();
  });
});

describe('classifyIntent · LLM 兜底与安全默认', () => {
  it('LLM 降级/Mock（测试与零配置环境的常态）→ 一律 ingest，不乱执行', async () => {
    // 测试环境本来就走 Mock provider，这里断言的是「Mock 结果不被当真」
    expect(await classifyIntent('w1', '随便说点什么内容点子')).toEqual({ cmd: 'ingest' });
  });

  it('工作区不存在 → ingest，不抛异常', async () => {
    expect(await classifyIntent('不存在的ws', '今天天气')).toEqual({ cmd: 'ingest' });
  });

  it('LLM 说 hot 且置信度够 → 采纳', async () => {
    vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete').mockResolvedValue({
      text: JSON.stringify({ cmd: 'hot', confidence: 0.9 }),
      mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
    } as any);
    expect(await classifyIntent('w1', '给我看看现在什么最火')).toEqual({ cmd: 'hot' });
  });

  it('🔒 置信度不足 → 退回 ingest（宁可少认，不可乱执行）', async () => {
    vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete').mockResolvedValue({
      text: JSON.stringify({ cmd: 'crawl', arg: 'x', confidence: 0.3 }),
      mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
    } as any);
    expect(await classifyIntent('w1', '模糊的一句话')).toEqual({ cmd: 'ingest' });
  });

  it('🔒 LLM 返回未知指令 → 退回 ingest（不因模型乱编就执行未知操作）', async () => {
    vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete').mockResolvedValue({
      text: JSON.stringify({ cmd: 'publish', confidence: 0.99 }),
      mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
    } as any);
    expect(await classifyIntent('w1', '发布出去')).toEqual({ cmd: 'ingest' });
  });

  it('🔒 LLM 返回非 JSON → 退回 ingest', async () => {
    vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete').mockResolvedValue({
      text: '我觉得应该看热榜',
      mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
    } as any);
    expect(await classifyIntent('w1', 'x')).toEqual({ cmd: 'ingest' });
  });

  it('🔒 LLM 抛错（如配额超限）→ 退回 ingest，不把收录功能一起弄挂', async () => {
    vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete').mockRejectedValue(new Error('quota exceeded'));
    expect(await classifyIntent('w1', 'x')).toEqual({ cmd: 'ingest' });
  });

  it('topic 意图缺 arg → 退回 ingest（没标题就收录不了，别报错）', async () => {
    vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete').mockResolvedValue({
      text: JSON.stringify({ cmd: 'topic', arg: '', confidence: 0.9 }),
      mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
    } as any);
    expect(await classifyIntent('w1', 'x')).toEqual({ cmd: 'ingest' });
  });
});

describe('handleInbound · 自然语言走通', () => {
  it('「今天有什么热点」→ 走热榜，且明确标注是猜的', async () => {
    await prisma.hotItem.create({ data: { source: 'weibo', rank: 1, title: '某热点事件', heat: 99 } });
    const reply = await handleInbound('w1', '今天有什么热点');
    expect(reply).toContain('当前热榜');
    expect(reply).toContain('某热点事件');
    expect(reply).toContain('听懂为');
    expect(await prisma.topicIdea.count()).toBe(0); // 不该顺手收录一条
  });

  it('「你能做什么」→ 返回帮助', async () => {
    expect(await handleInbound('w1', '你能做什么')).toContain('可用指令');
  });

  it('🔒 斜杠指令不受 LLM 影响（即便 LLM 乱答也照常执行）', async () => {
    vi.spyOn(await import('@/lib/llm/gateway'), 'llmComplete').mockResolvedValue({
      text: JSON.stringify({ cmd: 'crawl', arg: 'evil', confidence: 0.99 }),
      mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
    } as any);
    await withAccount();
    const reply = await handleInbound('w1', '/选题 秋季穿搭');
    expect(reply).toContain('精排');
    expect((await prisma.topicIdea.findFirst())?.title).toBe('秋季穿搭');
  });

  it('普通选题文本 → 仍按老行为收录（没被意图识别抢走）', async () => {
    await withAccount();
    const reply = await handleInbound('w1', '露营装备测评');
    expect(reply).toContain('已收录');
    expect(reply).not.toContain('听懂为');
    expect(await prisma.topicIdea.count({ where: { accountId: 'a1' } })).toBe(1);
  });
});
