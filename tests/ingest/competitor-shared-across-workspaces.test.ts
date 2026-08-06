import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 竞对数据跨工作区共享 —— 这是刻意的架构选择，不是巧合：
//   CompetitorAccount / CrawledPost **不带 workspaceId/tenantId**（见 prisma/schema.postgres.prisma），
//   prisma/postgres/02-rls.sql 也显式把这两张表排除在 RLS 之外；
//   按工作区分的只有「订阅关系」WatchlistItem。
// 于是 A 采到的文章，B 只要订阅同一个竞对就直接看得到，一次都不用自己采。
//
// 为什么值得专门测：这条性质**没有任何接口会声明它**，但产品文案直接建立在它上面
//（添加竞对时会说「别人已经采过，库里已有 N 篇」）。哪天有人给 CrawledPost 加上工作区归属
// 或给它开 RLS，文案就会变成谎话，而且只有用户去榜单里找不到数据时才会发现。

const session = { memberId: 'm1', tenantId: '', workspaceId: '', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actAddCompetitor } = await import('@/app/(app)/competitors/actions');

let wsA = '';
let wsB = '';

beforeEach(async () => {
  await prisma.postMetricSnapshot.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();

  // 两个**不同租户**的工作区：连租户都不同，共享才算真共享
  const tA = await prisma.tenant.create({ data: { name: '租户A' } });
  const tB = await prisma.tenant.create({ data: { name: '租户B' } });
  wsA = (await prisma.workspace.create({ data: { tenantId: tA.id, name: 'A的工作区' } })).id;
  wsB = (await prisma.workspace.create({ data: { tenantId: tB.id, name: 'B的工作区' } })).id;
  session.tenantId = tA.id;
  session.workspaceId = wsA;
});

// A 先建档并采到 3 篇（模拟插件回传的结果）
async function collectedByA() {
  const c = await prisma.competitorAccount.create({
    data: { platform: 'wechat', handle: '人民日报', name: '人民日报', lastCrawledAt: new Date() },
  });
  await prisma.watchlistItem.create({ data: { workspaceId: wsA, competitorId: c.id } });
  for (let i = 0; i < 3; i++) {
    await prisma.crawledPost.create({
      data: {
        competitorId: c.id,
        platform: 'wechat',
        platformItemId: `266702394${i}_1`,
        title: `A 采到的第 ${i + 1} 篇`,
        url: `https://mp.weixin.qq.com/s/aaa${i}`,
        publishedAt: new Date(),
      },
    });
  }
  return c;
}

describe('竞对作品跨工作区共享', () => {
  it('B 订阅同一个竞对后，直接看到 A 采的全部文章（没有工作区过滤）', async () => {
    const c = await collectedByA();
    await prisma.watchlistItem.create({ data: { workspaceId: wsB, competitorId: c.id } });

    // 竞对页取数的口径：先按工作区拿订阅的 competitorId，再按 competitorId 取作品
    const subs = await prisma.watchlistItem.findMany({ where: { workspaceId: wsB }, select: { competitorId: true } });
    const posts = await prisma.crawledPost.findMany({ where: { competitorId: { in: subs.map((s) => s.competitorId) } } });
    expect(posts).toHaveLength(3);
  });

  it('没订阅就看不到（共享的是作品，不是订阅关系）', async () => {
    await collectedByA();
    const subs = await prisma.watchlistItem.findMany({ where: { workspaceId: wsB }, select: { competitorId: true } });
    expect(subs).toHaveLength(0);
  });

  it('同一竞对只建一份档案：B 添加同名同平台的号会复用 A 那条，不新建', async () => {
    const c = await collectedByA();
    session.workspaceId = wsB;
    await actAddCompetitor('wechat', '人民日报', '人民日报');
    expect(await prisma.competitorAccount.count()).toBe(1);
    expect(await prisma.watchlistItem.count({ where: { competitorId: c.id } })).toBe(2);
  });

  it('添加时如实报出「已有多少篇」，不催用户去重复采集', async () => {
    await collectedByA();
    session.workspaceId = wsB;
    const r = await actAddCompetitor('wechat', '人民日报', '人民日报');
    expect(r.ok).toBe(true);
    expect(r.inheritedPosts).toBe(3); // ← 文案据此改口，别再说「请去采集」
    expect(r.lastCrawledAt).toBeTruthy();
  });

  it('全新的号 inheritedPosts 为 0（这时才该提示去采集）', async () => {
    const r = await actAddCompetitor('wechat', '新华社', '新华社');
    expect(r.ok).toBe(true);
    expect(r.inheritedPosts).toBe(0);
  });
});
