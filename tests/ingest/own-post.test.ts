import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { toJson, parseJson, type Metrics } from '@/lib/json';
import { ownPostIngestSchema, ingestOwnPostData, workspaceByIngestToken } from '@/lib/ingest/own-post';

// 自有作品 · authorized 通道（插件回填数据看板）。守卫：令牌 → zod 形状 → 按 platformItemId 对齐本工作区记录。
// 走真 SQLite：要验的正是「跨工作区不串、命中即更新、未命中建档」的库语义。

let workspaceId: string;
let accountId: string;

beforeEach(async () => {
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 't1' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w1', ingestToken: 'bcn_self_token' } });
  workspaceId = ws.id;
  const acc = await prisma.creatorAccount.create({ data: { workspaceId, name: '我的账号', platform: 'multi' } });
  accountId = acc.id;
});

describe('own-post · 令牌与形状', () => {
  it('有效令牌解析出工作区', async () => {
    expect((await workspaceByIngestToken('bcn_self_token'))?.id).toBe(workspaceId);
    expect(await workspaceByIngestToken('nope')).toBeNull();
  });

  it('未知平台被 zod 挡下', () => {
    const r = ownPostIngestSchema.safeParse({ platform: 'nosuch', posts: [{ platformItemId: 'x', metrics: { views: 1 } }] });
    expect(r.success).toBe(false);
  });

  it('metrics 只保留非负整数字段', () => {
    const r = ownPostIngestSchema.parse({ platform: 'bilibili', posts: [{ platformItemId: 'BV1', metrics: { views: '1.9万'.length, likes: -5, junk: 3 } as any }] });
    expect(r.posts[0].metrics).toEqual({ views: 4 }); // likes 负数丢弃、junk 非白名单丢弃
  });
});

describe('own-post · 命中已登记记录 → 更新', () => {
  it('按 platformItemId 命中 → 合并更新 + plugin 来源快照', async () => {
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'bilibili', platformItemId: 'BV123', needsBackfill: false, metrics: toJson({ views: 100, comments: 5 }) },
    });
    const payload = ownPostIngestSchema.parse({ platform: 'bilibili', posts: [{ platformItemId: 'BV123', metrics: { views: 500, likes: 30 } }] });
    const r = await ingestOwnPostData(workspaceId, payload);
    expect(r.ok && r.updated).toBe(1);
    expect(r.ok && r.created).toBe(0);

    const after = parseJson<Metrics>((await prisma.publishRecord.findUnique({ where: { id: rec.id } }))!.metrics, {});
    expect(after.views).toBe(500); // 覆盖
    expect(after.likes).toBe(30); // 新增
    expect(after.comments).toBe(5); // 合并保留（本次没抓到，不丢）

    const snap = await prisma.performanceSnapshot.findFirst({ where: { publishId: rec.id }, orderBy: { takenAt: 'desc' } });
    expect(snap?.source).toBe('plugin');
  });
});

describe('own-post · 未登记 → 建档', () => {
  it('未命中 → 归属默认账号新建 PublishRecord 并回填', async () => {
    const payload = ownPostIngestSchema.parse({
      platform: 'douyin',
      posts: [{ platformItemId: '7abc', url: 'https://www.douyin.com/video/7abc', metrics: { views: 200 } }],
    });
    const r = await ingestOwnPostData(workspaceId, payload);
    expect(r.ok && r.created).toBe(1);
    const rec = await prisma.publishRecord.findFirst({ where: { platformItemId: '7abc' } });
    expect(rec?.accountId).toBe(accountId);
    expect(rec?.needsBackfill).toBe(false);
  });

  it('空 metrics 的 post 跳过，不建空记录', async () => {
    const payload = ownPostIngestSchema.parse({ platform: 'bilibili', posts: [{ platformItemId: 'BVempty', metrics: {} }] });
    const r = await ingestOwnPostData(workspaceId, payload);
    expect(r.ok && r.skipped).toBe(1);
    expect(r.ok && r.created).toBe(0);
    expect(await prisma.publishRecord.count()).toBe(0);
  });
});

