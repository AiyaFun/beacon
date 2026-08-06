import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 分片5：把「按设计拒绝」错误（配额用尽 QuotaExceededError / 权限不足 RbacError）在 action 层
// 转成结构化返回，而不是裸抛到 Next 15 的 error boundary（生产会脱敏 message、冲掉配额自救文案）。
//
// 真 SQLite、不 mock prisma。只桩掉两个 LLM 边界：
//   - '@/lib/llm/gateway'.llmComplete（studio / assistant 直调）
//   - '@/lib/pipeline'.generateRecommendations（topics / home 经它调 LLM）
// 抛出的 QuotaExceededError 用**真类**（import('@/lib/quota')），确保 action 里的 instanceof 命中同一份定义。

let ROLE = 'owner';
const mkSession = () => ({
  memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: ROLE, plan: 'free',
});
vi.mock('@/lib/session', () => ({ getSession: async () => mkSession(), getSessionOrNull: async () => mkSession() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// home 的 app/(app)/actions.ts 顶部 import 了 next/headers、next/navigation（本测试不触达其消费者，桩成空壳即可导入）
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); } }));

const h = vi.hoisted(() => ({
  llm: 'ok' as 'ok' | 'quota' | 'generic',
  gen: 'ok' as 'ok' | 'quota' | 'generic',
  // 真实配额文案（含「设置 · 模型接入」自救指引）——正是生产脱敏会冲掉的那句
  quotaMsg: '本月 AI 调用额度已用尽（30 次/月）。可升级套餐，或在「设置 · 模型接入」配置自己的 API Key。',
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    if (h.llm === 'quota') {
      const { QuotaExceededError } = await import('@/lib/quota');
      throw new QuotaExceededError(h.quotaMsg);
    }
    if (h.llm === 'generic') throw new Error('provider 500：内部堆栈不该泄露给用户');
    return { text: 'hi', provider: 'mock', model: 'mock', mocked: true };
  },
  resolveProvider: async () => ({ mocked: true, name: 'mock' }),
}));

vi.mock('@/lib/pipeline', () => ({
  ingestHot: async () => ({ inserted: 0, degraded: [] }),
  crawlCompetitors: async () => ({ posts: 0, accounts: 0, degraded: false }),
  clusterHotTopics: async () => ({ clusters: 0, sensitive: 0, skippedLatin: 0, mode: 'lexical-degraded', reviewed: 'lexicon' }),
  generateRecommendations: async () => {
    if (h.gen === 'quota') {
      const { QuotaExceededError } = await import('@/lib/quota');
      throw new QuotaExceededError(h.quotaMsg);
    }
    if (h.gen === 'generic') throw new Error('pipeline 内部错误：不该泄露');
    return { created: 3 };
  },
}));

const studio = await import('@/app/(app)/studio/actions');
const assistant = await import('@/app/(app)/assistant/actions');
const topics = await import('@/app/(app)/topics/actions');
const home = await import('@/app/(app)/actions');

let draftId = '';
beforeEach(async () => {
  ROLE = 'owner';
  h.llm = 'ok';
  h.gen = 'ok';
  await prisma.draftVersion.deleteMany({});
  await prisma.draft.deleteMany({});
  await prisma.creatorAccount.deleteMany({});
  await prisma.workspace.deleteMany({});
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '测试租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: '主工作区' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin', personaCard: '{}' } });
  const d = await prisma.draft.create({ data: { accountId: 'a1', title: '测试草稿', platform: 'douyin', status: 'editing' } });
  await prisma.draftVersion.create({ data: { draftId: d.id, seq: 1, authorType: 'ai', content: '一段用于改写与优化的正文内容，足够长。' } });
  draftId = d.id;
});

