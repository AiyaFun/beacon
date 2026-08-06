import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  matchReferences,
  pickBenchmark,
  buildBattleCards,
  hasBattleContent,
  formatViews,
  lightTrialAdvice,
  lightPlatformsOf,
} from '@/lib/topic/battlecard';

// 选题作战卡（lib/topic/battlecard.ts）。
// 最该守住的一条：**卡里只有事实，没有预测**。
// 最初的设计是「预期播放区间 = 账号均播 × LLM 流量分」，那是把主观分乘上实测值，
// 得到一个看起来像数据的猜测。改成给真实水位锚点，让用户自己判断。

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000);
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

describe('matchReferences 同题匹配', () => {
  const posts = [
    { title: '前端构建优化的五个技巧', url: 'https://e.com/1', platform: 'bilibili', views: 50000, recent: true },
    { title: '前端构建提速实战', url: null, platform: 'douyin', views: 120000, recent: false },
    { title: '前端构建工具怎么选', url: 'https://e.com/3', platform: 'bilibili', views: 3000, recent: true },
    { title: '今天中午吃什么', url: null, platform: 'douyin', views: 999999, recent: true },
  ];

  it('按播放降序取前 3 条：要看就看做得最好的', () => {
    const r = matchReferences('前端构建优化又火了', posts);
    expect(r.references.map((x) => x.views)).toEqual([120000, 50000, 3000]);
    expect(r.references.every((x) => x.title.includes('前端构建'))).toBe(true);
  });

  it('竞争密度只数近 72 小时的：一个月前有人做过不代表现在挤', () => {
    // 4 条里 3 条同题，但其中一条不是近期的
    expect(matchReferences('前端构建优化又火了', posts).rivals).toBe(2);
  });

  it('不相关的高播放作品不会混进参考样本', () => {
    expect(matchReferences('前端构建优化又火了', posts).references.some((r) => r.title.includes('吃什么'))).toBe(false);
  });

  it('没有同题作品 → 空样本、零密度（而不是硬凑几条不相关的）', () => {
    const r = matchReferences('完全没人做过的冷门话题', posts);
    expect(r.references).toEqual([]);
    expect(r.rivals).toBe(0);
  });

  it('竞对库为空 → 不崩', () => {
    expect(matchReferences('随便什么', [])).toEqual({ references: [], rivals: 0 });
  });
});

describe('pickBenchmark 表现锚点', () => {
  it('取发布记录最多的平台——那才是他真正在经营的', () => {
    const b = pickBenchmark([
      { platform: 'bilibili', metrics: JSON.stringify({ views: 1000 }) },
      { platform: 'bilibili', metrics: JSON.stringify({ views: 3000 }) },
      { platform: 'bilibili', metrics: JSON.stringify({ views: 2000 }) },
      { platform: 'douyin', metrics: JSON.stringify({ views: 999999 }) },
    ])!;
    expect(b.platform).toBe('bilibili');
    expect(b.avgViews).toBe(2000);
    expect(b.bestViews).toBe(3000);
    expect(b.sample).toBe(3);
  });

  it('0 播放的记录不计入（那多半是没回流到数据）', () => {
    const b = pickBenchmark([
      { platform: 'bilibili', metrics: JSON.stringify({ views: 1000 }) },
      { platform: 'bilibili', metrics: JSON.stringify({ views: 3000 }) },
      { platform: 'bilibili', metrics: '{}' },
    ])!;
    expect(b.sample).toBe(2);
    expect(b.avgViews).toBe(2000);
  });

  it('完全没有带播放的记录 → null，新账号不该看到凭空的对标数字', () => {
    expect(pickBenchmark([])).toBeNull();
    expect(pickBenchmark([{ platform: 'bilibili', metrics: '{}' }])).toBeNull();
  });
});