describe('own-post · 跨工作区隔离', () => {
  it('别的工作区同 platformItemId 的记录不被串改，本工作区另建一条', async () => {
    // 另一个工作区，已有同 platformItemId 的记录
    const t2 = await prisma.tenant.create({ data: { name: 't2' } });
    const ws2 = await prisma.workspace.create({ data: { tenantId: t2.id, name: 'w2' } });
    const acc2 = await prisma.creatorAccount.create({ data: { workspaceId: ws2.id, name: '别人', platform: 'multi' } });
    const foreign = await prisma.publishRecord.create({
      data: { accountId: acc2.id, platform: 'bilibili', platformItemId: 'SHARED', needsBackfill: false, metrics: toJson({ views: 9 }) },
    });

    const payload = ownPostIngestSchema.parse({ platform: 'bilibili', posts: [{ platformItemId: 'SHARED', metrics: { views: 777 } }] });
    const r = await ingestOwnPostData(workspaceId, payload);
    expect(r.ok && r.created).toBe(1); // 本工作区新建，未串改别家
    expect(parseJson<Metrics>((await prisma.publishRecord.findUnique({ where: { id: foreign.id } }))!.metrics, {}).views).toBe(9);
    expect(await prisma.publishRecord.count({ where: { accountId } })).toBe(1);
  });

  it('工作区无账号 → 明确报错 no_account', async () => {
    const t3 = await prisma.tenant.create({ data: { name: 't3' } });
    const ws3 = await prisma.workspace.create({ data: { tenantId: t3.id, name: 'w3' } });
    const payload = ownPostIngestSchema.parse({ platform: 'bilibili', posts: [{ platformItemId: 'X', metrics: { views: 1 } }] });
    const r = await ingestOwnPostData(ws3.id, payload);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('no_account');
  });
});

