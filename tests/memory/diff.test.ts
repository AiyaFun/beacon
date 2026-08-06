import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { recordDiffPreference } from '@/lib/memory/diff';

// AI 初稿 vs 人工终稿的偏好沉淀。红线用例：Mock/解析失败时只写字数摘要，
// 编造的「偏好：」条目一条都不许进库；且函数无论内部炸成什么样都不向外 throw。

beforeEach(async () => {
  // 保证走 Mock 通道（dev 态零基础设施：无 key 即 Mock）
  delete process.env.BEACON_DEFAULT_LLM_BASE_URL;
  delete process.env.BEACON_DEFAULT_LLM_API_KEY;
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '测试租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: '默认工作区' } });
  await prisma.creatorAccount.create({
    data: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin', personaCard: '{}' },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const call = (aiDraft: string, humanFinal: string) =>
  recordDiffPreference({ tenantId: 't1', workspaceId: 'w1', accountId: 'a1', aiDraft, humanFinal });

const prefEntries = () =>
  prisma.memoryEntry.findMany({ where: { workspaceId: 'w1', content: { startsWith: '偏好：' } } });

// 把真实模型的返回换成指定文本（照 persona 测试的套路戳 mock provider）
async function withLlmText(text: string) {
  const gw = await import('@/lib/llm/gateway');
  return vi.spyOn(gw.mock, 'complete').mockResolvedValue({
    text, provider: 'stub', model: 'stub-1', mocked: false,
    usage: { promptTokens: 1, completionTokens: 1 },
  });
}

describe('Mock 兜底路径（dev 无 key 即天然 Mock）', () => {
  it('只写字数摘要，Mock 编的「偏好：」条目绝不进记忆', async () => {
    await call('稿'.repeat(100), '稿'.repeat(220));
    expect(await prefEntries()).toHaveLength(0);
    const all = await prisma.memoryEntry.findMany({ where: { workspaceId: 'w1' } });
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('人工在 AI 初稿基础上改稿：人工终稿：扩写 +120 字');
    expect(all[0].type).toBe('preference');
    expect(all[0].accountId).toBe('a1');
  });

  it('精简方向的摘要口径：负数带符号', async () => {
    await call('稿'.repeat(100), '稿'.repeat(70));
    const all = await prisma.memoryEntry.findMany({ where: { workspaceId: 'w1' } });
    expect(all).toHaveLength(1);
    expect(all[0].content).toContain('精简 -30 字');
  });
});

describe('解析失败兜底 · 真模型输出垃圾时同样只留字数摘要', () => {
  it.each([
    ['散文不是 JSON', '好的！我总结了三条偏好……'],
    ['JSON 但不是数组', '{"preferences":["偏好：删减语气词"]}'],
    ['数组但格式全不合规', '["删减语气词","偏好：","偏好：这条动作短语实在太长超过十二个字了",42]'],
  ])('%s', async (_name, text) => {
    const spy = await withLlmText(text);
    await call('初稿正文', '终稿正文改');
    // 确认真的走到了 LLM 这一步。注意：非 JSON 文本会触发网关的「json 解析失败重试一次再降级」
    // （lib/llm/gateway.ts），故调用次数可能 >1；本用例只关心「走到了 LLM 且最终只留字数摘要」。
    expect(spy).toHaveBeenCalled();
    expect(await prefEntries()).toHaveLength(0);
    const all = await prisma.memoryEntry.findMany({ where: { workspaceId: 'w1' } });
    expect(all).toHaveLength(1);
    expect(all[0].content).toContain('人工终稿：');
  });
});

describe('成功路径 · 合格条目逐条进记忆，不合格的静默过滤', () => {
  it('只收「偏好：<12 字内>」格式，最多 3 条，type=preference 带 accountId', async () => {
    await withLlmText(JSON.stringify([
      '偏好：删减语气词',
      '偏好：结论前置',
      '不带前缀的野生结论',
      '偏好：这条动作短语实在太长超过十二个字了',
    ]));
    await call('初稿正文', '终稿正文改');
    const prefs = await prefEntries();
    expect(prefs.map((p) => p.content).sort()).toEqual(['偏好：删减语气词', '偏好：结论前置']);
    for (const p of prefs) {
      expect(p.type).toBe('preference');
      expect(p.accountId).toBe('a1');
    }
    // 字数摘要照写（两层信号并存）
    const summary = await prisma.memoryEntry.findFirst({ where: { workspaceId: 'w1', content: { contains: '人工终稿：' } } });
    expect(summary).toBeTruthy();
  });

  it('同一偏好再次出现走去重累计（稳定措辞设计约定的落地验证）', async () => {
    await withLlmText('["偏好：删减语气词"]');
    await call('初稿正文', '终稿正文改');
    await call('初稿正文二', '终稿正文二改');
    const prefs = await prefEntries();
    expect(prefs).toHaveLength(1);
    expect(prefs[0].hitCount).toBe(2);
    expect(prefs[0].active).toBe(true); // 累计满 2 次生效
  });
});

describe('绝不向外 throw', () => {
  it('LLM 通道整个炸掉也不抛，且字数摘要已经落库', async () => {
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw.mock, 'complete').mockRejectedValue(new Error('通道炸了'));
    await expect(call('初稿正文', '终稿正文改')).resolves.toBeUndefined();
    const all = await prisma.memoryEntry.findMany({ where: { workspaceId: 'w1' } });
    expect(all).toHaveLength(1);
    expect(all[0].content).toContain('人工终稿：');
  });
});
