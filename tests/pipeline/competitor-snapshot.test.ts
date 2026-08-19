import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { toJson } from '@/lib/json';

// 竞对趋势的**写入半边**：定时采集通道此前只更新 CrawledPost.metrics，从不落
// PostMetricSnapshot——那张表因此在生产里长期为空，趋势图无从谈起（只有插件通道在写）。
//
// 锁三件事：
//   1. 首次入库落一条快照（趋势的起点，缺了它第二次采集只有一个点画不出线）；
//   2. 指标变了才追加——否则每轮采集追加一条一模一样的记录，画出来是假的水平线；
//   3. 本通道无指标（RSS 变更监控）时一条都不落，且不把已有指标抹成零。

const posts = vi.hoisted(() => ({ current: [] as unknown[] }));
vi.mock('@/lib/adapters/registry', async (orig) => {
  const actual = await orig<typeof import('@/lib/adapters/registry')>();
  return {
    ...actual,
    fetchCompetitorPosts: async (platform: string) => ({
      platform,
      posts: posts.current,
      via: 'test',
      degraded: false,
    }),
  };
});

const { crawlOneCompetitor } = await import('@/lib/pipeline');

let competitorId = '';

const post = (metrics?: Record<string, number>) => ({
  platform: 'bilibili',
  platformItemId: 'BV_snapshot_test',
  title: '测试作品',
  summary: null,
  url: 'https://www.bilibili.com/video/BV_snapshot_test',
  publishedAt: new Date('2026-07-01T00:00:00Z'),
  ...(metrics ? { metrics } : {}),
});

const snapCount = () => prisma.postMetricSnapshot.count();
const snapViews = async () =>
  (await prisma.postMetricSnapshot.findMany({ orderBy: { takenAt: 'asc' } })).map(
    (s) => JSON.parse(s.metrics).views,
  );

beforeEach(async () => {
  await prisma.postMetricSnapshot.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  const c = await prisma.competitorAccount.create({
    data: { platform: 'bilibili', handle: 'snapshot-test', name: 'UP主' },
  });
  competitorId = c.id;
  posts.current = [];
});

describe('crawlOneCompetitor · 落竞对作品快照', () => {
  it('首次入库落一条快照（趋势起点）', async () => {
    posts.current = [post({ views: 1000, likes: 50 })];
    await crawlOneCompetitor(competitorId);
    expect(await snapCount()).toBe(1);
    expect(await snapViews()).toEqual([1000]);
  });

  // 2026-08-10 口径反转（原来是「指标没变就不写」，理由是「否则趋势图是条假的水平线」）。
  //
  // 反转的理由：没涨时的水平线**就是真相**，真正假的是「分不清没涨和没采」。
  // 旧口径下这两件事在序列上完全一样，于是区间增长根本算不出「这几天确实没动」；
  // 更糟的是它和展示值四舍五入叠在一起——B站「1.0亿」要涨到 1.1亿 才变，
  // 大号可能几个月一条快照都不写，增长曲线整条是空的。
  //
  // 「同一天采十次堆十行」的顾虑由展示层解决：toDailySeries 本来就按逻辑日归并取一条。
  it('每次采集都留一个时点（同值也留，否则「没涨」和「没采」分不清）', async () => {
    posts.current = [post({ views: 1000 })];
    await crawlOneCompetitor(competitorId);

    await crawlOneCompetitor(competitorId); // 同样的数再采一轮
    expect(await snapCount()).toBe(2);

    posts.current = [post({ views: 2500 })];
    await crawlOneCompetitor(competitorId);
    expect(await snapViews()).toEqual([1000, 1000, 2500]);
  });

  it('本通道无指标（RSS 变更监控）→ 不落空快照，也不抹掉已有指标', async () => {
    posts.current = [post({ views: 1000 })];
    await crawlOneCompetitor(competitorId);

    posts.current = [post()]; // metrics undefined
    await crawlOneCompetitor(competitorId);

    expect(await snapCount()).toBe(1); // 没有新增空快照
    const cp = await prisma.crawledPost.findFirstOrThrow();
    expect(JSON.parse(cp.metrics).views).toBe(1000); // 已有指标没被抹成零
  });

  it('首次入库但本通道无指标 → 不落快照（不建空起点）', async () => {
    posts.current = [post()];
    await crawlOneCompetitor(competitorId);
    expect(await snapCount()).toBe(0);
    expect(await prisma.crawledPost.count()).toBe(1); // 作品本身照常入库
  });

  it('快照与作品同生共死（onDelete: Cascade）', async () => {
    posts.current = [post({ views: 1000 })];
    await crawlOneCompetitor(competitorId);
    await prisma.crawledPost.deleteMany();
    expect(await snapCount()).toBe(0);
  });
});
