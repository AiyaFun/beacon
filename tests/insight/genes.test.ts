import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { buildGeneProfile, loadGeneProfile } from '@/lib/insight/genes';

// 爆款基因画像（lib/insight/genes.ts）。
// 这一页的全部说服力来自「每个数都可以自己验算」，所以本文件反复锁的是：
// **样本不足就不给胜率**（2 条里赢 1 条不是 50% 胜率，是没有结论），
// 以及**基线与作品来自同一窗口**（否则拿半年前的高水位比最近内容，会把正常账号系统性判成一直在输）。

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

type Row = Parameters<typeof buildGeneProfile>[0][number];
const row = (over: Partial<Row> = {}): Row => ({
  platform: 'douyin',
  publishedAt: daysAgo(10),
  views: 1000,
  sourceType: 'hot',
  angle: '从反常识切入',
  ...over,
});

const dim = (p: ReturnType<typeof buildGeneProfile>, key: string) =>
  p.dimensions.find((d) => d.key === key)!;

describe('胜率口径', () => {
  it('胜 = 该条播放 ≥ 同平台均播；3 条起才报胜率', () => {
    const rows = [
      row({ views: 3000 }),
      row({ views: 2000 }),
      row({ views: 100 }),
    ];
    const p = buildGeneProfile(rows, new Map([['douyin', 1700]]));
    const b = dim(p, 'source').buckets[0];
    expect(b.sample).toBe(3);
    expect(b.wins).toBe(2);
    expect(b.winRate).toBeCloseTo(2 / 3);
  });

  it('样本不足 → winRate 为 null 而不是算出来的百分比', () => {
    const p = buildGeneProfile([row({ views: 3000 }), row({ views: 100 })], new Map([['douyin', 1000]]));
    const b = dim(p, 'source').buckets[0];
    expect(b.sample).toBe(2);
    expect(b.wins).toBe(1);
    expect(b.winRate).toBeNull(); // 不是 0.5
    expect(dim(p, 'source').conclusive).toBe(false);
  });

  it('无播放数据的作品不参与统计（没数据不等于表现差）', () => {
    const p = buildGeneProfile([row({ views: 0 }), row({ views: 0 })], new Map([['douyin', 1000]]));
    expect(p.sample).toBe(0);
  });

  it('该平台没有基线 → 该条不参与（没有分母就没有「赢没赢」）', () => {
    const p = buildGeneProfile([row({ platform: 'bilibili', views: 5000 })], new Map([['douyin', 1000]]));
    expect(p.sample).toBe(0);
  });
});

describe('维度切分', () => {
  it('按选题来源分桶，标签用人话不是 sourceType 原始值', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ sourceType: 'gap', views: 3000 })),
      ...Array.from({ length: 3 }, () => row({ sourceType: 'hot', views: 100 })),
    ];
    const p = buildGeneProfile(rows, new Map([['douyin', 1000]]));
    const labels = dim(p, 'source').buckets.map((b) => b.label);
    expect(labels).toContain('抢跑窗口');
    expect(labels).toContain('来自热点');
    expect(labels).not.toContain('gap');
  });

  it('没有选题归因的作品不进「来源」和「切入角」两维，但仍进平台/时段', () => {
    const rows = Array.from({ length: 3 }, () => row({ sourceType: null, angle: null, views: 2000 }));
    const p = buildGeneProfile(rows, new Map([['douyin', 1000]]));
    expect(dim(p, 'source').buckets).toHaveLength(0);
    expect(dim(p, 'angle').buckets).toHaveLength(0);
    expect(dim(p, 'platform').buckets).toHaveLength(1);
    expect(dim(p, 'slot').buckets).toHaveLength(1);
  });

  it('发布时段按北京时间折算', () => {
    // UTC 04:00 = 北京 12:00 → 午间
    const at = new Date(NOW);
    at.setUTCHours(4, 0, 0, 0);
    const p = buildGeneProfile([row({ publishedAt: at, views: 2000 })], new Map([['douyin', 1000]]));
    expect(dim(p, 'slot').buckets[0].label).toContain('午间');
  });

  it('有结论的桶排在没结论的前面，其次按胜率', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => row({ sourceType: 'hot', views: 3000 })),
      ...Array.from({ length: 3 }, () => row({ sourceType: 'gap', views: 100 })),
      ...Array.from({ length: 2 }, () => row({ sourceType: 'recycle', views: 9999 })),
    ];
    const p = buildGeneProfile(rows, new Map([['douyin', 1500]]));
    const keys = dim(p, 'source').buckets.map((b) => b.key);
    expect(keys).toEqual(['hot', 'gap', 'recycle']); // recycle 样本不足垫底，哪怕播放最高
  });
});

