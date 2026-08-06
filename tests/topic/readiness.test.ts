import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { computeReadiness, materialHint, loadReadiness, type ReadinessInput } from '@/lib/topic/readiness';
import { RECYCLE_MIN_AGE_DAYS, MIN_BASELINE_SAMPLE } from '@/lib/topic/sources/recycle';
import { MIN_COMPETITOR_SAMPLE } from '@/lib/topic/sources/gap';
import { emptyPersona, type PersonaCard } from '@/lib/persona';

// 候选源就绪度（lib/topic/readiness.ts）——冷启动引导的算料。
//
// 这块最大的风险不是算错，是**算得和候选源不一样**：清单说「已解锁」而实际仍然沉默，
// 比没有清单更糟——一个会撒谎的进度条会摧毁用户对整个推荐的信任。
// 所以本文件的重头戏是「阈值取自各源导出的常量」和「边界值上两边一致」。

const NOW = new Date('2026-07-22T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const persona = (over: Partial<PersonaCard> = {}): PersonaCard => ({
  ...emptyPersona(),
  identity: '家居收纳博主',
  niche: '家居收纳',
  platforms: ['xiaohongshu', 'douyin'],
  ...over,
});

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    persona: persona(),
    competitorCount: 0,
    competitorPostsByPlatform: {},
    crossPlatformClusters: 0,
    ownWorks: [],
    materialCount: 0,
    inspirationCount: 0,
    hotItemCount: 0,
    ...over,
  };
}

const get = (r: ReturnType<typeof computeReadiness>, key: string) => r.sources.find((s) => s.key === key)!;

describe('冷启动：新用户第一天的真实样子', () => {
  it('八个来源里只有节点日历与常青储备能开口（这正是实测到的问题）', () => {
    const r = computeReadiness(input(), NOW);
    const active = r.sources.filter((s) => s.state === 'active').map((s) => s.key);
    expect(active.sort()).toEqual(['calendar', 'evergreen']);
    expect(r.cold).toBe(true);
  });

  it('每条沉默都必须给出「为什么」和「怎么办」——只说未解锁等于把锅甩给用户', () => {
    const r = computeReadiness(input(), NOW);
    for (const s of r.sources.filter((x) => x.state === 'dormant')) {
      expect(s.reason.length, s.key).toBeGreaterThan(4);
      expect(s.action, `${s.key} 缺解锁动作`).toBeTruthy();
      expect(s.action!.href.startsWith('/'), s.key).toBe(true);
    }
  });

  it('数据补齐后八个来源全部激活，且不再算冷', () => {
    const r = computeReadiness(
      input({
        hotItemCount: 40,
        competitorCount: 3,
        competitorPostsByPlatform: { xiaohongshu: 10 },
        crossPlatformClusters: 2,
        ownWorks: [
          ...Array.from({ length: 3 }, () => ({ platform: 'xiaohongshu', publishedAt: daysAgo(60), views: 1000 })),
        ],
        inspirationCount: 2,
      }),
      NOW,
    );
    expect(r.sources.every((s) => s.state === 'active')).toBe(true);
    expect(r.active).toBe(8);
    expect(r.cold).toBe(false);
  });
});

