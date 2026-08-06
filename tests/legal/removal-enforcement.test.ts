import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { isRemovalRequested, normalizeRemovalTarget } from '@/lib/legal/removal';
import { ingestCompetitorData } from '@/lib/ingest/competitor';

// 数据移除申请的**执行**（PIPL 拒绝权）。
// 此前这张表只有写入没有执行：公开页收下退出申请，采集链路却从不查它——
// 对外承诺了一个代码兑现不了的权利。这里锁住两条采集通道都真的被挡住。

beforeEach(async () => {
  await prisma.dataRemovalRequest.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
});

describe('normalizeRemovalTarget · 归一化到与采集侧同口径', () => {
  it('贴整条主页 URL → 解析出平台与纯 handle（不归一的话闸门永远匹配不上）', () => {
    const r = normalizeRemovalTarget('bilibili', 'https://space.bilibili.com/123456');
    expect(r.platform).toBe('bilibili');
    expect(r.handle).toBe('123456');
  });

  it('已经是纯 handle → 原样保留', () => {
    expect(normalizeRemovalTarget('bilibili', '123456')).toEqual({ platform: 'bilibili', handle: '123456' });
  });
});

describe('isRemovalRequested · 状态口径', () => {
  const mk = (status: string) =>
    prisma.dataRemovalRequest.create({
      data: { platform: 'bilibili', handle: '123456', contact: 'a@b.com', status },
    });

  it('pending 也停采：核验期间不继续采集被投诉的账号', async () => {
    await mk('pending');
    expect(await isRemovalRequested('bilibili', '123456')).toBe(true);
  });

  it('verified / removed 停采', async () => {
    await mk('verified');
    expect(await isRemovalRequested('bilibili', '123456')).toBe(true);
    await prisma.dataRemovalRequest.deleteMany();
    await mk('removed');
    expect(await isRemovalRequested('bilibili', '123456')).toBe(true);
  });

  it('rejected（核验为无效申请）→ 恢复采集', async () => {
    await mk('rejected');
    expect(await isRemovalRequested('bilibili', '123456')).toBe(false);
  });

  it('没有申请 → 照常采集', async () => {
    expect(await isRemovalRequested('bilibili', '123456')).toBe(false);
  });

  it('只挡对应账号，不误伤同平台其他账号', async () => {
    await mk('pending');
    expect(await isRemovalRequested('bilibili', '999999')).toBe(false);
  });
});

describe('🔒 插件回传通道必须被同一道闸挡住（否则是绕过退出权的后门）', () => {
  it('被申请移除的账号 → 拒绝入库，且一条 CrawledPost 都不写', async () => {
    await prisma.dataRemovalRequest.create({
      data: { platform: 'bilibili', handle: '123456', contact: 'a@b.com', status: 'pending' },
    });

    const r = await ingestCompetitorData('w1', {
      platform: 'bilibili',
      handle: '123456',
      autoSubscribe: true,
      posts: [{ platformItemId: 'BV1xx', title: 't', metrics: { views: 100 } }],
    } as Parameters<typeof ingestCompetitorData>[1]);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('数据移除申请');
    // 关键：不只是返回失败，库里必须干净——档案与作品都不能落
    expect(await prisma.competitorAccount.count()).toBe(0);
    expect(await prisma.crawledPost.count()).toBe(0);
  });

  it('申请被驳回后 → 恢复正常入库', async () => {
    // 入库成功路径会建 WatchlistItem，需要真实存在的 workspace（外键）
    const tenant = await prisma.tenant.create({ data: { name: 'rm' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
    await prisma.dataRemovalRequest.create({
      data: { platform: 'bilibili', handle: '123456', contact: 'a@b.com', status: 'rejected' },
    });
    const r = await ingestCompetitorData(ws.id, {
      platform: 'bilibili',
      handle: '123456',
      autoSubscribe: true,
      posts: [{ platformItemId: 'BV1xx', title: 't', metrics: { views: 100 } }],
    } as Parameters<typeof ingestCompetitorData>[1]);
    expect(r.ok).toBe(true);
    expect(await prisma.crawledPost.count()).toBe(1);
  });
});
