import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { RbacError } from '@/lib/rbac';
import { validatePersonaCard } from '@/lib/persona';

// F3-1 冷启动端到端：真跑 server action、真 SQLite、真 Mock LLM 通道。
// 只测纯函数发现不了这个模块最要命的失败模式：
//   「校验函数明明写好了，就是没人在扩写路径上调用它」——脏卡片照样进库。
// 所以这里跑完整 actExpandPersona / actSavePersona，然后去库里查到底写没写。

const session = {
  memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1',
  memberName: '张三', role: 'owner', plan: 'free',
};
let ROLE = 'owner';
vi.mock('@/lib/session', () => ({
  getSession: async () => ({ ...session, role: ROLE }),
  getSessionOrNull: async () => ({ ...session, role: ROLE }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actExpandPersona, actAskPersonaQuestions, actSavePersona } = await import('@/app/(app)/persona/actions');

beforeEach(async () => {
  ROLE = 'owner';
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '测试租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: '默认工作区' } });
  await prisma.creatorAccount.create({
    data: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin', personaCard: '{}' },
  });
});

const SENTENCE = '我是一个教普通人用 AI 工具接单做副业的博主';
const answers = (over: Partial<Record<string, string>> = {}) =>
  JSON.stringify([
    { key: 'what', question: '你打算持续输出什么内容？', answer: over.what ?? 'AI 工具实测与接单流程拆解', skipped: over.what === '' },
    { key: 'who', question: '你想讲给谁听？', answer: over.who ?? '想搞副业但没整块时间的职场新人', skipped: over.who === '' },
    { key: 'why', question: '凭什么是你？', answer: over.why ?? '自己用 AI 接单半年', skipped: over.why === '' },
  ]);

describe('Mock 通道（dev 态零基础设施）· actExpandPersona 能跑通且如实自报家门', () => {
  it('无任何模型 Key 时不报错、返回可用草稿，并标 mocked + degraded', async () => {
    const r = await actExpandPersona(SENTENCE, answers());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Mock 没有人设分支，返回的 {"reply":...} 必然过不了 schema → 走降级
    expect(r.draft.mocked).toBe(true);
    expect(r.draft.degraded).toBe(true);
    expect(r.draft.issues.length).toBeGreaterThan(0);
  });

  it('降级草稿的内容只来自用户自己的输入，没有 Mock 的占位文本混进来', async () => {
    const r = await actExpandPersona(SENTENCE, answers());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.card.identity).toBe(SENTENCE);
    expect(r.draft.card.audience).toBe('想搞副业但没整块时间的职场新人');
    // Mock 兜底文案的特征串一个都不许出现在人设卡里
    const dump = JSON.stringify(r.draft.card);
    expect(dump).not.toContain('Mock');
    expect(dump).not.toContain('热点匹配度');
    expect(dump).not.toContain('已理解你的需求');
  });

  it('扩写不写库 —— 用户逐项确认前，人设卡与版本表纹丝不动', async () => {
    await actExpandPersona(SENTENCE, answers());
    const acc = await prisma.creatorAccount.findUnique({ where: { id: 'a1' } });
    expect(acc?.personaCard).toBe('{}');
    expect(await prisma.personaVersion.count()).toBe(0);
    expect(await prisma.memoryEntry.count()).toBe(0);
  });

  it('一句话太短直接拒，不浪费一次 LLM 往返', async () => {
    const r = await actExpandPersona('嗯', answers());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('一句话');
  });

  it('追问通道也能跑通：Mock 下退回 PRD 标准三问并如实标 fallback', async () => {
    const r = await actAskPersonaQuestions(SENTENCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.questions.length).toBeGreaterThanOrEqual(3);
    expect(r.questions.length).toBeLessThanOrEqual(5);
    expect(r.mocked).toBe(true);
    expect(r.fallback).toBe(true); // 不假装这是 AI 针对用户那句话生成的追问
  });
});

describe('schema 闸门在真实调用路径上 · LLM 返回垃圾时不进库', () => {
  // 直接换掉 provider 的返回，模拟真实模型「不听话」的几种形态
  async function withLlmText(text: string) {
    const gw = await import('@/lib/llm/gateway');
    return vi.spyOn(gw.mock, 'complete').mockResolvedValue({
      text, provider: 'stub', model: 'stub-1', mocked: false,
      usage: { promptTokens: 1, completionTokens: 1 },
    });
  }

  it('模型返回散文 → 降级而非把散文塞进 identity', async () => {
    const spy = await withLlmText('好的！首先，你是一位非常优秀的创作者……');
    const r = await actExpandPersona(SENTENCE, answers());
    spy.mockRestore();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.degraded).toBe(true);
    expect(r.draft.card.identity).toBe(SENTENCE); // 用户原话，不是模型的散文
    expect(r.draft.card.identity).not.toContain('优秀的创作者');
  });

  it('模型返回字段空壳 JSON → 降级，空壳不进草稿', async () => {
    const spy = await withLlmText('{"identity":"","audience":"","valueProp":"","niche":"","tone":"","canDo":[],"cantDo":[],"platforms":[]}');
    const r = await actExpandPersona(SENTENCE, answers());
    spy.mockRestore();
    if (!r.ok) return;
    expect(r.draft.degraded).toBe(true);
  });

  it('模型返回合格卡片 → 正常采纳，不降级，且平台被白名单过滤', async () => {
    const spy = await withLlmText(JSON.stringify({
      identity: '教普通人用 AI 接单的博主',
      audience: '想搞副业的职场新人',
      valueProp: '把 AI 接单拆成可复制步骤',
      niche: 'AI 工具 / 副业',
      tone: '接地气，像朋友聊天',
      canDo: ['工具实测', '流程拆解'],
      cantDo: ['承诺收入', '荐股'],
      platforms: ['抖音', '豆瓣'], // 豆瓣不在白名单（快手 2026-08-19 已进白名单，不能再拿它举例）
    }));
    const r = await actExpandPersona(SENTENCE, answers());
    spy.mockRestore();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.degraded).toBe(false);
    expect(r.draft.mocked).toBe(false);
    expect(r.draft.card.identity).toBe('教普通人用 AI 接单的博主');
    expect(r.draft.card.platforms).toEqual(['douyin']);
    expect(validatePersonaCard(r.draft.card).ok).toBe(true);
  });

  it('第一次不合格、重试合格 → 采纳重试结果（修复重试真的接上了）', async () => {
    const gw = await import('@/lib/llm/gateway');
    const okCard = {
      identity: '重试后的身份', audience: '重试后的受众', valueProp: '重试后的价值主张',
      niche: '赛道', tone: '语气', canDo: ['能做一'], cantDo: ['不能做一'], platforms: [],
    };
    const spy = vi.spyOn(gw.mock, 'complete')
      .mockResolvedValueOnce({ text: '不是 JSON', provider: 'stub', model: 'stub-1', mocked: false })
      .mockResolvedValueOnce({ text: JSON.stringify(okCard), provider: 'stub', model: 'stub-1', mocked: false });
    const r = await actExpandPersona(SENTENCE, answers());
    expect(spy).toHaveBeenCalledTimes(2); // 必须先断言再 restore——mockRestore 会清掉调用记录
    spy.mockRestore();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.degraded).toBe(false);
    expect(r.draft.card.identity).toBe('重试后的身份');
  });

  it('两次都不合格 → 降级，绝不硬塞进库', async () => {
    const gw = await import('@/lib/llm/gateway');
    const spy = vi.spyOn(gw.mock, 'complete').mockResolvedValue({
      text: '还是不听话', provider: 'stub', model: 'stub-1', mocked: false,
    });
    const r = await actExpandPersona(SENTENCE, answers());
    spy.mockRestore();
    if (!r.ok) return;
    expect(r.draft.degraded).toBe(true);
    const acc = await prisma.creatorAccount.findUnique({ where: { id: 'a1' } });
    expect(acc?.personaCard).toBe('{}');
  });

  it('Mock 通道不做修复重试（确定性输出，重试只是白烧一次往返）', async () => {
    const gw = await import('@/lib/llm/gateway');
    const spy = vi.spyOn(gw.mock, 'complete');
    await actExpandPersona(SENTENCE, answers());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('保存路径 · 入库前最后一道清洗', () => {
  it('确认后保存：写人设卡 + 生成版本 + 写 persona 记忆', async () => {
    const r = await actSavePersona(JSON.stringify({
      identity: '博主', audience: '职场新人', valueProp: '讲清楚 AI 接单',
      niche: 'AI', tone: '接地气', canDo: ['实测'], cantDo: ['荐股'], platforms: ['douyin'],
    }));
    expect(r.ok).toBe(true);
    const acc = await prisma.creatorAccount.findUnique({ where: { id: 'a1' } });
    expect(JSON.parse(acc!.personaCard).identity).toBe('博主');
    expect(await prisma.personaVersion.count()).toBe(1);
    expect(await prisma.memoryEntry.count()).toBe(1);
  });

  it('脏数据从保存口也进不来：平台白名单 + 长度截断', async () => {
    await actSavePersona(JSON.stringify({
      identity: '啊'.repeat(500),
      platforms: ['douyin', '豆瓣', '<script>alert(1)</script>'],
      canDo: Array.from({ length: 50 }, (_, i) => `条${i}`),
    }));
    const acc = await prisma.creatorAccount.findUnique({ where: { id: 'a1' } });
    const card = JSON.parse(acc!.personaCard);
    expect(card.identity.length).toBe(120);
    expect(card.platforms).toEqual(['douyin']);
    expect(card.canDo.length).toBe(8);
  });

  it('非法 JSON 不炸 action（落回空卡）', async () => {
    const r = await actSavePersona('{不是 JSON');
    expect(r.ok).toBe(true);
  });
});

describe('RBAC · persona.edit 守卫挂在每个入口上', () => {
  it('viewer 不能 AI 扩写（这是烧 token 的写操作）', async () => {
    ROLE = 'viewer';
    await expect(actExpandPersona(SENTENCE, answers())).rejects.toThrow(RbacError);
  });

  it('viewer 不能触发 AI 追问', async () => {
    ROLE = 'viewer';
    await expect(actAskPersonaQuestions(SENTENCE)).rejects.toThrow(RbacError);
  });

  it('viewer 不能保存人设', async () => {
    ROLE = 'viewer';
    await expect(actSavePersona('{}')).rejects.toThrow(RbacError);
  });

  it('viewer 被拦时一次 LLM 都没调（守卫在网关之前）', async () => {
    ROLE = 'viewer';
    const gw = await import('@/lib/llm/gateway');
    const spy = vi.spyOn(gw.mock, 'complete');
    await expect(actExpandPersona(SENTENCE, answers())).rejects.toThrow(RbacError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('editor 可以扩写与保存', async () => {
    ROLE = 'editor';
    const r = await actExpandPersona(SENTENCE, answers());
    expect(r.ok).toBe(true);
    expect((await actSavePersona('{"identity":"编辑填的"}')).ok).toBe(true);
  });
});
