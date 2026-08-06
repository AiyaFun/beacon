import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { loadExemplars, renderExemplarBlock, buildAccountContext } from '@/lib/account-context';

// 风格原句样本（few-shot）。锁四件事：
// 1) 取样优先级：手动指定的文风样本 > 发过的正文 > 自己改定的终稿；
// 2) 太短的不要（看不出文风）、同一篇不要喂两遍；
// 3) 同平台优先（拿知乎长文教模型写抖音口播是帮倒忙）；
// 4) 指令里必须写死「只学怎么说，不要抄内容」——否则模型会把样本里的经历当成用户的经历。

const LONG_A = '我上周把跟了三年的老客户砍了。不是吵架，是算了笔账。他一年给我的钱抵不上我熬的夜。砍完那晚我睡得特别好，真的。'.repeat(2);
const LONG_B = '很多人问我怎么定价。我的答案很不体面：先报一个我自己都觉得贵的数，然后闭嘴。谁先说话谁输，这是我交了十几万学费换来的。'.repeat(2);
const LONG_C = '第三段样本，用来验证条数上限与去重逻辑，内容需要足够长才会被收进样本池里去。'.repeat(3);

describe('风格原句样本', () => {
  let workspaceId = '';
  let accountId = '';

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'exemplar-test' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
    const account = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'a', platform: 'douyin', personaCard: '{}', styleFingerprint: '{}' },
    });
    workspaceId = ws.id;
    accountId = account.id;
  });

  afterAll(async () => {
    await prisma.draftVersion.deleteMany({ where: { draft: { accountId } } });
    await prisma.draft.deleteMany({ where: { accountId } });
    await prisma.publishRecord.deleteMany({ where: { accountId } });
    await prisma.material.deleteMany({ where: { accountId } });
    await prisma.creatorAccount.deleteMany({ where: { id: accountId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.tenant.deleteMany({ where: { name: 'exemplar-test' } });
  });

  it('什么都没有时整块缺席（绝不注入占位噪声）', async () => {
    expect(await loadExemplars(accountId)).toEqual([]);
    expect(renderExemplarBlock([])).toBe('');
  });

  it('发过的正文会被当样本，太短的不要', async () => {
    await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', title: '短的', contentText: '太短了', metrics: JSON.stringify({ views: 999 }) },
    });
    await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', title: '长的', contentText: LONG_A, metrics: JSON.stringify({ views: 100 }) },
    });
    const list = await loadExemplars(accountId, 'douyin');
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('published');
    expect(list[0].label).toContain('长的');
  });

  it('同平台优先：指定平台时不会串进别的平台的文风', async () => {
    await prisma.publishRecord.create({
      data: { accountId, platform: 'zhihu', title: '知乎长文', contentText: LONG_B, metrics: JSON.stringify({ views: 99999 }) },
    });
    const dy = await loadExemplars(accountId, 'douyin');
    expect(dy.every((e) => !e.label.includes('知乎'))).toBe(true);
    const zh = await loadExemplars(accountId, 'zhihu');
    expect(zh[0].label).toContain('知乎长文');
  });

  it('手动指定的文风样本排在最前，并可与发布正文共存', async () => {
    await prisma.material.create({ data: { accountId, type: 'sample', content: LONG_C, tags: '[]' } });
    const list = await loadExemplars(accountId, 'douyin', 3);
    expect(list[0].source).toBe('sample');
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('人工终稿兜底，且同一篇不会被喂两遍', async () => {
    const draft = await prisma.draft.create({ data: { accountId, title: '手改稿', platform: 'douyin' } });
    // 与已发布的那篇同文：应被去重，不会既作为 published 又作为 human_draft 出现
    await prisma.draftVersion.create({ data: { draftId: draft.id, seq: 1, authorType: 'human', content: LONG_A } });
    const list = await loadExemplars(accountId, 'douyin', 5);
    const prefixes = list.map((e) => e.text.slice(0, 40));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('条数与单条长度都有上限（一条不能吃掉整个预算）', async () => {
    const list = await loadExemplars(accountId, 'douyin', 2);
    expect(list.length).toBeLessThanOrEqual(2);
    expect(list.every((e) => e.text.length <= 600)).toBe(true);
  });

  it('指令写死「学语感、不抄内容」——防模型把样本里的经历当用户的经历', () => {
    const block = renderExemplarBlock([{ source: 'sample', label: '我指定的代表作', text: LONG_C }]);
    expect(block).toContain('怎么说');
    expect(block).toContain('一个字都不要搬进来');
  });

  it('预算吃紧时原句样本比风格指纹先保（标签是有损压缩，原句不是）', async () => {
    const account = {
      personaCard: JSON.stringify({ identity: '教练' }),
      styleFingerprint: JSON.stringify({ voice: [{ tag: '幽默', score: 0.8, count: 1 }], format: [], topic: [] }),
    };
    const blocks = ['persona', 'fingerprint', 'exemplar'] as const;
    const full = await buildAccountContext({ workspaceId, accountId, platform: 'douyin', blocks: [...blocks], account });
    // 预算恰好只装得下人设 + 原句样本：谁被丢掉完全由 KEEP_PRIORITY 决定
    const budget = full.parts.persona!.length + full.parts.exemplar!.length + 4;
    const tight = await buildAccountContext({ workspaceId, accountId, platform: 'douyin', blocks: [...blocks], account, maxChars: budget });
    expect(tight.text).toContain('原文样本');
    expect(tight.text).not.toContain('风格指纹');
  });
});