// 下面这组是本文件的核心：边界值必须与候选源的门槛同进同退。
describe('判定口径与候选源一致（漂移即撒谎）', () => {
  it('旧文翻新：正好卡在 RECYCLE_MIN_AGE_DAYS 上，差一天就不算', () => {
    const younger = computeReadiness(
      input({ ownWorks: [{ platform: 'xiaohongshu', publishedAt: daysAgo(RECYCLE_MIN_AGE_DAYS - 1), views: 100 }] }),
      NOW,
    );
    expect(get(younger, 'recycle').state).toBe('dormant');
    const older = computeReadiness(
      input({ ownWorks: [{ platform: 'xiaohongshu', publishedAt: daysAgo(RECYCLE_MIN_AGE_DAYS), views: 100 }] }),
      NOW,
    );
    expect(get(older, 'recycle').state).toBe('active');
  });

  it('跨平台补发：正好卡在 MIN_BASELINE_SAMPLE 上', () => {
    const few = Array.from({ length: MIN_BASELINE_SAMPLE - 1 }, () => ({
      platform: 'xiaohongshu', publishedAt: daysAgo(10), views: 1000,
    }));
    expect(get(computeReadiness(input({ ownWorks: few }), NOW), 'crossplat').state).toBe('dormant');
    const enough = [...few, { platform: 'xiaohongshu', publishedAt: daysAgo(10), views: 1000 }];
    expect(get(computeReadiness(input({ ownWorks: enough }), NOW), 'crossplat').state).toBe('active');
  });

  it('跨平台补发：0 播放的作品不算样本（与 platformBaselines 同口径）', () => {
    const zeroViews = Array.from({ length: 5 }, () => ({
      platform: 'xiaohongshu', publishedAt: daysAgo(10), views: 0,
    }));
    expect(get(computeReadiness(input({ ownWorks: zeroViews }), NOW), 'crossplat').state).toBe('dormant');
  });

  it('抢跑窗口：无热榜源的平台正好卡在 MIN_COMPETITOR_SAMPLE 上', () => {
    // 小红书没有公开热榜，只能靠同行样本代替
    const base = { persona: persona({ platforms: ['xiaohongshu'] }), crossPlatformClusters: 2 };
    const few = computeReadiness(
      input({ ...base, competitorPostsByPlatform: { xiaohongshu: MIN_COMPETITOR_SAMPLE - 1 } }),
      NOW,
    );
    expect(get(few, 'gap').state).toBe('dormant');
    expect(get(few, 'gap').reason).toContain(String(MIN_COMPETITOR_SAMPLE));
    const enough = computeReadiness(
      input({ ...base, competitorPostsByPlatform: { xiaohongshu: MIN_COMPETITOR_SAMPLE } }),
      NOW,
    );
    expect(get(enough, 'gap').state).toBe('active');
  });

  it('抢跑窗口：有热榜源的平台不需要同行样本（与 isHotlistObservable 同口径）', () => {
    const r = computeReadiness(
      input({ persona: persona({ platforms: ['douyin'] }), crossPlatformClusters: 1 }),
      NOW,
    );
    expect(get(r, 'gap').state).toBe('active');
  });

  it('抢跑窗口：没有跨平台簇时如实说「等下一波热点」，而不是怪用户没配数据', () => {
    const r = computeReadiness(
      input({ persona: persona({ platforms: ['douyin'] }), crossPlatformClusters: 0 }),
      NOW,
    );
    expect(get(r, 'gap').state).toBe('dormant');
    expect(get(r, 'gap').reason).toContain('跨平台扩散');
    expect(get(r, 'gap').action!.text).toContain('不用做什么');
  });

  it('常青与日历：没有赛道词就沉默（与 nicheWord 同口径）', () => {
    const r = computeReadiness(input({ persona: emptyPersona() }), NOW);
    expect(get(r, 'evergreen').state).toBe('dormant');
    expect(get(r, 'calendar').state).toBe('dormant');
    expect(get(r, 'evergreen').action!.href).toBe('/persona');
  });

  it('跨平台补发：只经营一个平台时说「没有可搬运的去处」，不去怪数据量', () => {
    const r = computeReadiness(
      input({
        persona: persona({ platforms: ['xiaohongshu'] }),
        ownWorks: Array.from({ length: 10 }, () => ({ platform: 'xiaohongshu', publishedAt: daysAgo(10), views: 1000 })),
      }),
      NOW,
    );
    expect(get(r, 'crossplat').state).toBe('dormant');
    expect(get(r, 'crossplat').reason).toContain('一个平台');
  });
});

describe('素材唤醒提示（不是候选源，单独提示）', () => {
  it('素材库为空才提示', () => {
    expect(materialHint(0)).toBeTruthy();
    expect(materialHint(1)).toBeNull();
  });
});

