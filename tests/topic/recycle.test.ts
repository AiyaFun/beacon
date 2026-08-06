import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  platformBaselines,
  enrichWithRecycle,
  crossPlatformFindings,
  crossPlatformCandidates,
  dropDuplicateCrossPlat,
  loadOwnWorks,
  type OwnWork,
} from '@/lib/topic/sources/recycle';
import type { Candidate } from '@/lib/topic/scoring';
import type { PersonaCard } from '@/lib/persona';

// 旧文翻新与跨平台自搬运（lib/topic/sources/recycle.ts）。
// 这是唯一「你自己的账号验证过」的候选源，所以本文件反复锁的是同一条纪律：
// **样本不足就不下结论**——不拿 1 条作品的「均值」去说谁跑赢了谁。

const NOW = new Date('2026-07-22T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function work(over: Partial<OwnWork> = {}): OwnWork {
  return {
    id: 'w1',
    source: 'publish',
    platform: 'bilibili',
    title: '前端构建优化实战',
    publishedAt: daysAgo(60),
    views: 1000,
    ...over,
  };
}

const persona = (platforms: string[]): PersonaCard => ({
  identity: '前端工程师',
  audience: '前端新人',
  valueProp: '讲明白工具链',
  canDo: [],
  cantDo: [],
  tone: '干货',
  platforms,
  niche: '前端工程化',
});

describe('platformBaselines 基线', () => {
  it('样本 ≥3 才算基线，2 条以下的平台直接缺席（不拿噪声当均值）', () => {
    const b = platformBaselines([
      work({ id: '1', platform: 'bilibili', views: 100 }),
      work({ id: '2', platform: 'bilibili', views: 200 }),
      work({ id: '3', platform: 'bilibili', views: 300 }),
      work({ id: '4', platform: 'douyin', views: 999 }),
      work({ id: '5', platform: 'douyin', views: 888 }),
    ]);
    expect(b.get('bilibili')).toEqual({ mean: 200, sample: 3 });
    expect(b.has('douyin')).toBe(false);
  });

  it('0 播放不计入均值——那多半是没回流到数据，不是真的没人看', () => {
    const b = platformBaselines([
      work({ id: '1', views: 300 }),
      work({ id: '2', views: 300 }),
      work({ id: '3', views: 300 }),
      work({ id: '4', views: 0 }),
    ]);
    expect(b.get('bilibili')).toEqual({ mean: 300, sample: 3 });
  });
});

describe('enrichWithRecycle 话题回温', () => {
  const hot = (title: string): Candidate => ({ title, heat: 0.8, sourceType: 'douyin', sourceRef: 'h1' });

  const works = [
    work({ id: '1', title: '前端构建优化实战', views: 5000, publishedAt: daysAgo(150) }),
    work({ id: '2', title: '前端构建提速技巧', views: 800, publishedAt: daysAgo(120) }),
    work({ id: '3', title: '前端构建工具横评', views: 900, publishedAt: daysAgo(100) }),
  ];
  const baselines = platformBaselines(works);

  it('命中旧作 → 来源改写成「旧文翻新」并挂上事实证据', () => {
    const [c] = enrichWithRecycle([hot('前端构建优化又火了')], works, baselines, NOW);
    expect(c.sourceType).toBe('recycle');
    // 取表现最好的那条当证据（5000 播放那条，不是最近那条）
    expect(c.evidence).toContain('前端构建优化实战');
    expect(c.evidence).toContain('5000播放');
    expect(c.evidence).toContain('均值'); // 样本 3 条够，才敢报均值
  });

  it('多条相关旧作 → 提示可整合成合集', () => {
    const [c] = enrichWithRecycle([hot('前端构建优化又火了')], works, baselines, NOW);
    expect(c.windowHint).toContain('3 条相关内容');
  });

  it('不新增候选，只改写已有的——同题两条推荐是纯噪声', () => {
    const out = enrichWithRecycle([hot('前端构建优化又火了'), hot('完全无关的娱乐八卦')], works, baselines, NOW);
    expect(out).toHaveLength(2);
    expect(out[1].sourceType).toBe('douyin'); // 没命中的原样不动
    expect(out[1].evidence).toBeUndefined();
  });

  it('旧作太新（不足 30 天）→ 那叫重复发，不叫翻新', () => {
    const fresh = [work({ id: '1', title: '前端构建优化实战', publishedAt: daysAgo(10) })];
    const [c] = enrichWithRecycle([hot('前端构建优化又火了')], fresh, platformBaselines(fresh), NOW);
    expect(c.sourceType).toBe('douyin');
  });

  it('已被抢跑窗口认领的候选不抢——时间信号比「你做过」更强', () => {
    const gap: Candidate = { title: '前端构建优化又火了', heat: 0.9, sourceType: 'gap', evidence: '原证据' };
    const [c] = enrichWithRecycle([gap], works, baselines, NOW);
    expect(c.sourceType).toBe('gap');
    expect(c.evidence).toBe('原证据');
  });

  it('样本不足时只陈述硬事实，不报均值', () => {
    const few = [work({ id: '1', title: '前端构建优化实战', views: 5000, publishedAt: daysAgo(150) })];
    const [c] = enrichWithRecycle([hot('前端构建优化又火了')], few, platformBaselines(few), NOW);
    expect(c.evidence).toContain('5000播放');
    expect(c.evidence).not.toContain('均值');
  });

  it('没有够老的旧作 → 整个池子原样返回', () => {
    const out = enrichWithRecycle([hot('随便什么热点')], [], new Map(), NOW);
    expect(out[0].sourceType).toBe('douyin');
  });
});

