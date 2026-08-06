import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { generateRecommendations } from '@/lib/pipeline';
import * as recycle from '@/lib/topic/sources/recycle';
import * as gap from '@/lib/topic/sources/gap';

// 延伸候选源汇入主漏斗的集成验证（lib/topic/sources/* → lib/pipeline.ts）。
//
// 单测已经分别锁住了各源自己的判定逻辑，这里只锁**接线**上的三件事——
// 它们单独看每个模块都是对的，接错了却毫无征兆：
//   1) 新源产出的候选确实进了候选池、并把 evidence/queue 落到了库里；
//   2) 成本护栏没被悄悄放大：LLM 精排调用次数仍等于 topN（+ 至多 1 个探索位）；
//   3) 任一新源取数挂掉，主路径（热榜+竞对）照常出推荐。

const NOW_H = (h: number) => new Date(Date.now() - h * 3600_000);
const DAYS = (d: number) => new Date(Date.now() - d * 86_400_000);

const personaCard = JSON.stringify({
  identity: '前端工程师',
  audience: '前端新人',
  valueProp: '把复杂工具链讲明白',
  niche: '前端工程化',
  canDo: ['构建优化', '性能调优'],
  cantDo: [],
  tone: '干货',
  platforms: ['bilibili', 'xiaohongshu'],
});

async function seedAccount() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, platform: 'bilibili', name: '测试账号', personaCard },
  });
  return { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id };
}

const hot = (source: string, rank: number, title: string, heat: number) =>
  prisma.hotItem.create({ data: { source, rank, title, heat, firstSeenAt: NOW_H(2) } });

let seq = 0;
// 造一个跨平台扩散、但没到 bilibili 的话题簇（口径 A：bilibili 有热榜源，可直接观测）
async function seedGapCluster(title: string) {
  const cluster = await prisma.topicCluster.create({
    data: { title, sources: JSON.stringify(['weibo', 'zhihu']), heat: 900 },
  });
  for (const source of ['weibo', 'zhihu']) {
    await prisma.hotItem.create({
      data: { source, rank: 1, title: `${title}-${source}-${++seq}`, heat: 900, clusterId: cluster.id, firstSeenAt: NOW_H(3) },
    });
  }
  return cluster;
}