describe('配额用尽 → 结构化返回（不抛到 boundary），自救文案原样保留', () => {
  it('studio.actRewrite：命中配额 → { error } 且带完整自救文案，不抛', async () => {
    h.llm = 'quota';
    const r = await studio.actRewrite('要改写的正文', 'douyin');
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toBe(h.quotaMsg);
      expect(r.error).toContain('设置 · 模型接入'); // 自救指引没被截断/脱敏
    }
    expect('rewritten' in r).toBe(false);
  });

  it('studio.actCoachOptimize：命中配额 → { error }，不抛', async () => {
    h.llm = 'quota';
    const r = await studio.actCoachOptimize('要优化的正文足够长足够长足够长。', 'douyin');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('设置 · 模型接入');
  });

  it('studio.actDraft：命中配额 → { ok:false, error }，不抛', async () => {
    h.llm = 'quota';
    const r = await studio.actDraft(draftId);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('设置 · 模型接入');
  });

  it('topics.actGenerate：命中配额 → { ok:false, error }，不抛', async () => {
    h.gen = 'quota';
    const r = await topics.actGenerate();
    expect('ok' in r && r.ok === false).toBe(true);
    if ('ok' in r && r.ok === false) expect(r.error).toContain('设置 · 模型接入');
  });

  it('home.actGenerateRecommendations：命中配额 → { ok:false, error }，不抛', async () => {
    h.gen = 'quota';
    const r = await home.actGenerateRecommendations();
    expect('ok' in r && r.ok === false).toBe(true);
    if ('ok' in r && r.ok === false) expect(r.error).toContain('设置 · 模型接入');
  });

  it('assistant.actAsk：命中配额 → { answer:"", error }，不抛，Chat 可渲染 error 字段', async () => {
    h.llm = 'quota';
    const r = await assistant.actAsk('帮我想选题', []);
    expect(r.answer).toBe('');
    expect(r.error).toContain('设置 · 模型接入');
    expect(r.mocked).toBe(false);
  });
});

describe('权限不足（RbacError）', () => {
  it('assistant.actAsk：viewer → 结构化 { error 含「权限不足」}（Chat 内联展示，不脱敏）', async () => {
    ROLE = 'viewer';
    const r = await assistant.actAsk('帮我想选题', []);
    expect(r.answer).toBe('');
    expect(r.error).toContain('权限不足');
  });

  // 契约保持：studio 的按钮动作 RBAC 守卫仍**直接抛**（requireRole 在 try 外），
  // 与 tests/compliance/export-chain.test.ts 的既有断言一致——不因本次改动被改成结构化返回。
  it('studio.actRewrite / actDraft / actCoachOptimize：viewer → 仍抛「权限不足」', async () => {
    ROLE = 'viewer';
    await expect(studio.actRewrite('正文', 'douyin')).rejects.toThrow('权限不足');
    await expect(studio.actDraft(draftId)).rejects.toThrow('权限不足');
    await expect(studio.actCoachOptimize('正文足够长足够长足够长。', 'douyin')).rejects.toThrow('权限不足');
  });

  it('topics.actGenerate / home.actGenerateRecommendations：viewer → 仍抛「权限不足」', async () => {
    ROLE = 'viewer';
    await expect(topics.actGenerate()).rejects.toThrow('权限不足');
    await expect(home.actGenerateRecommendations()).rejects.toThrow('权限不足');
  });
});

describe('非「按设计拒绝」的异常照旧抛给 boundary（不被结构化吞掉）', () => {
  it('llmComplete 抛普通错误 → actRewrite / actAsk 继续抛', async () => {
    h.llm = 'generic';
    await expect(studio.actRewrite('正文', 'douyin')).rejects.toThrow('不该泄露');
    await expect(assistant.actAsk('帮我想选题', [])).rejects.toThrow('不该泄露');
  });

  it('generateRecommendations 抛普通错误 → actGenerate 继续抛', async () => {
    h.gen = 'generic';
    await expect(topics.actGenerate()).rejects.toThrow('不该泄露');
  });
});

describe('成功路径不受影响（结构化改造没动 happy path）', () => {
  it('assistant.actAsk：正常返回 { answer, mocked }，无 error 字段', async () => {
    const r = await assistant.actAsk('帮我想选题', []);
    expect(r.answer).toBe('hi');
    expect(r.mocked).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('topics.actGenerate / home.actGenerateRecommendations：正常返回 { created }', async () => {
    const r1 = await topics.actGenerate();
    expect(r1).toEqual({ created: 3 });
    const r2 = await home.actGenerateRecommendations();
    expect(r2).toEqual({ created: 3 });
  });
});
