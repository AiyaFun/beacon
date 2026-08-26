import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { buildBattleReport } from '@/lib/battle/report';
import { toJson } from '@/lib/json';

// 本周作战报告的取数口径守卫。
//
// 这一页把四处数据拼成「今天该做什么」，每一条口径都踩过项目的老坑：
//   · 缺播放量的作品不许按 0 计（否则均值被腰斩、率型凭空变 0）——见 lib/json.ts、
//     记忆「缺席不许当成0」；
//   · 低表现作品要真按完播率挑，不是摆样子；
//   · 竞对 Top5 要真按播放量排。
// mutation 验证过：把 sumViews 的「一条都没有→null」改成「→0」，第一条用例即红。

let seq = 0;
async function seed() {
  seq += 1;
  const tenant = await prisma.tenant.create({ data: { name: `t${seq}` } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: `w${seq}` } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '木子的家', platform: 'xiaohongshu' } });
  return { workspaceId: ws.id, accountId: acc.id };
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeEach(async () => {
  await prisma.publishRecord.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('指标行：缺席不当 0', () => {
  it('🔒 一条作品都没有播放量 → 近7天播放为 null（显示「—」，不是 0）', async () => {
    const { workspaceId, accountId } = await seed();
    // 有作品，但都没有 views（抖音/小红书公开页拿不到播放量的典型情形）
    await prisma.publishRecord.createMany({
      data: [
        { accountId, platform: 'xiaohongshu', title: 'A', publishedAt: daysAgo(1), metrics: toJson({ likes: 10 }) },
        { accountId, platform: 'xiaohongshu', title: 'B', publishedAt: daysAgo(2), metrics: toJson({ likes: 20 }) },
      ],
    });
    const r = await buildBattleReport(workspaceId, accountId);
    const views = r.metrics.find((m) => m.label === '近7天播放');
    expect(views?.value).toBeNull();
    // 更新条数是永远知道的，必须是 2
    expect(r.metrics.find((m) => m.label === '更新条数')?.value).toBe(2);
  });

  it('有播放量时才求和；完播率只对给了完播率的作品求均值', async () => {
    const { workspaceId, accountId } = await seed();
    await prisma.publishRecord.createMany({
      data: [
        { accountId, platform: 'bilibili', title: 'A', publishedAt: daysAgo(1), metrics: toJson({ views: 10000, completion: 0.5, likes: 100, comments: 50 }) },
        { accountId, platform: 'bilibili', title: 'B', publishedAt: daysAgo(2), metrics: toJson({ views: 30000, completion: 0.3, likes: 200 }) },
        { accountId, platform: 'xiaohongshu', title: 'C', publishedAt: daysAgo(3), metrics: toJson({ likes: 5 }) }, // 无 views/completion
      ],
    });
    const r = await buildBattleReport(workspaceId, accountId);
    expect(r.metrics.find((m) => m.label === '近7天播放')?.value).toBe(40000); // C 不进分子
    const comp = r.metrics.find((m) => m.label === '平均完播率')?.value;
    expect(comp).toBeCloseTo(40, 5); // (50+30)/2，C 不参与
    const eng = r.metrics.find((m) => m.label === '互动率')?.value;
    // (100+50 + 200) / (10000+30000) = 350/40000 = 0.875%
    expect(eng).toBeCloseTo(0.875, 3);
  });
});

describe('高潜选题', () => {
  it('只取 recommended，按分排序，最多 3 条，带上人设匹配与切入角', async () => {
    const { workspaceId, accountId } = await seed();
    await prisma.topicIdea.createMany({
      data: [
        { accountId, title: '低分', angle: '角A', state: 'recommended', totalScore: 60, scores: toJson({ personaFit: 70 }) },
        { accountId, title: '高分', angle: '角B', state: 'recommended', totalScore: 90, scores: toJson({ personaFit: 92 }), blueSea: 0.8 },
        { accountId, title: '中分', angle: '角C', state: 'recommended', totalScore: 75, scores: toJson({ personaFit: 80 }) },
        { accountId, title: '已采纳的不该进', angle: '角D', state: 'accepted', totalScore: 99, scores: '{}' },
      ],
    });
    const r = await buildBattleReport(workspaceId, accountId);
    expect(r.hasRecommendations).toBe(true);
    expect(r.ideas.map((i) => i.title)).toEqual(['高分', '中分', '低分']); // 排序 + 排除 accepted
    expect(r.ideas[0].personaFit).toBe(92);
    expect(r.ideas[0].blueSeaPct).toBe(80);
    expect(r.ideas[0].angle).toBe('角B');
  });

  it('没有 recommended → hasRecommendations=false（页面走引导态）', async () => {
    const { workspaceId, accountId } = await seed();
    const r = await buildBattleReport(workspaceId, accountId);
    expect(r.hasRecommendations).toBe(false);
    expect(r.ideas).toEqual([]);
  });
});

describe('低表现作品', () => {
  it('🔒 真按完播率挑（<40%），健康的不进', async () => {
    const { workspaceId, accountId } = await seed();
    await prisma.publishRecord.createMany({
      data: [
        { accountId, platform: 'bilibili', title: '健康作品', publishedAt: daysAgo(1), metrics: toJson({ views: 10000, completion: 0.55 }) },
        { accountId, platform: 'bilibili', title: '低完播', publishedAt: daysAgo(2), metrics: toJson({ views: 10000, completion: 0.22 }) },
      ],
    });
    const r = await buildBattleReport(workspaceId, accountId);
    expect(r.fixes.map((f) => f.title)).toEqual(['低完播']);
    expect(r.fixes[0].diagnosis).toContain('22%');
  });
});

describe('对标 Top5', () => {
  it('🔒 真按播放量排序，缺播放量的排最后', async () => {
    const { workspaceId, accountId } = await seed();
    const c1 = await prisma.competitorAccount.create({ data: { platform: 'bilibili', handle: 'a', name: '住范儿' } });
    const c2 = await prisma.competitorAccount.create({ data: { platform: 'bilibili', handle: 'b', name: '好好住' } });
    await prisma.watchlistItem.createMany({ data: [{ workspaceId, competitorId: c1.id }, { workspaceId, competitorId: c2.id }] });
    await prisma.crawledPost.createMany({
      data: [
        { competitorId: c1.id, platform: 'bilibili', platformItemId: 'p1', title: '小爆款', publishedAt: daysAgo(1), metrics: toJson({ views: 30000 }) },
        { competitorId: c2.id, platform: 'bilibili', platformItemId: 'p2', title: '大爆款', publishedAt: daysAgo(2), metrics: toJson({ views: 120000 }) },
        { competitorId: c1.id, platform: 'bilibili', platformItemId: 'p3', title: '没数据', publishedAt: daysAgo(3), metrics: '{}' },
      ],
    });
    const r = await buildBattleReport(workspaceId, accountId);
    expect(r.rivals.map((x) => x.title)).toEqual(['大爆款', '小爆款', '没数据']);
    expect(r.rivals[0].views).toBe(120000);
    expect(r.rivals[2].views).toBeNull();
  });
});