describe('crossPlatformFindings 跨平台自搬运', () => {
  const base = [
    work({ id: '1', platform: 'bilibili', title: '普通内容一', views: 1000, publishedAt: daysAgo(30) }),
    work({ id: '2', platform: 'bilibili', title: '普通内容二', views: 1000, publishedAt: daysAgo(20) }),
    work({ id: '3', platform: 'bilibili', title: '普通内容三', views: 1000, publishedAt: daysAgo(10) }),
  ];

  it('跑赢自己均值 1.5 倍的爆款 → 报到还没发过的主战平台', () => {
    const hit = work({ id: '4', platform: 'bilibili', title: '前端构建优化实战', views: 5000, publishedAt: daysAgo(15) });
    const f = crossPlatformFindings([...base, hit], persona(['bilibili', 'xiaohongshu']), NOW);
    expect(f).toHaveLength(1);
    expect(f[0].work.id).toBe('4');
    expect(f[0].targets).toEqual(['xiaohongshu']);
    expect(f[0].ratio).toBeGreaterThan(1.5);
  });

  it('没跑赢自己的平均线 → 搬过去也未必成，不报', () => {
    const meh = work({ id: '4', platform: 'bilibili', title: '前端构建优化实战', views: 1100, publishedAt: daysAgo(15) });
    expect(crossPlatformFindings([...base, meh], persona(['bilibili', 'xiaohongshu']), NOW)).toEqual([]);
  });

  it('目标平台已经发过同题 → 不是缺口', () => {
    const hit = work({ id: '4', platform: 'bilibili', title: '前端构建优化实战', views: 5000, publishedAt: daysAgo(15) });
    const already = work({ id: '5', platform: 'xiaohongshu', title: '前端构建优化的三个技巧', views: 200, publishedAt: daysAgo(5) });
    expect(crossPlatformFindings([...base, hit, already], persona(['bilibili', 'xiaohongshu']), NOW)).toEqual([]);
  });

  it('只经营一个平台 → 无处可搬', () => {
    const hit = work({ id: '4', platform: 'bilibili', title: '前端构建优化实战', views: 5000, publishedAt: daysAgo(15) });
    expect(crossPlatformFindings([...base, hit], persona(['bilibili']), NOW)).toEqual([]);
  });

  it('刚发 1 天的不催搬运（数据还在涨，判断不了是不是爆款）；超过半年的也不搬', () => {
    const tooNew = work({ id: '4', platform: 'bilibili', title: '前端构建优化实战', views: 5000, publishedAt: daysAgo(1) });
    const tooOld = work({ id: '5', platform: 'bilibili', title: '另一个爆款内容', views: 5000, publishedAt: daysAgo(300) });
    expect(crossPlatformFindings([...base, tooNew, tooOld], persona(['bilibili', 'xiaohongshu']), NOW)).toEqual([]);
  });

  it('基线样本不足的平台不下「跑赢」结论', () => {
    const only = [
      work({ id: '1', platform: 'bilibili', title: '唯一一条', views: 5000, publishedAt: daysAgo(15) }),
      work({ id: '2', platform: 'bilibili', title: '第二条', views: 100, publishedAt: daysAgo(15) }),
    ];
    expect(crossPlatformFindings(only, persona(['bilibili', 'xiaohongshu']), NOW)).toEqual([]);
  });

  it('敏感标题不许借自搬运绕过隔离', () => {
    const hit = work({ id: '4', platform: 'bilibili', title: '重大交通事故致3伤全记录', views: 5000, publishedAt: daysAgo(15) });
    expect(crossPlatformFindings([...base, hit], persona(['bilibili', 'xiaohongshu']), NOW)).toEqual([]);
  });

  it('倍数越高排越前', () => {
    // 基线是含爆款在内的全量均值（与 lib/algorithm/coach.ts 的 avgViews 同口径），
    // 所以样本要够多，两条爆款才都能站上 1.5 倍线：均值 (6×1000+5000+12000)/8 = 2875。
    const many = Array.from({ length: 6 }, (_, i) =>
      work({ id: `b${i}`, platform: 'bilibili', title: `普通内容${i}`, views: 1000, publishedAt: daysAgo(20) }),
    );
    const a = work({ id: '4', platform: 'bilibili', title: '爆款甲内容', views: 5000, publishedAt: daysAgo(15) });
    const b = work({ id: '5', platform: 'bilibili', title: '爆款乙内容', views: 12000, publishedAt: daysAgo(15) });
    const f = crossPlatformFindings([...many, a, b], persona(['bilibili', 'xiaohongshu']), NOW);
    expect(f.map((x) => x.work.id)).toEqual(['5', '4']);
  });
});