// 真机 2026-07-25：用户从公众号后台回填「成功」，但数据看板一条都看不到。
// 根因是归属：旧实现取「第一个活跃账号」建档，与 payload.platform 无关；
// 而每个数据页都是 where: { accountId: 当前选中账号 }，于是 wechat 数据挂在了 douyin 账号名下，
// 哪个页面都不显示，还会带着另一个平台的数字去污染那个账号的基线与学习信号。
describe('own-post · 归属必须按平台选账号', () => {
  it('🔒 wechat 数据不得挂到 douyin 账号上（哪怕它是最早的活跃账号）', async () => {
    await prisma.creatorAccount.deleteMany();
    const dy = await prisma.creatorAccount.create({ data: { workspaceId, name: '抖音号', platform: 'douyin' } });
    const wx = await prisma.creatorAccount.create({ data: { workspaceId, name: '公众号', platform: 'wechat' } });

    const r = await ingestOwnPostData(workspaceId, ownPostIngestSchema.parse({
      platform: 'wechat',
      posts: [{ platformItemId: 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz', metrics: { views: 1234 } }],
    }));
    expect(r.ok).toBe(true);

    const rec = await prisma.publishRecord.findFirst({ where: { platformItemId: 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz' } });
    expect(rec?.accountId).toBe(wx.id);
    expect(rec?.accountId).not.toBe(dy.id);
  });

  it('没有同平台账号时报错，而不是挂到不相干的账号上', async () => {
    await prisma.creatorAccount.deleteMany();
    await prisma.creatorAccount.create({ data: { workspaceId, name: '抖音号', platform: 'douyin' } });

    const r = await ingestOwnPostData(workspaceId, ownPostIngestSchema.parse({
      platform: 'wechat',
      posts: [{ platformItemId: 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz', metrics: { views: 1234 } }],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_account_for_platform');
    expect(await prisma.publishRecord.count()).toBe(0); // 一条都不许建
  });

  it('multi 账号可以兜底接收（用户只建了一个「全平台」账号的常见情形）', async () => {
    const r = await ingestOwnPostData(workspaceId, ownPostIngestSchema.parse({
      platform: 'wechat',
      posts: [{ platformItemId: 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz', metrics: { views: 1234 } }],
    }));
    expect(r.ok).toBe(true);
    const rec = await prisma.publishRecord.findFirst();
    expect(rec?.accountId).toBe(accountId); // beforeEach 建的就是 platform:'multi'
  });

  it('🔒 修正历史误挂：之前落在 douyin 账号下的 wechat 记录，再回填时搬回公众号账号', async () => {
    await prisma.creatorAccount.deleteMany();
    const dy = await prisma.creatorAccount.create({ data: { workspaceId, name: '抖音号', platform: 'douyin' } });
    const wx = await prisma.creatorAccount.create({ data: { workspaceId, name: '公众号', platform: 'wechat' } });
    // 模拟旧版本留下的错归属记录
    const stale = await prisma.publishRecord.create({
      data: {
        accountId: dy.id, platform: 'wechat',
        platformItemId: 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz',
        publishedAt: new Date(), metrics: toJson({ views: 100 } as Metrics),
      },
    });

    const r = await ingestOwnPostData(workspaceId, ownPostIngestSchema.parse({
      platform: 'wechat',
      posts: [{ platformItemId: 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz', metrics: { views: 1234 } }],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.moved).toBe(1);

    const after = await prisma.publishRecord.findUnique({ where: { id: stale.id } });
    expect(after?.accountId).toBe(wx.id); // 搬回来了，用户在公众号账号下立刻能看到
    expect(parseJson<Metrics>(after!.metrics, {}).views).toBe(1234); // 且指标是合并更新的
  });
});

// 真机 2026-07-25：入库的 9 条公众号记录标题全是「已开启通知…已通知3人失败0人…」——
// 那是群发的通知状态块。采集端已修好不再抓它（self-backend.js beaconPickTitle），
// 但存量那几条按旧规则（只在标题为空时才补）**永远修不回来**。
describe('own-post · 标题：空着补、噪音改、正常的一律不动', () => {
  const wechatId = 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz';
  const ingest = (title: string) =>
    ingestOwnPostData(workspaceId, ownPostIngestSchema.parse({
      platform: 'wechat', posts: [{ platformItemId: wechatId, title, metrics: { views: 1234 } }],
    }));
  const seed = (title: string | null) =>
    prisma.publishRecord.create({
      data: { accountId, platform: 'wechat', platformItemId: wechatId, title, metrics: toJson({} as Metrics) },
    });

  it('库里标题空着 → 用采到的补上', async () => {
    const rec = await seed(null);
    await ingest('春节营销复盘');
    expect((await prisma.publishRecord.findUnique({ where: { id: rec.id } }))!.title).toBe('春节营销复盘');
  });

  it('🔒 库里是已知页面噪音 → 允许用新标题覆盖（否则那几条永远是脏的）', async () => {
    const rec = await seed('已开启通知，内容已在公众号列表和公众号主页展示已通知3人失败0人');
    await ingest('春节营销复盘');
    expect((await prisma.publishRecord.findUnique({ where: { id: rec.id } }))!.title).toBe('春节营销复盘');
  });

  it('🔒 库里是用户手写的正常标题 → 绝不覆盖（采集器抓的不一定更准）', async () => {
    const rec = await seed('我自己写的标题');
    await ingest('页面上抓到的另一个标题');
    expect((await prisma.publishRecord.findUnique({ where: { id: rec.id } }))!.title).toBe('我自己写的标题');
  });
});

// 插件此前不回传 publishedAt，后端就填「回填当天」——/data 的发布时段分析按小时分组，
// 结果全是回填那一刻的时辰。现在采集端能读到真实发表时间了，要能把这些记录纠回去。
describe('own-post · 发布时间只往更早改，绝不改晚', () => {
  const id = 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz';
  const ingestAt = (publishedAt: string) =>
    ingestOwnPostData(workspaceId, ownPostIngestSchema.parse({
      platform: 'wechat', posts: [{ platformItemId: id, publishedAt, metrics: { views: 1234 } }],
    }));

  it('新建记录直接用回传的发表时间', async () => {
    await ingestAt('2026-07-20T20:30:00');
    const rec = await prisma.publishRecord.findFirst();
    expect(rec!.publishedAt.toISOString()).toBe(new Date('2026-07-20T20:30:00').toISOString());
  });

  it('🔒 存量记录被填成「回填当天」→ 用真实发表时间纠回去', async () => {
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'wechat', platformItemId: id, publishedAt: new Date(), metrics: toJson({} as Metrics) },
    });
    await ingestAt('2026-07-20T20:30:00');
    const after = await prisma.publishRecord.findUnique({ where: { id: rec.id } });
    expect(after!.publishedAt.toISOString()).toBe(new Date('2026-07-20T20:30:00').toISOString());
  });

  it('🔒 单向：某次误读出一个更晚的时间时不许改（保证收敛）', async () => {
    const real = new Date('2026-07-20T20:30:00');
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'wechat', platformItemId: id, publishedAt: real, metrics: toJson({} as Metrics) },
    });
    await ingestAt('2026-07-25T09:00:00');
    const after = await prisma.publishRecord.findUnique({ where: { id: rec.id } });
    expect(after!.publishedAt.toISOString()).toBe(real.toISOString());
  });
});
