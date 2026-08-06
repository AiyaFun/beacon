import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { findGaps, describeGap, gapCandidates } from '@/lib/topic/sources/gap';
import type { PersonaCard } from '@/lib/persona';

// 跨平台时间差雷达（lib/topic/sources/gap.ts）。
//
// 这个源的全部价值在于断言「你的主战平台还没有」。断言错了比不推更糟，所以本文件重点锁的是
// **什么时候闭嘴**：不可观测就不产出，绝不拿「我没看见」当「它不存在」。

const NOW = new Date('2026-07-22T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

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

let seq = 0;
async function seedCluster(opts: {
  title: string;
  sources: string[];
  firstSeenHoursAgo?: number;
  isSensitive?: boolean;
  heat?: number;
}) {
  const cluster = await prisma.topicCluster.create({
    data: {
      title: opts.title,
      sources: JSON.stringify(opts.sources),
      heat: opts.heat ?? 900,
      isSensitive: opts.isSensitive ?? false,
    },
  });
  const firstSeenAt = hoursAgo(opts.firstSeenHoursAgo ?? 5);
  for (const source of opts.sources) {
    await prisma.hotItem.create({
      data: {
        source,
        rank: 1,
        title: `${opts.title}-${source}-${++seq}`,
        heat: opts.heat ?? 900,
        clusterId: cluster.id,
        firstSeenAt,
      },
    });
  }
  return cluster;
}

async function seedWorkspace() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  return ws.id;
}

// 给工作区订阅一个某平台竞对，并铺 n 条近期作品
async function seedCompetitorSample(workspaceId: string, platform: string, titles: string[]) {
  const comp = await prisma.competitorAccount.create({
    data: { platform, handle: `h-${++seq}`, name: '竞对' },
  });
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId: comp.id } });
  for (const title of titles) {
    await prisma.crawledPost.create({
      data: {
        competitorId: comp.id,
        platform,
        platformItemId: `p-${++seq}`,
        title,
        publishedAt: hoursAgo(10),
      },
    });
  }
}

beforeEach(async () => {
  await prisma.hotItem.deleteMany();
  await prisma.topicCluster.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('口径 A：主战平台有热榜源 → 直接观测', () => {
  it('话题已在微博+知乎上榜、抖音榜上没有 → 报抢跑窗口', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'], firstSeenHoursAgo: 5 });
    const gaps = await findGaps({ workspaceId, persona: persona(['douyin']), now: NOW });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].platform).toBe('douyin');
    expect(gaps[0].observation).toBe('hotlist');
    expect(gaps[0].leadHours).toBe(5);
    // 抖音窗口 36h，一半 18h，已过 5h → 还剩 13h
    expect(gaps[0].remainingHours).toBe(13);
  });

  it('话题已经上了你的平台 → 没有抢跑可言，不报', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'douyin'] });
    expect(await findGaps({ workspaceId, persona: persona(['douyin']), now: NOW })).toEqual([]);
  });

  it('只在 1 个平台上榜 → 还谈不上「跨平台扩散」，不报', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo'] });
    expect(await findGaps({ workspaceId, persona: persona(['douyin']), now: NOW })).toEqual([]);
  });

  it('扩散超过 24 小时还没到你的平台 → 多半是调性不合而非机会，不报', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'], firstSeenHoursAgo: 30 });
    expect(await findGaps({ workspaceId, persona: persona(['douyin']), now: NOW })).toEqual([]);
  });

  it('敏感话题簇不许借这个新入口绕过热点隔离', async () => {
    const workspaceId = await seedWorkspace();
    // 簇级标记
    await seedCluster({ title: '某地垮塌事故最新进展', sources: ['weibo', 'zhihu'], isSensitive: true });
    // 条目级兜底：簇没标但标题命中词库
    await seedCluster({ title: '重大交通事故致3伤', sources: ['weibo', 'toutiao'] });
    expect(await findGaps({ workspaceId, persona: persona(['douyin']), now: NOW })).toEqual([]);
  });

  it('人设没填主战平台 → 无从谈「还没到你这」，整源沉默', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'] });
    expect(await findGaps({ workspaceId, persona: persona([]), now: NOW })).toEqual([]);
  });
});