beforeEach(async () => {
  await prisma.topicIdea.deleteMany();
  await prisma.hotItem.deleteMany();
  await prisma.topicCluster.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.ownPost.deleteMany();
  await prisma.llmCallLog.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('抢跑窗口进推荐', () => {
  it('跨平台扩散但未到主战平台的话题 → 落库为 gap/today，带证据与窗口提示', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await seedGapCluster('前端构建工具链集体大改版');
    await generateRecommendations(accountId, workspaceId, 3);

    const gap = await prisma.topicIdea.findFirst({ where: { accountId, sourceType: 'gap' } });
    expect(gap).toBeTruthy();
    expect(gap!.queue).toBe('today');
    expect(gap!.evidence).toContain('微博、知乎');
    expect(gap!.windowHint).toContain('抢跑窗口');
  });

  it('抢跑候选与热榜候选同题时只留一条（同题两行推荐是纯噪声）', async () => {
    const { workspaceId, accountId } = await seedAccount();
    const title = '前端构建工具链集体大改版';
    await seedGapCluster(title);
    await hot('weibo', 1, title, 900); // 与簇首同名的在榜词条
    await generateRecommendations(accountId, workspaceId, 6);

    const rows = await prisma.topicIdea.findMany({ where: { accountId, title } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceType).toBe('gap'); // 保留信息更多的那条
  });
});

describe('旧文翻新进推荐', () => {
  it('做过同题的热点 → 来源改写为 recycle 并带上当年数据', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('bilibili', 1, '前端构建优化又火了', 800);
    for (let i = 0; i < 3; i++) {
      await prisma.publishRecord.create({
        data: {
          accountId, platform: 'bilibili', title: `前端构建优化实战第${i}讲`,
          publishedAt: DAYS(120 + i), metrics: JSON.stringify({ views: 3000 + i }),
        },
      });
    }
    await generateRecommendations(accountId, workspaceId, 3);

    const row = await prisma.topicIdea.findFirst({ where: { accountId, title: '前端构建优化又火了' } });
    expect(row!.sourceType).toBe('recycle');
    expect(row!.evidence).toContain('前端构建优化实战');
    expect(row!.evidence).toContain('播放');
  });
});

describe('跨平台自搬运进推荐', () => {
  it('B站爆款且小红书没发过 → 作为 crossplat 候选落到本周队列', async () => {
    const { workspaceId, accountId } = await seedAccount();
    for (let i = 0; i < 3; i++) {
      await prisma.publishRecord.create({
        data: {
          accountId, platform: 'bilibili', title: `日常内容第${i}期`,
          publishedAt: DAYS(20 + i), metrics: JSON.stringify({ views: 1000 }),
        },
      });
    }
    await prisma.publishRecord.create({
      data: {
        accountId, platform: 'bilibili', title: '前端构建优化实战全解',
        publishedAt: DAYS(15), metrics: JSON.stringify({ views: 20000 }),
      },
    });
    await generateRecommendations(accountId, workspaceId, 3);

    const row = await prisma.topicIdea.findFirst({ where: { accountId, sourceType: 'crossplat' } });
    expect(row).toBeTruthy();
    expect(row!.title).toBe('前端构建优化实战全解');
    expect(row!.queue).toBe('week');
    expect(row!.evidence).toContain('小红书尚未发过同题内容');
  });
});

describe('成本护栏', () => {
  it('新增三个候选源后，精排调用次数仍等于 topN（+至多 1 个探索位）', async () => {
    const { workspaceId, accountId } = await seedAccount();
    // 三类候选同时在场，候选池远大于 topN
    await seedGapCluster('前端构建工具链集体大改版');
    for (let i = 0; i < 8; i++) await hot('bilibili', i + 1, `前端性能优化话题${i}`, 500 - i);
    for (let i = 0; i < 3; i++) {
      await prisma.publishRecord.create({
        data: {
          accountId, platform: 'bilibili', title: `日常内容第${i}期`,
          publishedAt: DAYS(20 + i), metrics: JSON.stringify({ views: 1000 }),
        },
      });
    }
    await prisma.publishRecord.create({
      data: {
        accountId, platform: 'bilibili', title: '独立爆款选题全解',
        publishedAt: DAYS(15), metrics: JSON.stringify({ views: 20000 }),
      },
    });

    await generateRecommendations(accountId, workspaceId, 4);
    const calls = await prisma.llmCallLog.count({ where: { fn: 'scoring' } });
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(calls).toBeLessThanOrEqual(5); // topN + 至多 1 个探索位，一次都不许多
  });
});

// 故障隔离用例一律精确 spy 到**该源自己的入口函数**上。两条不要踩的坑：
//   1) 别图省事去 mock prisma.publishRecord.findMany 这类共享取数——那条路径同时服务于
//      buildAccountContext 的基线块，打断它测到的是「基线挂了会怎样」，不是「新源挂了会怎样」；
//   2) 更别 spy 任何 prisma 方法：vi.restoreAllMocks() 恢复不回 Prisma 的代理属性，
//      会把 findMany 留成 undefined 泄漏给同文件后续用例（本文件踩过）。
describe('新源故障隔离', () => {
  afterEach(() => vi.restoreAllMocks());

  it('时间差雷达取数抛错 → 热榜候选照常出推荐，不整次失败', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('bilibili', 1, '前端工程化实践指南', 500);
    await seedGapCluster('前端构建工具链集体大改版'); // 正常时本会产出一条抢跑候选
    vi.spyOn(gap, 'gapCandidates').mockRejectedValue(new Error('库挂了'));

    const r = await generateRecommendations(accountId, workspaceId, 3);
    expect(r.created).toBeGreaterThan(0);
    expect(await prisma.topicIdea.count({ where: { accountId, sourceType: 'gap' } })).toBe(0);
  });

  it('自有作品取数抛错 → 翻新/自搬运缺席，其余照常', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('bilibili', 1, '前端工程化实践指南', 500);
    for (let i = 0; i < 3; i++) {
      await prisma.publishRecord.create({
        data: {
          accountId, platform: 'bilibili', title: `日常内容第${i}期`,
          publishedAt: DAYS(20 + i), metrics: JSON.stringify({ views: 1000 }),
        },
      });
    }
    await prisma.publishRecord.create({
      data: {
        accountId, platform: 'bilibili', title: '独立爆款选题全解',
        publishedAt: DAYS(15), metrics: JSON.stringify({ views: 20000 }),
      },
    });
    vi.spyOn(recycle, 'loadOwnWorks').mockRejectedValue(new Error('库挂了'));

    const r = await generateRecommendations(accountId, workspaceId, 3);
    expect(r.created).toBeGreaterThan(0);
    // 这条自搬运候选在取数正常时本会出现（见上面的用例），取数挂掉就该干净缺席
    expect(await prisma.topicIdea.count({ where: { accountId, sourceType: 'crossplat' } })).toBe(0);
  });
});

describe('常青储备与每日推荐互不干扰', () => {
  it('生成今日推荐不会清掉常青储备（否则每天要为同一批题重复付精排的钱）', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await prisma.topicIdea.create({
      data: { accountId, title: '常青题一', angle: 'a', queue: 'evergreen', state: 'recommended' },
    });
    await hot('bilibili', 1, '前端工程化实践指南', 500);
    await generateRecommendations(accountId, workspaceId, 3);

    expect(await prisma.topicIdea.count({ where: { accountId, queue: 'evergreen' } })).toBe(1);
  });

  it('上一轮的今日推荐照常被清掉（只有常青豁免）', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await prisma.topicIdea.create({
      data: { accountId, title: '昨天的推荐', angle: 'a', queue: 'today', state: 'recommended' },
    });
    await hot('bilibili', 1, '前端工程化实践指南', 500);
    await generateRecommendations(accountId, workspaceId, 3);

    expect(await prisma.topicIdea.count({ where: { accountId, title: '昨天的推荐' } })).toBe(0);
  });
});