describe('hasBattleContent / formatViews', () => {
  const empty = { references: [], bestSlot: null, rivals: 0, benchmark: null, lightTrial: null };

  it('全空 → 不渲染（不给用户一个点开发现空空如也的折叠块）', () => {
    expect(hasBattleContent(undefined)).toBe(false);
    expect(hasBattleContent(empty)).toBe(false);
  });

  it('任一块有内容即渲染', () => {
    expect(hasBattleContent({ ...empty, rivals: 2 })).toBe(true);
    expect(
      hasBattleContent({ ...empty, benchmark: { platform: 'bilibili', avgViews: 1, bestViews: 1, sample: 1 } }),
    ).toBe(true);
    expect(hasBattleContent({ ...empty, lightTrial: '建议先出图文' })).toBe(true);
  });

  it('播放数按万折算', () => {
    expect(formatViews(9999)).toBe('9999');
    expect(formatViews(12800)).toBe('1.3万');
  });
});

// 小成本验证建议：两个信号必须同时成立才开口。
// 对一个执行力很强的账号说「你可能做不完」是冒犯且没用，所以宁可少说。
describe('lightTrialAdvice 小成本验证', () => {
  const base = { costScore: 30, abandonedCount: 3, lightPlatforms: ['xiaohongshu'] };

  it('贵 + 有做不完的历史 → 给建议，并说清依据的两个数', () => {
    const s = lightTrialAdvice(base)!;
    expect(s).toContain('制作成本评分只有 30');
    expect(s).toContain('3 次');
    expect(s).toContain('小红书');
  });

  it('不贵就不说——有些贵内容本来就该做，便宜内容更没必要劝', () => {
    expect(lightTrialAdvice({ ...base, costScore: 70 })).toBeNull();
  });

  it('LLM 失败时的默认占位分（55）不触发——不能拿「没判断」去劝退用户', () => {
    expect(lightTrialAdvice({ ...base, costScore: 55 })).toBeNull();
  });

  it('拿不到成本分 → 不说', () => {
    expect(lightTrialAdvice({ ...base, costScore: null })).toBeNull();
  });

  it('只废过一次稿不算模式，不说', () => {
    expect(lightTrialAdvice({ ...base, abandonedCount: 1 })).toBeNull();
    expect(lightTrialAdvice({ ...base, abandonedCount: 0 })).toBeNull();
  });

  it('没有轻形态平台 → 只说形态，不编一个他没经营的平台出来', () => {
    const s = lightTrialAdvice({ ...base, lightPlatforms: [] })!;
    expect(s).toContain('图文或短文形态');
    expect(s).not.toContain('小红书');
  });

  it('轻形态平台识别：图文/文章/短文算轻，长短视频不算', () => {
    expect(lightPlatformsOf(['xiaohongshu', 'wechat', 'x', 'douyin', 'bilibili', 'shipinhao']).sort()).toEqual(
      ['wechat', 'x', 'xiaohongshu'].sort(),
    );
    expect(lightPlatformsOf(['douyin'])).toEqual([]);
    expect(lightPlatformsOf(['不存在的平台'])).toEqual([]);
  });
});

