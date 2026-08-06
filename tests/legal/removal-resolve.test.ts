import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { purgeRemovedAccountData, resolveRemovalRequest, isRemovalRequested } from '@/lib/legal/removal';

// 申请页对权利人承诺的是「停止采集**并移除已收集的**相关公开信息」。
// 停采此前有闸门，「移除已收集的」那半句一直没有代码兑现——本文件锁住它。

async function seedCompetitor(platform: string, handle: string) {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.competitorAccount.create({ data: { platform, handle, name: '某账号' } });
  // platformItemId 全局唯一（@@unique([platform, platformItemId])）——按 handle 取名，
  // 否则「两个账号」的用例会撞唯一约束
  await prisma.crawledPost.createMany({
    data: [
      { competitorId: acc.id, platform, platformItemId: `${handle}-p1`, title: 'a' },
      { competitorId: acc.id, platform, platformItemId: `${handle}-p2`, title: 'b' },
    ],
  });
  await prisma.watchlistItem.create({ data: { workspaceId: ws.id, competitorId: acc.id } });
  // 采集台账：无外键不会级联，必须被显式删掉——它留着账号名和「哪几天采过它」
  await prisma.collectionRun.create({
    data: { workspaceId: ws.id, scope: 'rival', platform, targetId: acc.id, targetName: '某账号', channel: 'manual', items: 2 },
  });
  return { accountId: acc.id, workspaceId: ws.id };
}

beforeEach(async () => {
  await prisma.dataRemovalRequest.deleteMany();
  await prisma.collectionRun.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('执行移除', () => {
  it('删档案的同时级联带走作品与订阅关系', async () => {
    await seedCompetitor('douyin', 'abc');
    const r = await purgeRemovedAccountData('douyin', 'abc');
    expect(r).toEqual({ accounts: 1, posts: 2, watchlistItems: 1, runs: 1 });
    expect(await prisma.competitorAccount.count()).toBe(0);
    expect(await prisma.crawledPost.count()).toBe(0);
    expect(await prisma.watchlistItem.count()).toBe(0);
    // 台账里不能留下「我采过这个号」的痕迹
    expect(await prisma.collectionRun.count()).toBe(0);
  });

  it('库里本来就没有这个账号 → 零删除且不报错（收到申请但从没采过是常态）', async () => {
    expect(await purgeRemovedAccountData('douyin', 'never-seen')).toEqual({ accounts: 0, posts: 0, watchlistItems: 0, runs: 0 });
  });

  it('只删被申请的那个账号，同平台其他账号不受影响', async () => {
    await seedCompetitor('douyin', 'target');
    await seedCompetitor('douyin', 'innocent');
    await purgeRemovedAccountData('douyin', 'target');
    const left = await prisma.competitorAccount.findMany({ select: { handle: true } });
    expect(left.map((x) => x.handle)).toEqual(['innocent']);
    // 台账同理：只带走被申请那个号的行
    expect(await prisma.collectionRun.count()).toBe(1);
  });
});

describe('申请状态流转', () => {
  it('核验成立 → 标记 removed + 执行删除 + 继续停采', async () => {
    await seedCompetitor('xiaohongshu', 'star');
    const req = await prisma.dataRemovalRequest.create({
      data: { platform: 'xiaohongshu', handle: 'star', contact: 'a@b.com' },
    });
    const r = await resolveRemovalRequest(req.id, 'removed');
    expect(r.ok).toBe(true);
    expect(r.purged).toEqual({ accounts: 1, posts: 2, watchlistItems: 1, runs: 1 });
    const after = await prisma.dataRemovalRequest.findUnique({ where: { id: req.id } });
    expect(after?.status).toBe('removed');
    expect(after?.resolvedAt).toBeTruthy();
    expect(await isRemovalRequested('xiaohongshu', 'star')).toBe(true);
  });

  it('驳回 → 恢复采集，且不删任何数据（冒用他人身份的申请不能连坐真实数据）', async () => {
    await seedCompetitor('bilibili', 'up1');
    const req = await prisma.dataRemovalRequest.create({
      data: { platform: 'bilibili', handle: 'up1', contact: 'x@y.com' },
    });
    const r = await resolveRemovalRequest(req.id, 'rejected');
    expect(r.ok).toBe(true);
    expect(r.purged).toBeUndefined();
    expect(await prisma.competitorAccount.count()).toBe(1);
    expect(await prisma.crawledPost.count()).toBe(2);
    expect(await isRemovalRequested('bilibili', 'up1')).toBe(false);
  });

  it('不存在的申请 → 如实报错，不静默成功', async () => {
    expect(await resolveRemovalRequest('nope', 'removed')).toEqual({ ok: false, error: '申请不存在' });
  });
});
