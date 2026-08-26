import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import {
  generateIngestToken,
  workspaceByIngestToken,
  ingestPayloadSchema,
  ingestCompetitorData,
  listSubscribedCompetitors,
  competitorHomeUrl,
} from '@/lib/ingest/competitor';

// 竞对监控 · authorized 通道（方案三 · 插件回传）。
// 三道守卫逐一锁死：令牌 → 工作区订阅关系 → zod 形状校验。
// 竞对档案是全局共享表——「未订阅不得写入」是防跨租户数据污染的关键闸，重点测。

let workspaceId: string;
let competitorId: string;

beforeEach(async () => {
  await prisma.postMetricSnapshot.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 't1' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w1', ingestToken: 'bcn_test_token' } });
  workspaceId = ws.id;
  const comp = await prisma.competitorAccount.create({
    data: { platform: 'douyin', handle: 'MS4wLjABAAAA-x', name: '对标账号A', followers: 1000 },
  });
  competitorId = comp.id;
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId } });
});

describe('守卫1 · 令牌', () => {
  it('有效令牌解析出工作区；无效/空令牌返回 null', async () => {
    expect((await workspaceByIngestToken('bcn_test_token'))?.id).toBe(workspaceId);
    expect(await workspaceByIngestToken('bcn_wrong')).toBeNull();
    expect(await workspaceByIngestToken('')).toBeNull();
    expect(await workspaceByIngestToken(null)).toBeNull();
  });

  it('generateIngestToken：bcn_ 前缀 + 足够熵，两次生成不相同', () => {
    const a = generateIngestToken();
    const b = generateIngestToken();
    expect(a).toMatch(/^bcn_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe('守卫2 · 订阅关系（全局档案防污染）', () => {
  it('竞对不在库：not_found，不写任何数据', async () => {
    const r = await ingestCompetitorData(workspaceId, {
      platform: 'douyin',
      handle: '不存在的handle',
      posts: [],
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  it('竞对在库但本工作区未订阅：not_subscribed，档案不被改写', async () => {
    const tenant2 = await prisma.tenant.create({ data: { name: 't2' } });
    const ws2 = await prisma.workspace.create({ data: { tenantId: tenant2.id, name: 'w2', ingestToken: 'bcn_other' } });
    const r = await ingestCompetitorData(ws2.id, {
      platform: 'douyin',
      handle: 'MS4wLjABAAAA-x',
      profile: { followers: 999999 },
      posts: [],
    } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_subscribed');
    const comp = await prisma.competitorAccount.findUniqueOrThrow({ where: { id: competitorId } });
    expect(comp.followers).toBe(1000); // 未被污染
  });
});

describe('守卫3 · 形状校验（zod）', () => {
  it('未知平台拒绝；posts 超 50 条拒绝', () => {
    // 'kuaishou' 2026-08-19 进了 PLATFORMS，不再是未知平台；举例改用确实不存在的 key
    expect(ingestPayloadSchema.safeParse({ platform: 'douban', handle: 'x', posts: [] }).success).toBe(false);
    const posts = Array.from({ length: 51 }, (_, i) => ({ platformItemId: String(i), title: 't' }));
    expect(ingestPayloadSchema.safeParse({ platform: 'douyin', handle: 'x', posts }).success).toBe(false);
  });

  it('指标白名单：未知键丢弃、负数/NaN 挡掉、字符串数字转数值', () => {
    const parsed = ingestPayloadSchema.parse({
      platform: 'douyin',
      handle: 'x',
      posts: [{ platformItemId: 'a', title: 't', metrics: { likes: '123', views: -5, hax0r: 999, comments: NaN } }],
    });
    expect(parsed.posts[0].metrics).toEqual({ likes: 123 });
  });

  it('深度指标 comments/collects/shares/danmaku/coins 全在白名单内', () => {
    const parsed = ingestPayloadSchema.parse({
      platform: 'bilibili',
      handle: '598464467',
      posts: [{
        platformItemId: 'BV1',
        title: 't',
        metrics: { views: 980000, danmaku: 470, likes: 78000, coins: 3476, collects: 6729, shares: 724, comments: 88 },
      }],
    });
    expect(parsed.posts[0].metrics).toEqual({
      views: 980000, danmaku: 470, likes: 78000, coins: 3476, collects: 6729, shares: 724, comments: 88,
    });
  });

  it('publishedAt 兼容 ISO 字符串与秒级时间戳', () => {
    const parsed = ingestPayloadSchema.parse({
      platform: 'douyin',
      handle: 'x',
      posts: [
        { platformItemId: 'a', title: 't', publishedAt: '2026-07-18T00:00:00.000Z' },
        { platformItemId: 'b', title: 't', publishedAt: 1784332800 },
      ],
    });
    expect(parsed.posts[0].publishedAt?.toISOString()).toBe('2026-07-18T00:00:00.000Z');
    expect(parsed.posts[1].publishedAt?.getFullYear()).toBeGreaterThanOrEqual(2026);
  });
});

describe('入库语义', () => {
  const payload = () =>
    ingestPayloadSchema.parse({
      platform: 'douyin',
      handle: 'MS4wLjABAAAA-x',
      profile: { name: '对标账号A（新名）', followers: 52000 },
      posts: [
        { platformItemId: 'v1', title: '作品一', url: 'https://www.douyin.com/video/1', metrics: { likes: 3000 } },
        { platformItemId: 'v2', title: '作品二' }, // 无指标
      ],
    });

  it('订阅成立：档案更新 + 作品入库 + lastCrawledAt 打点', async () => {
    const r = await ingestCompetitorData(workspaceId, payload());
    expect(r).toMatchObject({ ok: true, posts: 2, profileUpdated: true });
    const comp = await prisma.competitorAccount.findUniqueOrThrow({ where: { id: competitorId } });
    expect(comp.name).toBe('对标账号A（新名）');
    expect(comp.followers).toBe(52000);
    expect(comp.lastCrawledAt).not.toBeNull();
    const posts = await prisma.crawledPost.findMany({ orderBy: { platformItemId: 'asc' } });
    expect(posts).toHaveLength(2);
    expect(parseJson<Record<string, number>>(posts[0].metrics, {})).toEqual({ likes: 3000 });
  });

  // 2026-08-10：作品**不**重复建（幂等仍然成立），但快照改成每次采集都留一个时点。
  // 理由见 tests/pipeline/competitor-snapshot.test.ts 里那段说明：
  // 「没涨」和「没采」在序列上必须能分开，否则区间增长算不出来。
  // 首次入库也落一条起点（原来不落，导致第一段增长——往往最猛的那段——永远丢失）。
  it('重复回传幂等：不重复建作品；每次采集都留一条 PostMetricSnapshot', async () => {
    // 两条作品里只有 v1 带指标；v2 无指标 → 不写空快照（空快照会在曲线上造出一个假的 0 点）
    await ingestCompetitorData(workspaceId, payload());
    expect(await prisma.postMetricSnapshot.count()).toBe(1); // v1 的起点

    await ingestCompetitorData(workspaceId, payload()); // 指标没变，但仍然留时点
    expect(await prisma.crawledPost.count()).toBe(2);
    expect(await prisma.postMetricSnapshot.count()).toBe(2);

    const p2 = payload();
    p2.posts[0].metrics = { likes: 4500 };
    await ingestCompetitorData(workspaceId, p2);
    expect(await prisma.postMetricSnapshot.count()).toBe(3);
    const post = await prisma.crawledPost.findFirstOrThrow({ where: { platformItemId: 'v1' } });
    expect(parseJson<Record<string, number>>(post.metrics, {})).toEqual({ likes: 4500 });
  });

  it('无指标的回传不覆盖已有指标（与 RSS 通道同一约定）', async () => {
    await ingestCompetitorData(workspaceId, payload()); // v1 已有 likes:3000
    const again = ingestPayloadSchema.parse({
      platform: 'douyin',
      handle: 'MS4wLjABAAAA-x',
      posts: [{ platformItemId: 'v1', title: '作品一' }], // 这次没采到指标
    });
    await ingestCompetitorData(workspaceId, again);
    const post = await prisma.crawledPost.findFirstOrThrow({ where: { platformItemId: 'v1' } });
    expect(parseJson<Record<string, number>>(post.metrics, {})).toEqual({ likes: 3000 }); // 未被抹零
  });
});

// 插件众包采集：用户边逛边收录。这条路径必须能建档+自动订阅，
// 否则「在竞对主页点一下就纳入监控」的产品承诺落不了地；
// 而它与上面两道守卫共存的唯一区别就是 payload.autoSubscribe——插件三个入口都显式传 true。
describe('守卫2·反面 · autoSubscribe=true 的众包采集路径', () => {
  it('竞对不在库：自动建档 + 自动订阅本工作区，作品一并入库', async () => {
    const r = await ingestCompetitorData(workspaceId, {
      platform: 'bilibili',
      handle: '598464467',
      autoSubscribe: true,
      profile: { name: 'UP主B', followers: 5000 },
      posts: [{ platformItemId: 'BV1x', title: '新作品', metrics: { views: 40000 } }],
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newlySubscribed).toBe(true);
      expect(r.posts).toBe(1);
    }
    const comp = await prisma.competitorAccount.findUniqueOrThrow({
      where: { platform_handle: { platform: 'bilibili', handle: '598464467' } },
    });
    expect(comp.followers).toBe(5000);
    expect(await prisma.watchlistItem.count({ where: { workspaceId, competitorId: comp.id } })).toBe(1);
  });

  it('竞对在库但未订阅：补订阅并允许更新档案（众包数据汇入同一份全局档案）', async () => {
    const tenant2 = await prisma.tenant.create({ data: { name: 't3' } });
    const ws2 = await prisma.workspace.create({ data: { tenantId: tenant2.id, name: 'w3', ingestToken: 'bcn_third' } });
    const r = await ingestCompetitorData(ws2.id, {
      platform: 'douyin',
      handle: 'MS4wLjABAAAA-x',
      autoSubscribe: true,
      profile: { followers: 1200 },
      posts: [],
    } as never);
    expect(r.ok).toBe(true);
    const comp = await prisma.competitorAccount.findUniqueOrThrow({ where: { id: competitorId } });
    expect(comp.followers).toBe(1200);
    expect(await prisma.watchlistItem.count({ where: { workspaceId: ws2.id, competitorId } })).toBe(1);
  });
});

// ── 粉丝数量级闸（lib/ingest/parser-health.ts）──
// 「关注 178 / 粉丝 328.3万」取错时回传上来的就是 178。写进去不是「这次数据不准」——
// 竞对档案是全局共享表，一个错值会喂给基线、同行对比和算法教练，而且没有一键撤销。
describe('粉丝数量级闸', () => {
  const ingest = (followers: number, via?: string) =>
    ingestCompetitorData(workspaceId, {
      platform: 'douyin',
      handle: 'MS4wLjABAAAA-x',
      autoSubscribe: true,
      profile: { followers, ...(via ? { followersVia: via } : {}) },
      posts: [],
    } as never);

  it('🔒 量级突变（328.3万 → 178）→ 库里的值保持不变', async () => {
    await prisma.competitorAccount.update({ where: { id: competitorId }, data: { followers: 3_283_000 } });
    const r = await ingest(178, 'text');
    expect(r.ok).toBe(true); // 整批不打回：作品照常入库，只是粉丝数这一项不认
    const comp = await prisma.competitorAccount.findUniqueOrThrow({ where: { id: competitorId } });
    expect(comp.followers).toBe(3_283_000);
  });

  it('台账上留痕，不是悄悄丢掉', async () => {
    await prisma.competitorAccount.update({ where: { id: competitorId }, data: { followers: 3_283_000 } });
    await ingest(178, 'text');
    const run = await prisma.collectionRun.findFirst({ where: { workspaceId, scope: 'rival' }, orderBy: { ranAt: 'desc' } });
    expect(run?.note).toContain('不覆盖');
  });

  it('正常波动照常写入', async () => {
    await prisma.competitorAccount.update({ where: { id: competitorId }, data: { followers: 241_000 } });
    await ingest(243_500, 'e2e');
    const comp = await prisma.competitorAccount.findUniqueOrThrow({ where: { id: competitorId } });
    expect(comp.followers).toBe(243_500);
  });

  it('🔒 建档后第一次拿到真实粉丝数（0 → 24.1万）必须写得进去', async () => {
    await prisma.competitorAccount.update({ where: { id: competitorId }, data: { followers: 0 } });
    await ingest(241_000, 'e2e');
    const comp = await prisma.competitorAccount.findUniqueOrThrow({ where: { id: competitorId } });
    expect(comp.followers).toBe(241_000);
  });

  it('老版本插件不带 followersVia 也照常入库（字段是 optional，不能因为它缺席打回整批）', async () => {
    await prisma.competitorAccount.update({ where: { id: competitorId }, data: { followers: 241_000 } });
    const r = await ingest(245_000);
    expect(r.ok).toBe(true);
    const comp = await prisma.competitorAccount.findUniqueOrThrow({ where: { id: competitorId } });
    expect(comp.followers).toBe(245_000);
  });
});

describe('订阅清单（每日提醒/竞对清单弹窗数据源）', () => {
  it('只返回本工作区订阅项，带 lastCrawledAt/collectable/url', async () => {
    // 另建一个未被本工作区订阅的竞对，确认不混入
    await prisma.competitorAccount.create({ data: { platform: 'wechat', handle: 'other-gzh', name: '别人的竞对' } });
    // 给本工作区再订阅一个公众号竞对（公众号无公开主页 → url 为 null，但仍可采）
    const wx = await prisma.competitorAccount.create({ data: { platform: 'wechat', handle: 'mine-gzh', name: '公众号竞对' } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: wx.id } });

    const list = await listSubscribedCompetitors(workspaceId);
    expect(list).toHaveLength(2); // 只有本工作区订阅的两个（douyin + wechat），不含未订阅的
    const douyin = list.find((c) => c.platform === 'douyin');
    expect(douyin).toMatchObject({
      handle: 'MS4wLjABAAAA-x',
      collectable: true,
      url: 'https://www.douyin.com/user/MS4wLjABAAAA-x',
    });
    // 公众号是唯一「可采但没有主页链接」的平台：它不走「打开竞对主页顺手采」，而是开用户
    // **自己**的公众号后台调接口（extension/content/wechat-competitor.js）。所以消费方判断
    // 可采性只能看 collectable，不能看 url——按 url 过滤会让公众号整个消失。
    const wxItem = list.find((c) => c.platform === 'wechat');
    expect(wxItem).toMatchObject({ collectable: true, url: null });
  });

  it('competitorHomeUrl 三平台拼接正确，其余返回 null', () => {
    expect(competitorHomeUrl('bilibili', '598464467')).toBe('https://space.bilibili.com/598464467');
    expect(competitorHomeUrl('douyin', 'MS4wX')).toBe('https://www.douyin.com/user/MS4wX');
    expect(competitorHomeUrl('xiaohongshu', '5abc')).toBe('https://www.xiaohongshu.com/user/profile/5abc');
    expect(competitorHomeUrl('wechat', 'x')).toBeNull();
  });
});