describe('冷热阈值', () => {
  it('沉默 ≥3 个才算冷（少于这个数，用户至少还看得到一类差异化）', () => {
    // 只差灵感箱与竞对两项 → 不算冷
    const warm = computeReadiness(
      input({
        hotItemCount: 10,
        crossPlatformClusters: 1,
        competitorPostsByPlatform: { xiaohongshu: 5 },
        ownWorks: Array.from({ length: 3 }, () => ({ platform: 'xiaohongshu', publishedAt: daysAgo(60), views: 900 })),
      }),
      NOW,
    );
    expect(warm.total - warm.active).toBeLessThan(3);
    expect(warm.cold).toBe(false);
  });
});

describe('loadReadiness 取数（与真实库对拍）', () => {
  beforeEach(async () => {
    await prisma.inspirationItem.deleteMany();
    await prisma.material.deleteMany();
    await prisma.publishRecord.deleteMany();
    await prisma.ownPost.deleteMany();
    await prisma.hotItem.deleteMany();
    await prisma.topicCluster.deleteMany();
    await prisma.watchlistItem.deleteMany();
    await prisma.competitorAccount.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
  });

  async function seed(personaCard = JSON.stringify(persona())) {
    const t = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'a', platform: 'xiaohongshu', personaCard },
    });
    return { workspaceId: ws.id, accountId: acc.id };
  }

  it('空库 → 与冷启动实测一致：只有日历和常青在工作', async () => {
    const { workspaceId, accountId } = await seed();
    const r = await loadReadiness(workspaceId, accountId);
    expect(r.sources.filter((s) => s.state === 'active').map((s) => s.key).sort()).toEqual(['calendar', 'evergreen']);
    expect(r.cold).toBe(true);
    expect(r.material).toBeTruthy(); // 素材库也空
  });

  it('订阅竞对后，竞对源转为激活', async () => {
    const { workspaceId, accountId } = await seed();
    const comp = await prisma.competitorAccount.create({
      data: { platform: 'xiaohongshu', handle: 'h1', name: '同行' },
    });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: comp.id } });
    const r = await loadReadiness(workspaceId, accountId);
    expect(r.sources.find((s) => s.key === 'competitor')!.state).toBe('active');
  });

  it('只数跨平台簇：单源簇不算（与 gap.ts 的 MIN_SPREAD_SOURCES 同口径）', async () => {
    const { workspaceId, accountId } = await seed(JSON.stringify(persona({ platforms: ['douyin'] })));
    const c1 = await prisma.topicCluster.create({ data: { title: '单源簇', sources: '[]' } });
    await prisma.hotItem.create({ data: { source: 'weibo', rank: 1, title: 'a', clusterId: c1.id } });
    const r1 = await loadReadiness(workspaceId, accountId);
    expect(r1.sources.find((s) => s.key === 'gap')!.state).toBe('dormant');

    const c2 = await prisma.topicCluster.create({ data: { title: '跨源簇', sources: '[]' } });
    await prisma.hotItem.create({ data: { source: 'weibo', rank: 1, title: 'b', clusterId: c2.id } });
    await prisma.hotItem.create({ data: { source: 'zhihu', rank: 1, title: 'c', clusterId: c2.id } });
    const r2 = await loadReadiness(workspaceId, accountId);
    expect(r2.sources.find((s) => s.key === 'gap')!.state).toBe('active');
  });

  it('灵感箱只数「待用」的（已转选题/已归档的不算解锁）', async () => {
    const { workspaceId, accountId } = await seed();
    await prisma.inspirationItem.create({ data: { workspaceId, title: '已用掉', state: 'used' } });
    expect((await loadReadiness(workspaceId, accountId)).sources.find((s) => s.key === 'inspiration')!.state).toBe('dormant');
    await prisma.inspirationItem.create({ data: { workspaceId, title: '待用', state: 'open' } });
    expect((await loadReadiness(workspaceId, accountId)).sources.find((s) => s.key === 'inspiration')!.state).toBe('active');
  });
});