describe('buildBattleCards 取数集成', () => {
  let seq = 0;
  async function seed() {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'a', platform: 'bilibili' },
    });
    return { workspaceId: ws.id, accountId: acc.id };
  }

  async function seedRival(workspaceId: string, title: string, views: number, publishedAt: Date) {
    const comp = await prisma.competitorAccount.create({
      data: { platform: 'bilibili', handle: `h-${++seq}`, name: '竞对' },
    });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: comp.id } });
    await prisma.crawledPost.create({
      data: {
        competitorId: comp.id, platform: 'bilibili', platformItemId: `p-${++seq}`,
        title, url: `https://e.com/${seq}`, publishedAt, metrics: JSON.stringify({ views }),
      },
    });
  }

  beforeEach(async () => {
    await prisma.crawledPost.deleteMany();
    await prisma.watchlistItem.deleteMany();
    await prisma.competitorAccount.deleteMany();
    await prisma.publishRecord.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
  });

  it('参考样本 + 竞争密度 + 时段 + 锚点一起给出', async () => {
    const { workspaceId, accountId } = await seed();
    await seedRival(workspaceId, '前端构建优化五个技巧', 50000, hoursAgo(10));
    await seedRival(workspaceId, '前端构建提速实战', 20000, daysAgo(20)); // 参考窗口内、密度窗口外
    // 发布时段要 ≥3 条同桶才下结论；publishedAt 用 UTC 04:00 = 北京时间 12:00（午间）
    for (let i = 0; i < 3; i++) {
      await prisma.publishRecord.create({
        data: {
          accountId, platform: 'bilibili', title: `我的第${i}条`,
          publishedAt: new Date(NOW - (i + 1) * 86_400_000 - ((NOW - (i + 1) * 86_400_000) % 86_400_000) + 4 * 3600_000),
          metrics: JSON.stringify({ views: 1000 * (i + 1) }),
        },
      });
    }

    const cards = await buildBattleCards(workspaceId, accountId, [{ id: 't1', title: '前端构建优化又火了' }]);
    const c = cards.get('t1')!;
    expect(c.references.map((r) => r.views)).toEqual([50000, 20000]);
    expect(c.rivals).toBe(1); // 只有 10 小时前那条算「现在挤」
    expect(c.benchmark).toEqual({ platform: 'bilibili', avgViews: 2000, bestViews: 3000, sample: 3 });
    expect(c.bestSlot?.sample).toBe(3);
  });

  it('新账号（无竞对、无发布记录）→ 四块全空，页面据此不渲染作战卡', async () => {
    const { workspaceId, accountId } = await seed();
    const cards = await buildBattleCards(workspaceId, accountId, [{ id: 't1', title: '随便什么选题' }]);
    expect(hasBattleContent(cards.get('t1'))).toBe(false);
  });

  it('发布记录样本不足 → 不给时段结论（小样本时段结论是噪声）', async () => {
    const { workspaceId, accountId } = await seed();
    await prisma.publishRecord.create({
      data: { accountId, platform: 'bilibili', title: '唯一一条', publishedAt: hoursAgo(50), metrics: JSON.stringify({ views: 1000 }) },
    });
    const cards = await buildBattleCards(workspaceId, accountId, [{ id: 't1', title: '随便什么' }]);
    expect(cards.get('t1')!.bestSlot).toBeNull();
    // 但锚点仍然给：那只是「你发过一条、播放多少」的事实陈述，不需要样本量门槛
    expect(cards.get('t1')!.benchmark?.sample).toBe(1);
  });

  it('小成本验证走真实的废稿计数与人设平台', async () => {
    const { workspaceId, accountId } = await seed();
    await prisma.creatorAccount.update({
      where: { id: accountId },
      data: { personaCard: JSON.stringify({ platforms: ['bilibili', 'xiaohongshu'] }) },
    });
    for (let i = 0; i < 2; i++) {
      await prisma.draft.create({
        data: { accountId, title: `废稿${i}`, platform: 'bilibili', status: 'abandoned' },
      });
    }
    const cards = await buildBattleCards(workspaceId, accountId, [
      { id: 'cheap', title: 'A', scores: JSON.stringify({ cost: 80 }) },
      { id: 'pricey', title: 'B', scores: JSON.stringify({ cost: 25 }) },
    ]);
    expect(cards.get('cheap')!.lightTrial).toBeNull();
    expect(cards.get('pricey')!.lightTrial).toContain('小红书'); // 人设里唯一的轻形态平台
  });

  it('没有废稿历史 → 再贵的选题也不劝退', async () => {
    const { workspaceId, accountId } = await seed();
    const cards = await buildBattleCards(workspaceId, accountId, [
      { id: 't1', title: 'A', scores: JSON.stringify({ cost: 10 }) },
    ]);
    expect(cards.get('t1')!.lightTrial).toBeNull();
  });

  it('空选题列表 → 空 Map，不打库', async () => {
    const { workspaceId, accountId } = await seed();
    expect((await buildBattleCards(workspaceId, accountId, [])).size).toBe(0);
  });

  it('别的工作区的竞对作品不算数', async () => {
    const mine = await seed();
    const other = await seed();
    await seedRival(other.workspaceId, '前端构建优化五个技巧', 50000, hoursAgo(10));
    const cards = await buildBattleCards(mine.workspaceId, mine.accountId, [{ id: 't1', title: '前端构建优化又火了' }]);
    expect(cards.get('t1')!.references).toEqual([]);
    expect(cards.get('t1')!.rivals).toBe(0);
  });
});
