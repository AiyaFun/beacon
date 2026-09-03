import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { coveredRange, recordCollectionRun, listCollectionRuns } from '@/lib/ingest/collection-run';
import { ingestCompetitorData, defaultChannelFor } from '@/lib/ingest/competitor';
import { ingestOwnPostData } from '@/lib/ingest/own-post';
import { ingestOwnAccountData } from '@/lib/ingest/own-account';

// 采集台账：每一次抓取覆盖了哪段时间。
//
// 这张表要回答的问题是「哪几天我采过、哪几天是窟窿」，所以最该钉死的是**覆盖区间的口径**：
// 只能来自内容的发布时间，绝不能拿采集时间冒充（0.4.7 之前把发布时间写成回填当天，
// 正是那个错让「近 30 天」筛掉了刚回填的一批老作品）。

let workspaceId: string;
let accountId: string;
let competitorId: string;

const d = (s: string) => new Date(`${s}T08:00:00.000Z`);

beforeEach(async () => {
  await prisma.collectionRun.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.accountDailyStat.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 't1' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w1' } });
  workspaceId = ws.id;
  const acc = await prisma.creatorAccount.create({
    data: { workspaceId, name: '我的抖音号', platform: 'douyin', status: 'active' },
  });
  accountId = acc.id;
  const comp = await prisma.competitorAccount.create({
    data: { platform: 'wechat', handle: '人民日报', name: '人民日报' },
  });
  competitorId = comp.id;
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId } });
});

describe('覆盖区间的口径', () => {
  it('取发布时间的首尾，无序也认；null/非法值不参与', () => {
    const r = coveredRange([d('2026-07-25'), null, d('2026-07-20'), undefined, d('2026-07-29')]);
    expect(r.from?.toISOString()).toBe(d('2026-07-20').toISOString());
    expect(r.to?.toISOString()).toBe(d('2026-07-29').toISOString());
  });

  it('整批都没有发布时间：区间为空，不拿采集时间顶替', () => {
    expect(coveredRange([null, undefined])).toEqual({ from: null, to: null });
    expect(coveredRange([])).toEqual({ from: null, to: null });
  });
});

describe('竞对回传 · 台账', () => {
  it('落一条台账：覆盖区间取本批作品发布时间的首尾，新增/更新分开计', async () => {
    const post = (id: string, day: string) => ({
      platformItemId: id,
      title: `文章${id}`,
      publishedAt: d(day),
      metrics: { views: 100 },
    });
    const r1 = await ingestCompetitorData(workspaceId, {
      platform: 'wechat',
      handle: '人民日报',
      autoSubscribe: false,
      posts: [post('a', '2026-07-22'), post('b', '2026-07-29')],
    } as never);
    expect(r1.ok).toBe(true);

    const runs = await listCollectionRuns(workspaceId, { scope: 'rival' });
    expect(runs).toHaveLength(1);
    expect(runs[0].items).toBe(2);
    expect(runs[0].created).toBe(2);
    expect(runs[0].updated).toBe(0);
    expect(runs[0].coveredFrom?.toISOString()).toBe(d('2026-07-22').toISOString());
    expect(runs[0].coveredTo?.toISOString()).toBe(d('2026-07-29').toISOString());
    expect(runs[0].targetName).toBe('人民日报');

    // 第二批：一条重复、一条新的 → updated 1 / created 1，区间跟着这一批走（不是历史累计）
    await ingestCompetitorData(workspaceId, {
      platform: 'wechat',
      handle: '人民日报',
      autoSubscribe: false,
      posts: [post('b', '2026-07-29'), post('c', '2026-07-30')],
    } as never);
    const runs2 = await listCollectionRuns(workspaceId, { scope: 'rival' });
    expect(runs2).toHaveLength(2);
    expect(runs2[0].created).toBe(1);
    expect(runs2[0].updated).toBe(1);
    expect(runs2[0].coveredFrom?.toISOString()).toBe(d('2026-07-29').toISOString());
  });

  it('通道：竞对回传一律「插件·主页」；调用方显式指定优先（如文件导入）', async () => {
    // 公众号那条「插件·后台」通道已于 2026-09-03 移除（它用的是用户自己的后台登录态）。
    // plugin_backend 仍然存在，但只属于自有数据那条路，不会由竞对回传落进来。
    expect(defaultChannelFor('wechat')).toBe('plugin_home');
    expect(defaultChannelFor('douyin')).toBe('plugin_home');

    await ingestCompetitorData(
      workspaceId,
      { platform: 'wechat', handle: '人民日报', autoSubscribe: false, posts: [] } as never,
      { channel: 'import' },
    );
    const runs = await listCollectionRuns(workspaceId, { scope: 'rival' });
    expect(runs[0].channel).toBe('import');
    // 空批次也要留痕：用户刚做过一个动作，得有回音
    expect(runs[0].items).toBe(0);
    expect(runs[0].note).toContain('没有回传');
  });

  it('被拒绝的批次（未订阅/已移除申请）不写台账——那不是一次采集', async () => {
    const r = await ingestCompetitorData(workspaceId, {
      platform: 'douyin',
      handle: '不在库的号',
      autoSubscribe: false,
      posts: [],
    } as never);
    expect(r.ok).toBe(false);
    expect(await listCollectionRuns(workspaceId)).toHaveLength(0);
  });
});

