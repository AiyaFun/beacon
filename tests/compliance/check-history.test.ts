import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { invalidateDfaCache } from '@/lib/compliance/engine';

// 检测历史落库（ComplianceCheck）。
//
// 为什么要端到端跑 actCheck：这张表此前**只有读者没有写者**——billing 的「合规拦截」
// 计数永远是 0。这类缺陷不在任何单个函数里（checkText 本身是对的），
// 而在「没人在检测路径上把结果写下来」，只测 checkText 永远发现不了。
const session = {
  memberId: 'm1', tenantId: 't-chk', workspaceId: 'w-chk', accountId: 'a-chk',
  memberName: '张三', role: 'owner', plan: 'pro',
};
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// 语义复检要调 LLM，与本文件要验的落库无关，钉成空结果保持确定性
vi.mock('@/lib/compliance/semantic', () => ({ llmSemanticReview: async () => ({ hits: [], mocked: true }) }));

const { actCheck } = await import('@/app/(app)/compliance/actions');

async function mkDraft(accountId = session.accountId) {
  const tenant = await prisma.tenant.upsert({
    where: { id: session.tenantId }, update: {}, create: { id: session.tenantId, name: 'chk' },
  });
  await prisma.workspace.upsert({
    where: { id: session.workspaceId }, update: {},
    create: { id: session.workspaceId, tenantId: tenant.id, name: 'ws' },
  });
  await prisma.creatorAccount.upsert({
    where: { id: accountId }, update: {},
    create: { id: accountId, workspaceId: session.workspaceId, name: 'acc', platform: 'douyin' },
  });
  const d = await prisma.draft.create({ data: { accountId, title: 't', platform: 'douyin' } });
  return d.id;
}

beforeEach(async () => {
  await prisma.complianceCheck.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.sensitiveWord.deleteMany();
  invalidateDfaCache();
});

describe('actCheck · 检测历史落库', () => {
  it('命中 block 词 + 带 draftId → 落一条 riskLevel=block 的历史', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '国家级', tier: 'legal', action: 'block', category: 't', version: 't', enabled: true },
    });
    invalidateDfaCache();
    const draftId = await mkDraft();

    const r = await actCheck('我们是国家级品牌', 'douyin', draftId);
    expect(r.riskLevel).toBe('block');

    const rows = await prisma.complianceCheck.findMany({ where: { draftId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].riskLevel).toBe('block');
    expect(rows[0].platform).toBe('douyin');
    expect(JSON.parse(rows[0].hits)[0].word).toBe('国家级');
  });

  it('全部通过（pass）→ 不落库：战报要的是「拦了什么」，不是「点了几次检测」', async () => {
    const draftId = await mkDraft();
    const r = await actCheck('今天天气不错', 'douyin', draftId);
    expect(r.riskLevel).toBe('pass');
    expect(await prisma.complianceCheck.count({ where: { draftId } })).toBe(0);
  });

  it('不传 draftId（检测框里的临时文本）→ 不落库，绝不硬造假 draftId', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '国家级', tier: 'legal', action: 'block', category: 't', version: 't', enabled: true },
    });
    invalidateDfaCache();
    const r = await actCheck('我们是国家级品牌', 'douyin');
    expect(r.riskLevel).toBe('block'); // 检测结果照常返回
    expect(await prisma.complianceCheck.count()).toBe(0); // 但没有历史
  });

  it('🔒 draftId 不属于当前账号 → 不落库（防跨租户写入）', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '国家级', tier: 'legal', action: 'block', category: 't', version: 't', enabled: true },
    });
    invalidateDfaCache();
    const otherDraftId = await mkDraft('a-other'); // 另一个账号的草稿
    const r = await actCheck('我们是国家级品牌', 'douyin', otherDraftId);
    expect(r.riskLevel).toBe('block');
    expect(await prisma.complianceCheck.count({ where: { draftId: otherDraftId } })).toBe(0);
  });

  it('billing 的「合规拦截」计数能真的数到（此前恒为 0）', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '国家级', tier: 'legal', action: 'block', category: 't', version: 't', enabled: true },
    });
    invalidateDfaCache();
    const draftId = await mkDraft();
    await actCheck('国家级品牌', 'douyin', draftId);
    await actCheck('又一次国家级', 'douyin', draftId);

    // 与 app/(app)/billing/page.tsx 的产出账本同一条查询口径
    const blocked = await prisma.complianceCheck.count({
      where: { riskLevel: 'block', draft: { accountId: session.accountId } },
    });
    expect(blocked).toBe(2);
  });
});
