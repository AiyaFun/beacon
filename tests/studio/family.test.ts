import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { draftFamily, familyRootId, familyPlatforms } from '@/lib/studio/family';

// 稿件家族（一稿多平台）。锁三件事：
// 1) 血缘走 parentDraftId，从任一成员都能查到整个家族（不依赖 topicId——粘进来的稿子没有选题）；
// 2) 「已发布但没回流」与「表现为 0」必须分得开，否则对比卡会把前者画成后者；
// 3) 跨租户/跨账号不串。

describe('稿件家族', () => {
  let workspaceId = '';
  let accountId = '';
  let otherAccountId = '';
  let rootId = '';
  let childId = '';

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'family-test' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
    const a = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
    const b = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'b', platform: 'wechat' } });
    workspaceId = ws.id;
    accountId = a.id;
    otherAccountId = b.id;

    const root = await prisma.draft.create({ data: { accountId, title: '砍客户那件事', platform: 'douyin' } });
    const child = await prisma.draft.create({
      data: { accountId, title: '砍客户那件事', platform: 'xiaohongshu', parentDraftId: root.id },
    });
    rootId = root.id;
    childId = child.id;
  });

  afterAll(async () => {
    await prisma.publishRecord.deleteMany({ where: { accountId: { in: [accountId, otherAccountId] } } });
    await prisma.draft.deleteMany({ where: { accountId: { in: [accountId, otherAccountId] } } });
    await prisma.creatorAccount.deleteMany({ where: { id: { in: [accountId, otherAccountId] } } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.tenant.deleteMany({ where: { name: 'family-test' } });
  });

  it('从任一成员都能定位到同一个家族根', async () => {
    expect(await familyRootId(accountId, rootId)).toBe(rootId);
    expect(await familyRootId(accountId, childId)).toBe(rootId);
  });

  it('家族包含原稿与全部派生稿，原稿被标出来', async () => {
    const fam = await draftFamily(accountId, childId);
    expect(fam).toHaveLength(2);
    expect(fam.find((m) => m.isRoot)!.platform).toBe('douyin');
    expect(fam.map((m) => m.platform).sort()).toEqual(['douyin', 'xiaohongshu']);
  });

  it('已发布但未回流 ≠ 表现为 0', async () => {
    await prisma.publishRecord.create({
      data: { accountId, draftId: rootId, platform: 'douyin', title: 't', metrics: JSON.stringify({ views: 0 }) },
    });
    const fam = await draftFamily(accountId, rootId);
    const root = fam.find((m) => m.isRoot)!;
    expect(root.published).toBe(true);
    expect(root.metrics).toBeNull(); // 有记录但零播放 = 还没回流，不能当成扑街
  });

  it('有真实播放时给出 metrics', async () => {
    await prisma.publishRecord.create({
      data: { accountId, draftId: childId, platform: 'xiaohongshu', title: 't2', metrics: JSON.stringify({ views: 5200 }) },
    });
    const fam = await draftFamily(accountId, childId);
    expect(fam.find((m) => m.draftId === childId)!.metrics!.views).toBe(5200);
  });

  it('已有平台可查——派生时据此跳过，不重复建同平台兄弟稿', async () => {
    expect((await familyPlatforms(accountId, rootId)).sort()).toEqual(['douyin', 'xiaohongshu']);
  });

  it('别的账号查不到这个家族', async () => {
    expect(await familyRootId(otherAccountId, rootId)).toBeNull();
    expect(await draftFamily(otherAccountId, rootId)).toEqual([]);
  });

  it('孤稿的家族就是它自己（不足两个成员，UI 据此不画对比）', async () => {
    const lone = await prisma.draft.create({ data: { accountId, title: '孤稿', platform: 'wechat' } });
    const fam = await draftFamily(accountId, lone.id);
    expect(fam).toHaveLength(1);
    expect(fam[0].isRoot).toBe(true);
  });
});