describe('crossPlatformCandidates 转候选', () => {
  it('账号内热度封顶 0.6，绝不在粗排里压过真正的全网热点', async () => {
    const base = Array.from({ length: 3 }, (_, i) =>
      work({ id: `b${i}`, platform: 'bilibili', title: `普通内容${i}`, views: 1000, publishedAt: daysAgo(20) }),
    );
    const monster = work({ id: 'x', platform: 'bilibili', title: '前端构建优化实战', views: 100000, publishedAt: daysAgo(15) });
    const list = await crossPlatformCandidates({
      accountId: 'irrelevant',
      persona: persona(['bilibili', 'xiaohongshu']),
      works: [...base, monster],
      now: NOW,
    });
    expect(list).toHaveLength(1);
    expect(list[0].sourceType).toBe('crossplat');
    expect(list[0].queue).toBe('week');
    expect(list[0].heat).toBe(0.6); // 封顶生效
    expect(list[0].evidence).toContain('小红书尚未发过同题内容');
  });
});

describe('dropDuplicateCrossPlat 同题去重', () => {
  const cross = (title: string): Candidate => ({ title, heat: 0.5, sourceType: 'crossplat' });
  const other = (title: string): Candidate => ({ title, heat: 0.8, sourceType: 'douyin' });

  it('池子里已有同题候选 → 自搬运不再单独占位（真实数据上实测到的重复推荐）', () => {
    const out = dropDuplicateCrossPlat(
      [cross('00后拒绝加班背后的真实原因')],
      [other('00后拒绝无效加班')],
    );
    expect(out).toEqual([]);
  });

  it('无同题候选 → 照常保留', () => {
    const out = dropDuplicateCrossPlat([cross('前端构建优化实战')], [other('明星八卦大瓜')]);
    expect(out).toHaveLength(1);
  });

  it('任一侧为空 → 原样返回，不做无谓计算', () => {
    expect(dropDuplicateCrossPlat([], [other('x')])).toEqual([]);
    const only = [cross('前端构建优化实战')];
    expect(dropDuplicateCrossPlat(only, [])).toEqual(only);
  });
});

describe('loadOwnWorks 取数', () => {
  beforeEach(async () => {
    await prisma.publishRecord.deleteMany();
    await prisma.ownPost.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
  });

  it('发布回流与历史作品回溯两张表都要——缺任一都会让「你做过什么」失真', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'a', platform: 'bilibili' },
    });
    await prisma.publishRecord.create({
      data: {
        accountId: acc.id, platform: 'bilibili', title: '本产品发出去的',
        publishedAt: daysAgo(40), metrics: JSON.stringify({ views: 3000 }),
      },
    });
    await prisma.ownPost.create({
      data: {
        accountId: acc.id, platform: 'bilibili', title: '接入前的存量作品',
        publishedAt: daysAgo(200), metrics: JSON.stringify({ views: 800 }),
      },
    });
    const works = await loadOwnWorks(acc.id);
    expect(works.map((w) => w.source).sort()).toEqual(['own', 'publish']);
    expect(works.find((w) => w.source === 'publish')!.views).toBe(3000);
    expect(works.find((w) => w.source === 'own')!.views).toBe(800);
  });

  it('没有发布时间的历史作品不进池子（算不出年龄，判不了翻新还是重复发）', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, name: 'a', platform: 'bilibili' },
    });
    await prisma.ownPost.create({ data: { accountId: acc.id, platform: 'bilibili', title: '没有发布时间' } });
    expect(await loadOwnWorks(acc.id)).toEqual([]);
  });
});