describe('头条结论', () => {
  it('取所有维度里达样本线且胜率最高的桶', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ sourceType: 'gap', views: 5000 })),
      ...Array.from({ length: 3 }, () => row({ sourceType: 'hot', views: 100 })),
    ];
    const p = buildGeneProfile(rows, new Map([['douyin', 2000]]));
    expect(p.headline).not.toBeNull();
    expect(p.headline!.winRate).toBe(1);
  });

  it('全部样本不足 → 不给头条结论（宁可不说，也不拿 2 条充数）', () => {
    const p = buildGeneProfile([row({ views: 5000 })], new Map([['douyin', 1000]]));
    expect(p.headline).toBeNull();
  });

  it('空数据不崩', () => {
    const p = buildGeneProfile([], new Map());
    expect(p.sample).toBe(0);
    expect(p.headline).toBeNull();
    expect(p.dimensions.every((d) => d.buckets.length === 0)).toBe(true);
  });
});

describe('loadGeneProfile 取数', () => {
  async function seed() {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
    return acc.id;
  }

  beforeEach(async () => {
    await prisma.publishRecord.deleteMany();
    await prisma.topicIdea.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
  });

  it('串起发布记录与选题归因，来源/切入角都能落到维度上', async () => {
    const accountId = await seed();
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: 'T', angle: '从亲身翻车切入', sourceType: 'gap', state: 'published' },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.publishRecord.create({
        data: {
          accountId, topicId: topic.id, platform: 'douyin', title: `第${i}条`,
          publishedAt: daysAgo(10 + i), metrics: JSON.stringify({ views: 2000 }),
        },
      });
    }
    const p = await loadGeneProfile(accountId);
    expect(p.sample).toBe(3);
    expect(dim(p, 'source').buckets[0].label).toBe('抢跑窗口');
    expect(dim(p, 'angle').buckets[0].label).toBe('从亲身翻车切入');
    // 三条播放一样 → 都等于均播 → 全赢（≥ 基线即算赢）
    expect(dim(p, 'source').buckets[0].winRate).toBe(1);
  });

  it('窗口外的老作品不参与（平台环境已经变了，算进去会误导）', async () => {
    const accountId = await seed();
    await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', title: '很久以前', publishedAt: daysAgo(300), metrics: JSON.stringify({ views: 99999 }) },
    });
    expect((await loadGeneProfile(accountId)).sample).toBe(0);
  });

  it('选题已被删（sourceRef 是松引用）→ 该条仍进平台/时段维，不崩', async () => {
    const accountId = await seed();
    await prisma.publishRecord.create({
      data: { accountId, topicId: 'ghost', platform: 'douyin', title: 'X', publishedAt: daysAgo(5), metrics: JSON.stringify({ views: 1000 }) },
    });
    const p = await loadGeneProfile(accountId);
    expect(p.sample).toBe(1);
    expect(dim(p, 'source').buckets).toHaveLength(0);
  });

  it('无发布记录 → 空画像，页面据此显示引导而不是报错', async () => {
    const accountId = await seed();
    const p = await loadGeneProfile(accountId);
    expect(p.sample).toBe(0);
  });
});
