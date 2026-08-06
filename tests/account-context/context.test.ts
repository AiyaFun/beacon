import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { buildAccountContext, accountBaselineBlock, competitorContextBlock } from '@/lib/account-context';

// 统一账号上下文构造器（方案一期基建）。锁三件事：
// 1) 只组合请求到的块，缺数据的块返回空串（绝不注入占位噪声）；
// 2) 预算裁剪按保留优先级丢块，人设永远保留；
// 3) baseline / competitor 块随真实数据出现。

describe('账号上下文构造器', () => {
  let workspaceId = '';
  let accountId = '';

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'ctx-test' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
    const account = await prisma.creatorAccount.create({
      data: {
        workspaceId: ws.id,
        name: 'a',
        platform: 'douyin',
        personaCard: JSON.stringify({
          identity: '健身教练', audience: '上班族', valueProp: '把训练讲明白',
          niche: '健身', canDo: ['增肌'], cantDo: [], tone: '干货', platforms: ['douyin'],
        }),
        styleFingerprint: JSON.stringify({
          voice: [{ tag: '幽默', score: 0.8, count: 2 }],
          format: [],
          topic: [{ tag: '增肌干货', score: 0.6, count: 1 }],
        }),
      },
    });
    workspaceId = ws.id;
    accountId = account.id;
    await prisma.material.create({
      data: { accountId, type: 'experience', content: '自己三个月增肌10斤的真实经历', tags: '[]' },
    });
  });

  afterAll(async () => {
    await prisma.material.deleteMany({ where: { accountId } });
    await prisma.publishRecord.deleteMany({ where: { accountId } });
    await prisma.creatorAccount.deleteMany({ where: { id: accountId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.tenant.deleteMany({ where: { name: 'ctx-test' } });
  });

  it('只组合请求的块，未请求的块不出现', async () => {
    const ctx = await buildAccountContext({
      workspaceId, accountId, blocks: ['persona', 'fingerprint', 'material'],
    });
    expect(ctx.text).toContain('【账号人设】');
    expect(ctx.text).toContain('【风格指纹】');
    expect(ctx.text).toContain('【素材库】');
    expect(ctx.text).not.toContain('数据基线'); // 没请求 baseline
    expect(ctx.persona.niche).toBe('健身');
    expect(ctx.fingerprint.voice[0].tag).toBe('幽默');
  });

  it('缺数据的块返回空串，不注入占位噪声', async () => {
    // 请求 baseline/competitor 但账号无发布数据、工作区无订阅竞对 → 全空
    const ctx = await buildAccountContext({ workspaceId, accountId, blocks: ['baseline', 'competitor'] });
    expect(ctx.text).toBe('');
    expect(ctx.parts.baseline).toBe('');
    expect(ctx.parts.competitor).toBe('');
  });

  it('预算裁剪：超预算丢低优先级块，人设永远保留', async () => {
    const ctx = await buildAccountContext({
      workspaceId, accountId, blocks: ['persona', 'fingerprint', 'material'], maxChars: 30,
    });
    expect(ctx.text).toContain('【账号人设】'); // persona 最高保留优先级
    expect(ctx.text).not.toContain('【素材库】'); // material 优先级最低，预算吃紧被丢
  });

  it('baseline 块随真实发布数据出现（跨平台画像）', async () => {
    await prisma.publishRecord.create({
      data: {
        accountId, platform: 'douyin', title: 't', platformItemId: 'pi-ctx-1',
        metrics: JSON.stringify({ views: 10000, likes: 500, comments: 50 }),
      },
    });
    const block = await accountBaselineBlock(accountId);
    expect(block).toContain('抖音');
    expect(block).toContain('均播放');
  });

  it('accountId 已握有账号记录时不重复查库（account 直传）', async () => {
    const ctx = await buildAccountContext({
      workspaceId, accountId,
      account: { personaCard: '{}', styleFingerprint: '{}' },
      blocks: ['persona'],
    });
    // 直传空账号 → persona 块用兜底空人设，字段齐全不炸
    expect(ctx.persona.canDo).toEqual([]);
    expect(ctx.text).toContain('【账号人设】');
  });
});
