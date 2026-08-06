import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { crawlOneCompetitor } from '@/lib/pipeline';
import { fetchCompetitorPosts } from '@/lib/adapters/registry';

// Mock 竞对数据**绝不落库**。
//
// 真机 2026-07-29：用户添加「人民日报」，添加动作自带的那次试采因为公众号没有服务端通道而
// 落到 Mock，往 CrawledPost 写了 7 条假文章——标题是「为什么你的完播率一直上不去」这类通用
// 文案、url 是 `#`、还带上百万编造播放量，直接排在插件采到的 20 条真文章前面。
//
// 为什么必须在持久化这一层拦：
//   1. 污染是**永久**的——采集通道后来配好了也不会自动清掉这些假记录；
//   2. 假指标会被 buildBaseline 当成竞对基准，去和用户的真实数据比高低，结论全歪；
//   3. 展示层要「别开天窗」自己去调 fetchCompetitorPosts（结果带 isMock 标注），不需要落库。
//
// 这条闸没有报错会提示，只能靠测试守着。

let competitorId = '';

beforeEach(async () => {
  await prisma.postMetricSnapshot.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  // wechat 没有任何服务端通道（插件采）→ 必然走 Mock 分支，正好当被测场景
  const c = await prisma.competitorAccount.create({
    data: { platform: 'wechat', handle: '人民日报', name: '人民日报' },
  });
  competitorId = c.id;
});

describe('Mock 竞对数据不落库', () => {
  it('无服务端通道的平台：Mock 结果带 isMock 标注', async () => {
    const res = await fetchCompetitorPosts('wechat', '人民日报');
    expect(res.isMock).toBe(true);
    expect(res.posts.length).toBeGreaterThan(0); // 展示层拿得到，只是不许写库
  });

  it('crawlOneCompetitor 对 Mock 结果一条都不写，并如实标记 degraded', async () => {
    const r = await crawlOneCompetitor(competitorId);
    expect(r.posts).toBe(0);
    expect(r.degraded).toBe(true);
    expect(await prisma.crawledPost.count()).toBe(0);
  });

  it('反复采集也不会累积假数据（真机就是一次添加落 7 条）', async () => {
    await crawlOneCompetitor(competitorId);
    await crawlOneCompetitor(competitorId);
    await crawlOneCompetitor(competitorId);
    expect(await prisma.crawledPost.count()).toBe(0);
  });

  it('Mock 的特征值（url="#"、platformItemId 形如 <handle>-<n>）不会出现在库里', async () => {
    await crawlOneCompetitor(competitorId);
    const rows = await prisma.crawledPost.findMany();
    expect(rows.filter((r) => r.url === '#')).toHaveLength(0);
    expect(rows.filter((r) => /^人民日报-\d+$/.test(r.platformItemId))).toHaveLength(0);
  });

  it('插件回传的真实数据照常入库（拦的是 Mock，不是这个平台）', async () => {
    const { ingestCompetitorData } = await import('@/lib/ingest/competitor');
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    await prisma.watchlistItem.create({ data: { workspaceId: ws.id, competitorId } });

    const r = await ingestCompetitorData(ws.id, {
      platform: 'wechat',
      handle: '人民日报',
      autoSubscribe: false,
      posts: [{
        platformItemId: '2667023944_1',
        title: '现在出门买咖啡，都流行自带杯？',
        url: 'https://mp.weixin.qq.com/s/DOfx7t6jbQfzt6-MMdr5SQ',
        publishedAt: new Date('2026-07-29T01:00:00Z'),
      }],
    });
    expect(r.ok).toBe(true);
    expect(await prisma.crawledPost.count()).toBe(1);
  });
});
