import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 「backfill_metrics 到底跑不跑得起来」的实证闸门。
//
// 背景：lib/jobs/handlers.ts 的 backfill_metrics 用
//   where: { platformItemId: { not: null } }
// 挑待回流记录。而在本次改动之前，代码库里**仅有的两个** publishRecord.create
// （studio/actions.ts、data/actions.ts）都不写 platformItemId ——
// 于是这个查询恒定匹配 0 行，整段 backfill（里程碑判定、适配器调用、错误隔离、
// learnFromPerformance 回环）连同它的测试，都是永不执行的装饰品。
//
// 本文件锁死的就是这件事本身：
//   1. 【回归锁·关键】platformItemId 为 null 的记录 → 到期 0 条（这是改动前的全量现状）；
//   2. platformItemId 非空且跨过 T+48h → 真的产出带 milestone 的 PerformanceSnapshot；
//   3. ID 匹配不上平台返回的作品 → 记 missed，**不写自我复制的假快照**。
//
// 只 mock 适配器（无商业 key 时 realCompetitorAdapter 恒返回 null，测不到下游）；
// DB 是真 SQLite，handler 是真 handler。

const posts = vi.hoisted(() => ({ list: [] as any[] }));
vi.mock('@/lib/adapters/competitor-real', () => ({
  realCompetitorAdapter: (platform: string) =>
    platform === 'douyin'
      ? {
          name: 'tikhub',
          kind: 'commercial',
          platform: 'douyin',
          fetchPosts: async () => posts.list,
          health: async () => ({ ok: true }),
        }
      : null,
}));

const { HANDLERS } = await import('@/lib/jobs/handlers');

const AWEME = '7065264218437717285';
let accountId: string;

async function seedAccount() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '测试账号', platform: 'douyin', handle: 'MS4wLjABAAAAxyz' },
  });
  return acc.id;
}

// 跨过 D+2 里程碑（48h）、仍在 12h grace 窗口内 [48h,60h)
const dueAt = () => new Date(Date.now() - 50 * 3600_000);

beforeEach(async () => {
  posts.list = [
    {
      platform: 'douyin',
      platformItemId: AWEME,
      title: '真实作品',
      metrics: { views: 45000, likes: 3200, comments: 180, shares: 90 },
    },
  ];
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  accountId = await seedAccount();
});

describe('backfill_metrics 激活实证', () => {
  it('【回归锁】platformItemId 为 null → 到期 0 条（改动前全库的样子）', async () => {
    await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: null, publishedAt: dueAt() },
    });

    const r = await HANDLERS.backfill_metrics({});

    // 这就是探针当初测到的现状：记录在库里、里程碑也到了，但 where 把它过滤掉了
    expect(r.detail).toContain('到期 0 条');
    expect(await prisma.performanceSnapshot.count()).toBe(0);
  });

  it('platformItemId 非空 + 跨过 D+2（50h）→ 真的回流，写出带 milestone 的快照', async () => {
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: AWEME, publishedAt: dueAt() },
    });

    const r = await HANDLERS.backfill_metrics({});

    expect(r.detail).toContain('到期 1 条');
    expect(r.detail).toContain('回流 1 条');
    expect(r.detail).toContain('D+2'); // age=50h 落在 D+2 窗口 [48h,60h)

    // 快照真的落库，且带上里程碑与来源标记（不是 manual）
    const snaps = await prisma.performanceSnapshot.findMany({ where: { publishId: rec.id } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].milestone).toBe('D+2');
    expect(snaps[0].source).toBe('tikhub');
    expect(JSON.parse(snaps[0].metrics)).toMatchObject({ views: 45000, likes: 3200 });

    // 记录上的指标被真实值覆盖
    const after = await prisma.publishRecord.findUniqueOrThrow({ where: { id: rec.id } });
    expect(JSON.parse(after.metrics)).toMatchObject({ views: 45000, likes: 3200 });

    // JobRun 记账成功
    const run = await prisma.jobRun.findFirst({ where: { name: 'backfill_metrics' }, orderBy: { id: 'desc' } });
    expect(run?.status).toBe('ok');
  });

  it('ID 匹配不上平台返回的列表 → 记 missed，绝不写假快照', async () => {
    // 这正是「猜一个 ID」的下场：要么匹配不上（这里），要么匹配上**别人的作品**。
    await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: '9999999999999999999', publishedAt: dueAt() },
    });

    const r = await HANDLERS.backfill_metrics({});

    expect(r.detail).toContain('到期 1 条');
    expect(r.detail).toContain('回流 0 条');
    expect(r.detail).toContain('平台列表未命中 1 条');
    expect(await prisma.performanceSnapshot.count()).toBe(0);
  });

  it('无真实数据源的平台（无 key）→ 如实记账，不写自我复制的快照', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't2' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w2' } });
    const acc = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'yt', platform: 'youtube', handle: '@ch' },
    });
    await prisma.publishRecord.create({
      data: { accountId: acc.id, platform: 'youtube', platformItemId: 'dQw4w9WgXcQ', publishedAt: dueAt() },
    });

    const r = await HANDLERS.backfill_metrics({});

    expect(r.detail).toContain('无数据源未回流：youtube');
    expect(await prisma.performanceSnapshot.count()).toBe(0);
  });

  it('刚发布（1h，未到 D+1）→ 不回流', async () => {
    await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: AWEME, publishedAt: new Date(Date.now() - 3600_000) },
    });
    const r = await HANDLERS.backfill_metrics({});
    expect(r.detail).toContain('到期 0 条');
  });
});