describe('自有回传 · 台账', () => {
  it('作品回填：scope=self，覆盖区间按发布时间，账号名如实记录', async () => {
    const r = await ingestOwnPostData(workspaceId, {
      platform: 'douyin',
      accountId,
      channel: 'plugin_backend',
      posts: [
        { platformItemId: 'v1', title: '视频1', publishedAt: d('2026-07-01'), metrics: { views: 1000 } },
        { platformItemId: 'v2', title: '视频2', publishedAt: d('2026-07-15'), metrics: { views: 2000 } },
      ],
    } as never);
    expect(r.ok).toBe(true);

    const runs = await listCollectionRuns(workspaceId, { scope: 'self' });
    expect(runs).toHaveLength(1);
    expect(runs[0].channel).toBe('plugin_backend');
    expect(runs[0].targetName).toBe('我的抖音号');
    expect(runs[0].items).toBe(2);
    expect(runs[0].coveredFrom?.toISOString()).toBe(d('2026-07-01').toISOString());
    expect(runs[0].coveredTo?.toISOString()).toBe(d('2026-07-15').toISOString());
  });

  it('老插件不带 channel：按作品页单篇采集计，不留空', async () => {
    await ingestOwnPostData(workspaceId, {
      platform: 'douyin',
      accountId,
      posts: [{ platformItemId: 'v9', publishedAt: d('2026-07-09'), metrics: { views: 5 } }],
    } as never);
    const runs = await listCollectionRuns(workspaceId, { scope: 'self' });
    expect(runs[0].channel).toBe('plugin_home');
  });

  it('账号级日数据：覆盖区间就是这批日期的首尾', async () => {
    await ingestOwnAccountData(accountId, {
      platform: 'douyin',
      dailyStats: [
        { date: '2026-07-20', followers: 100 },
        { date: '2026-07-26', followers: 130 },
      ],
    } as never);
    const runs = await listCollectionRuns(workspaceId, { scope: 'self' });
    expect(runs).toHaveLength(1);
    expect(runs[0].items).toBe(2);
    expect(runs[0].coveredFrom?.toISOString().slice(0, 10)).toBe('2026-07-20');
    expect(runs[0].coveredTo?.toISOString().slice(0, 10)).toBe('2026-07-26');
  });
});

describe('空批次的取舍', () => {
  it('服务端定时的空转不记（每 2 小时一轮，全记下来会把真正采到的淹掉）', async () => {
    await recordCollectionRun({
      workspaceId, scope: 'rival', platform: 'douyin', targetName: '某号', channel: 'server', items: 0,
    });
    expect(await listCollectionRuns(workspaceId)).toHaveLength(0);
  });

  it('用户自己点出来的空批次照记：他刚做过一个动作，必须给回音', async () => {
    for (const channel of ['manual', 'import', 'plugin_home', 'plugin_backend'] as const) {
      await recordCollectionRun({
        workspaceId, scope: 'rival', platform: 'douyin', targetName: '某号', channel, items: 0,
      });
    }
    expect(await listCollectionRuns(workspaceId)).toHaveLength(4);
  });

  it('写台账失败不能连累入库：工作区不存在时静默跳过，不抛错', async () => {
    await expect(
      recordCollectionRun({
        workspaceId: 'no-such-workspace', scope: 'self', platform: 'douyin',
        targetName: 'x', channel: 'manual', items: 3,
      }),
    ).resolves.toBeUndefined();
  });
});