describe('口径 B/C：主战平台无热榜源', () => {
  it('订阅竞对够多且无人做同题 → 用抽样口径报，并在证据里写明是抽样', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'] });
    await seedCompetitorSample(workspaceId, 'xiaohongshu', ['夏日穿搭分享', '通勤妆容教程', '周末探店记录']);
    const gaps = await findGaps({ workspaceId, persona: persona(['xiaohongshu']), now: NOW });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].observation).toBe('competitor-sample');
    expect(gaps[0].sampleSize).toBe(3);
    expect(describeGap(gaps[0]).evidence).toContain('抽样口径');
  });

  it('监控的同行里已经有人做了 → 不是空档，不报', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'] });
    await seedCompetitorSample(workspaceId, 'xiaohongshu', [
      'AI编程助手集体降价了这波怎么选',
      '夏日穿搭分享',
      '通勤妆容教程',
    ]);
    expect(await findGaps({ workspaceId, persona: persona(['xiaohongshu']), now: NOW })).toEqual([]);
  });

  it('口径 C：样本不足 3 条 → 不可观测，闭嘴（不拿「我没看见」当「它不存在」）', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'] });
    await seedCompetitorSample(workspaceId, 'xiaohongshu', ['夏日穿搭分享', '通勤妆容教程']);
    expect(await findGaps({ workspaceId, persona: persona(['xiaohongshu']), now: NOW })).toEqual([]);
  });

  it('口径 C：完全没订阅竞对 → 闭嘴', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'] });
    expect(await findGaps({ workspaceId, persona: persona(['xiaohongshu']), now: NOW })).toEqual([]);
  });

  it('别的工作区的竞对样本不算数（不吃其他租户的订阅数据）', async () => {
    const mine = await seedWorkspace();
    const other = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'] });
    await seedCompetitorSample(other, 'xiaohongshu', ['夏日穿搭分享', '通勤妆容教程', '周末探店记录']);
    expect(await findGaps({ workspaceId: mine, persona: persona(['xiaohongshu']), now: NOW })).toEqual([]);
  });
});

describe('describeGap 文案（会原样进 prompt 并展示给用户，措辞即契约）', () => {
  it('热榜口径：直说对方平台此刻无同题词条', () => {
    const { evidence, windowHint } = describeGap({
      clusterTitle: 'x',
      clusterId: 'c1',
      platform: 'douyin',
      spreadSources: ['weibo', 'zhihu'],
      leadHours: 5,
      remainingHours: 13,
      heat: 900,
      observation: 'hotlist',
    });
    expect(evidence).toContain('微博、知乎');
    expect(evidence).toContain('5 小时前');
    expect(evidence).toContain('抖音热榜此刻仍无同题词条');
    expect(evidence).not.toContain('抽样');
    expect(windowHint).toBe('抖音抢跑窗口约剩 13 小时');
  });
});

describe('gapCandidates 转候选', () => {
  it('热度按主候选池同一把尺归一化，队列钉死在今日突击', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'], heat: 500 });
    const list = await gapCandidates({ workspaceId, persona: persona(['douyin']), maxHeat: 1000, now: NOW });
    expect(list).toHaveLength(1);
    expect(list[0].sourceType).toBe('gap');
    expect(list[0].queue).toBe('today');
    expect(list[0].heat).toBeCloseTo(0.5);
    expect(list[0].evidence).toBeTruthy();
    expect(list[0].windowHint).toBeTruthy();
  });

  it('同一话题在多个主战平台都有空档 → 只出一条，不刷屏', async () => {
    const workspaceId = await seedWorkspace();
    await seedCluster({ title: 'AI编程助手集体降价', sources: ['weibo', 'zhihu'] });
    const list = await gapCandidates({
      workspaceId,
      persona: persona(['douyin', 'bilibili', 'youtube']),
      maxHeat: 1000,
      now: NOW,
    });
    expect(list).toHaveLength(1);
  });
});