describe('发布登记 → 自动回流：端到端', () => {
  // 这是本次改动的真正主张：「登记时贴链接」这一步接上后，backfill 从死代码变成活代码。
  it('actBackfill 贴抖音链接 → 落 platformItemId → backfill_metrics 认得出它', async () => {
    const session = {
      memberId: 'm1',
      tenantId: 'tt',
      workspaceId: 'ww',
      accountId,
      memberName: '张三',
      role: 'owner',
      plan: 'pro',
    };
    vi.doMock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
    vi.doMock('next/cache', () => ({ revalidatePath: () => {} }));
    const { actBackfill } = await import('@/app/(app)/data/actions');

    const res = await actBackfill('douyin', 100, 5, false, {
      url: `https://www.douyin.com/video/${AWEME}`,
      aigcConfirmed: true,
    });
    expect(res.ok).toBe(true);
    expect(res.platformItemId).toBe(AWEME);

    // 把它拨到里程碑窗口内（避免等 48 小时）
    await prisma.publishRecord.update({ where: { id: res.id! }, data: { publishedAt: dueAt() } });
    // 手动回填自身写的那条起点快照会挡住里程碑判定（takenAt 是 now），清掉
    await prisma.performanceSnapshot.deleteMany({ where: { publishId: res.id! } });

    const r = await HANDLERS.backfill_metrics({});
    expect(r.detail).toContain('回流 1 条');

    const snap = await prisma.performanceSnapshot.findFirst({ where: { publishId: res.id!, milestone: 'D+2' } });
    expect(snap).not.toBeNull();
    expect(JSON.parse(snap!.metrics)).toMatchObject({ views: 45000 });
  });

  it('AC③ 硬闸：未确认 AI 声明 → 拒绝登记，一条记录都不落', async () => {
    const session = {
      memberId: 'm1', tenantId: 'tt', workspaceId: 'ww', accountId,
      memberName: '张三', role: 'owner', plan: 'pro',
    };
    vi.doMock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
    vi.doMock('next/cache', () => ({ revalidatePath: () => {} }));
    const { actBackfill } = await import('@/app/(app)/data/actions');

    const before = await prisma.publishRecord.count();
    const res = await actBackfill('douyin', 100, 5, false, { url: `https://www.douyin.com/video/${AWEME}` });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('AI 使用声明');
    expect(await prisma.publishRecord.count()).toBe(before);
  });

  it('链接解析失败 → 不阻断登记，但如实告知「自动回流将不可用」', async () => {
    const session = {
      memberId: 'm1', tenantId: 'tt', workspaceId: 'ww', accountId,
      memberName: '张三', role: 'owner', plan: 'pro',
    };
    vi.doMock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
    vi.doMock('next/cache', () => ({ revalidatePath: () => {} }));
    const { actBackfill } = await import('@/app/(app)/data/actions');

    // 短链：认得出是抖音，但拿不到 aweme_id
    const res = await actBackfill('douyin', 100, 5, false, {
      url: 'https://v.douyin.com/iRxNvHmA/',
      aigcConfirmed: true,
    });
    expect(res.ok).toBe(true); // 用户就是想记一笔，不能拦
    expect(res.platformItemId).toBeUndefined();
    expect(res.warning).toContain('自动回流将不可用');

    const rec = await prisma.publishRecord.findUniqueOrThrow({ where: { id: res.id! } });
    expect(rec.platformItemId).toBeNull(); // 绝不猜一个塞进去
  });
});
