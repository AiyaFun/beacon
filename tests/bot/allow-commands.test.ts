import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { handleInbound } from '@/lib/bot/router';
import { isCommandAllowed, sanitizeAllowCommands, TOGGLEABLE_COMMANDS } from '@/lib/bot/types';

// 入站命令白名单：机器人装在群里，`/分析` 会把粉丝数播放量摊给群里所有人、`/问` 会烧配额，
// 该放开哪些由管理员（owner/admin，与密钥同级）决定。
//
// 这套用例最该守住的是**空数组的语义**：线上老数据 allowCommands 全是 "[]"，
// 把空当成「全关」会让所有已装机器人在一次发版后集体哑掉，且不报任何错。

const CTX = { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1' };

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.hotItem.deleteMany({});
  await prisma.competitorAccount.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' } });
});
afterEach(() => vi.restoreAllMocks());

async function withBot(allowCommands: string[] | null) {
  await prisma.botIntegration.create({
    data: {
      id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x',
      pushEvents: '[]', allowCommands: JSON.stringify(allowCommands ?? []),
    },
  });
}

async function mockLlm(text = '回答') {
  const gw = await import('@/lib/llm/gateway');
  return vi.spyOn(gw, 'llmComplete').mockResolvedValue({
    text, mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x',
  } as any);
}

describe('isCommandAllowed · 空数组的语义（老数据兼容）', () => {
  it('🔒 空 = 从未配置 = 全开（绝不能理解成全关，那会让线上机器人集体哑掉）', () => {
    for (const c of TOGGLEABLE_COMMANDS) expect(isCommandAllowed(c.key, [])).toBe(true);
    expect(isCommandAllowed('analyze', null)).toBe(true);
    expect(isCommandAllowed('analyze', undefined)).toBe(true);
  });

  it('配过但全关 = ["help"] → 除 help 外全部拒绝', () => {
    expect(isCommandAllowed('help', ['help'])).toBe(true);
    for (const c of TOGGLEABLE_COMMANDS) expect(isCommandAllowed(c.key, ['help'])).toBe(false);
  });

  it('🔒 help 恒开：全关时机器人至少还能自报家门，不做不响的黑箱', () => {
    expect(isCommandAllowed('help', [])).toBe(true);
    expect(isCommandAllowed('help', ['chat'])).toBe(true);
  });

  it('只勾了 chat → 只有 chat 通过', () => {
    expect(isCommandAllowed('chat', ['help', 'chat'])).toBe(true);
    expect(isCommandAllowed('analyze', ['help', 'chat'])).toBe(false);
  });

  it('sanitize 丢掉不认识的 key，并去重', () => {
    expect(sanitizeAllowCommands(['chat', 'chat', 'publish', 'rm -rf', 'hot'])).toEqual(['chat', 'hot']);
    expect(sanitizeAllowCommands('不是数组')).toEqual([]);
  });
});

describe('handleInbound · 白名单在群里真的拦得住', () => {
  it('🔒 关掉账号体检 → /分析 被拒，且一次 LLM 都不调（不烧配额、不外泄数据）', async () => {
    await withBot(['help', 'chat']);
    const spy = await mockLlm();
    const reply = await handleInbound('w1', '/分析', CTX);
    expect(reply).toContain('账号体检');
    expect(reply).toContain('没有开');
    expect(reply).toContain('管理员');
    expect(spy).not.toHaveBeenCalled();
  });

  it('🔒 关掉对话 → /问 被拒，不产生 LLM 调用', async () => {
    await withBot(['help', 'topic']);
    const spy = await mockLlm();
    const reply = await handleInbound('w1', '/问 怎么涨粉', CTX);
    expect(reply).toContain('群内对话');
    expect(reply).toContain('没有开');
    expect(spy).not.toHaveBeenCalled();
  });

  it('🔒 关掉收录 → 普通文本不入库（并提示还能怎么用）', async () => {
    await withBot(['help', 'chat']);
    await mockLlm();
    const reply = await handleInbound('w1', '露营装备测评', CTX);
    expect(reply).toContain('收录选题');
    expect(reply).toContain('/问');
    expect(await prisma.topicIdea.count()).toBe(0);
  });

  it('🔒 自然语言不能绕过白名单（斜杠拦住了、说人话就放行=白做）', async () => {
    await withBot(['help', 'chat']);
    await prisma.hotItem.create({ data: { source: 'weibo', rank: 1, title: '某热点', heat: 9 } });
    const reply = await handleInbound('w1', '今天有什么热点', CTX);
    expect(reply).toContain('没有开');
    expect(reply).not.toContain('某热点');
  });

  it('关掉竞对监控 → 主页链接不试采，改按选题收录（链接仍有归宿，回执说实话）', async () => {
    await withBot(['help', 'topic']);
    const reply = await handleInbound('w1', 'https://space.bilibili.com/123456', CTX);
    expect(reply).toContain('收录');
    expect(await prisma.watchlistItem.count()).toBe(0);
    expect(await prisma.topicIdea.count()).toBe(1);
  });

  it('/帮助 只列开着的，并说明哪些被管理员关了', async () => {
    await withBot(['help', 'chat', 'hot']);
    const reply = await handleInbound('w1', '/帮助', CTX);
    expect(reply).toContain('/热点');
    expect(reply).not.toContain('/采集');
    expect(reply).toContain('管理员在本群关闭了');
    expect(reply).toContain('账号体检');
  });

  it('全开（老数据 []）→ 各项照常可用，行为与上线前一致', async () => {
    await withBot([]);
    await prisma.hotItem.create({ data: { source: 'weibo', rank: 1, title: '某热点', heat: 9 } });
    expect(await handleInbound('w1', '/热点', CTX)).toContain('某热点');
    await handleInbound('w1', '露营装备测评', CTX);
    expect(await prisma.topicIdea.count()).toBe(1);
  });

  it('无 integrationId（单测直调/未接入渠道）→ 默认全开，不因缺上下文把功能锁死', async () => {
    await prisma.hotItem.create({ data: { source: 'weibo', rank: 1, title: '某热点', heat: 9 } });
    expect(await handleInbound('w1', '/热点')).toContain('某热点');
  });
});
