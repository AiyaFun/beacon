import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  ensurePlatformRecipes, PLATFORM_RECIPE_FIELDS, PLATFORM_RECIPE_SEEDS, FIELD_KEY_OF,
} from '@/lib/scrape/platform-recipes';
import {
  platformItemIdFrom, parseHumanCount, parseLooseDate, rowsToPosts, ingestPlatformRecipeRows, ingestPlatformRecipeRowsAsOwn,
} from '@/lib/scrape/platform-map';
import { complianceCheck } from '@/lib/scrape/recipe';
import { RECIPE_PLATFORMS } from '@/lib/browser-task/kinds';
import { RECIPE_COLLECTABLE, PLUGIN_COLLECTABLE, listSubscribedCompetitors } from '@/lib/ingest/competitor';

// 内置平台配方（2026-09-15）：微博/快手/知乎/头条/百家号五个平台没有手写解析器，
// 竞对主页改由按工作区自动播种的配方采集，抓到的行按固定位置契约映射进竞对库。
//
// 这一层最容易坏的三处，各钉一条：
//   ① 播种不幂等 → 每拉一次清单多五份配方；
//   ② 映射把「缺席」写成 0、或抠不出作品 ID 还硬塞一条 → 竞对库污染；
//   ③ 配方采集只补已订阅竞对，不能借配方在全局共享表里建档。

let tenantId: string;
let workspaceId: string;

beforeEach(async () => {
  await prisma.scrapeRecipe.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = t.id;
  const ws = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  workspaceId = ws.id;
});

describe('播种', () => {
  it('五个平台各一份，且幂等（两次调用还是五份）', async () => {
    const a = await ensurePlatformRecipes(tenantId, workspaceId);
    const b = await ensurePlatformRecipes(tenantId, workspaceId);
    expect(a.created).toBe(RECIPE_PLATFORMS.length);
    expect(b.created).toBe(0);
    const rows = await prisma.scrapeRecipe.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(RECIPE_PLATFORMS.length);
    expect(new Set(rows.map((r) => r.platformKey))).toEqual(new Set(RECIPE_PLATFORMS));
    for (const r of rows) {
      expect(r.status).toBe('learning');
      expect(r.createdBy).toBe('system:platform');
      expect(JSON.parse(r.fields)).toEqual(PLATFORM_RECIPE_FIELDS.map(({ key, label }) => ({ key, label })));
      expect(r.origin).toBe(PLATFORM_RECIPE_SEEDS[r.platformKey as keyof typeof PLATFORM_RECIPE_SEEDS].origin);
    }
  });

  it('🔒 (workspaceId, platformKey) 唯一：并发播种撞上也不会多出一份', async () => {
    await ensurePlatformRecipes(tenantId, workspaceId);
    await expect(prisma.scrapeRecipe.create({
      data: { tenantId, workspaceId, name: 'dup', origin: 'https://weibo.com', fields: '[]', createdBy: 'x', platformKey: 'weibo' },
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('用户自建配方（platformKey 为空）不受唯一索引影响，可以建多份', async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.scrapeRecipe.create({ data: { tenantId, workspaceId, name: `u${i}`, origin: 'https://example.com', fields: '[]', createdBy: 'm' } });
    }
    expect(await prisma.scrapeRecipe.count({ where: { workspaceId, platformKey: null } })).toBe(3);
  });

  it('五个入口都过得了配方的合规闸（政务/医疗/金融那道）', () => {
    for (const p of RECIPE_PLATFORMS) {
      expect(complianceCheck(PLATFORM_RECIPE_SEEDS[p].origin).ok, p).toBe(true);
    }
  });

  it('固定位置契约：f1 粉丝 / f4 链接 / f8 时间，映射层与播种层用同一份', () => {
    expect(FIELD_KEY_OF.followers).toBe('f1');
    expect(FIELD_KEY_OF['post.url']).toBe('f4');
    expect(FIELD_KEY_OF['post.publishedAt']).toBe('f8');
    expect(PLATFORM_RECIPE_FIELDS.map((f) => f.key)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8']);
  });

  it('清单口径：配方平台 collectable 且 viaRecipe 带 origin；手写平台 viaRecipe 为假', async () => {
    const zh = await prisma.competitorAccount.create({ data: { platform: 'zhihu', handle: 'zhang-san', name: '张三' } });
    const dy = await prisma.competitorAccount.create({ data: { platform: 'douyin', handle: 'MS4wLjABAAAA', name: '抖音号' } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: zh.id } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: dy.id } });
    const list = await listSubscribedCompetitors(workspaceId);
    const z = list.find((c) => c.platform === 'zhihu')!;
    const d = list.find((c) => c.platform === 'douyin')!;
    expect(z.collectable).toBe(true);
    expect(z.viaRecipe).toBe(true);
    expect(z.origin).toBe('https://www.zhihu.com');
    expect(z.id).toBe(zh.id);
    expect(d.viaRecipe).toBe(false);
    expect(d.collectable).toBe(true);
    // 两个集合不许重叠：一个平台只能走一条路
    for (const p of RECIPE_COLLECTABLE) expect(PLUGIN_COLLECTABLE.has(p), p).toBe(false);
  });
});

describe('作品 ID 只从链接里抠', () => {
  it.each<[string, string, string | null]>([
    ['weibo', 'https://weibo.com/1234567890/OaBcDeFgH', 'OaBcDeFgH'],
    ['weibo', 'https://weibo.com/detail/5012345678901234', '5012345678901234'],
    ['kuaishou', 'https://www.kuaishou.com/short-video/3xabc_DEF123', '3xabc_DEF123'],
    ['zhihu', 'https://www.zhihu.com/question/12345/answer/9876543', '9876543'],
    ['zhihu', 'https://zhuanlan.zhihu.com/p/5551234', '5551234'],
    ['toutiao', 'https://www.toutiao.com/article/7301234567890123456/', '7301234567890123456'],
    ['toutiao', 'https://www.toutiao.com/i7301234567890123456/', '7301234567890123456'],
    ['baijiahao', 'https://baijiahao.baidu.com/s?id=1780123456789012345&wfr=spider', '1780123456789012345'],
    ['zhihu', 'https://www.zhihu.com/people/zhang-san', null],
    ['toutiao', '', null],
  ])('%s %s → %s', (platform, url, id) => {
    expect(platformItemIdFrom(platform as 'weibo', url)).toBe(id);
  });
});

describe('数字与时间：认不出就缺席，绝不写 0', () => {
  it.each<[unknown, number | undefined]>([
    ['1.2万', 12000], ['3亿', 300000000], ['1.5w', 15000], ['12k', 12000], ['1,234', 1234],
    ['播放 2.5万', 25000], ['', undefined], ['赞', undefined], [null, undefined], [42, 42],
  ])('%s → %s', (raw, n) => {
    expect(parseHumanCount(raw)).toBe(n);
  });

  it('宽松时间', () => {
    const now = new Date(2026, 8, 15, 12, 0, 0);
    expect(parseLooseDate('2026-09-01', now)?.getDate()).toBe(1);
    expect(parseLooseDate('2026年9月2日', now)?.getDate()).toBe(2);
    expect(parseLooseDate('09-03', now)?.getMonth()).toBe(8);
    expect(parseLooseDate('12-30', now)?.getFullYear()).toBe(2025); // 一月看到「12-30」是去年的；九月看到也不该是未来
    expect(parseLooseDate('3小时前', now)?.getHours()).toBe(9);
    expect(parseLooseDate('2天前', now)?.getDate()).toBe(13);
    expect(parseLooseDate('昨天 10:00', now)?.getDate()).toBe(14);
    expect(parseLooseDate('刚刚', now)?.getTime()).toBe(now.getTime());
    expect(parseLooseDate('无', now)).toBeUndefined();
  });

  it('rowsToPosts：抠不出 ID 的行跳过并计数，重复 ID 去重，缺席的指标不写', () => {
    const { posts, skipped } = rowsToPosts('zhihu', [
      { f3: '好文', f4: 'https://www.zhihu.com/answer/111', f5: '1.2万', f7: '' },
      { f3: '重复', f4: 'https://www.zhihu.com/answer/111', f5: '9' },
      { f3: '没链接', f5: '100' },
    ]);
    expect(skipped).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0].platformItemId).toBe('111');
    expect(posts[0].metrics).toEqual({ views: 12000 });
    expect('comments' in posts[0].metrics).toBe(false);
  });
});

describe('落库只补已订阅竞对', () => {
  it('🔒 未订阅：一条都不写，如实给原因', async () => {
    const r = await ingestPlatformRecipeRows({
      workspaceId, platformKey: 'zhihu', url: 'https://www.zhihu.com/people/nobody',
      values: { f1: '100' }, rows: [{ f3: 't', f4: 'https://www.zhihu.com/answer/1' }],
    });
    expect(r.ok).toBe(false);
    expect(await prisma.competitorAccount.count()).toBe(0);
  });

  it('按 competitorId 归属：订阅了就入库，粉丝数与作品都进去', async () => {
    const c = await prisma.competitorAccount.create({ data: { platform: 'zhihu', handle: 'zhang-san', name: '张三' } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: c.id } });
    const r = await ingestPlatformRecipeRows({
      workspaceId, platformKey: 'zhihu', url: 'https://www.zhihu.com/people/zhang-san', competitorId: c.id,
      values: { f1: '2.3万', f2: '张三' },
      rows: [
        { f3: 'A', f4: 'https://www.zhihu.com/answer/1001', f5: '1.2万', f6: '300' },
        { f3: 'B', f4: 'https://www.zhihu.com/answer/1002', f5: '800' },
        { f3: '坏行', f4: 'https://www.zhihu.com/people/zhang-san' },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.posts).toBe(2); expect(r.skipped).toBe(1); }
    const again = await prisma.competitorAccount.findUnique({ where: { id: c.id } });
    expect(again?.followers).toBe(23000);
  });

  it('🔒 competitorId 属于别的平台：拒绝（配方的平台与竞对对不上）', async () => {
    const c = await prisma.competitorAccount.create({ data: { platform: 'douyin', handle: 'dy', name: 'dy' } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: c.id } });
    const r = await ingestPlatformRecipeRows({
      workspaceId, platformKey: 'zhihu', url: 'https://www.zhihu.com/people/x', competitorId: c.id,
      values: {}, rows: [{ f4: 'https://www.zhihu.com/answer/1' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('对不上');
  });

  it('没带 competitorId 时从网址反推 handle；反推的平台不对就拒绝', async () => {
    const r = await ingestPlatformRecipeRows({
      workspaceId, platformKey: 'weibo', url: 'https://www.zhihu.com/people/x',
      values: {}, rows: [{ f4: 'https://weibo.com/1/OaBcDeFgH' }],
    });
    expect(r.ok).toBe(false);
  });
});

// ── 配方行 → 自己的作品（2026-09-16，collect_self_recipe）──
describe('配方回填自己的主页：只认 accountId，进自有作品不进竞对库', () => {
  const mkAccount = (platform: string, handle: string | null) =>
    prisma.creatorAccount.create({ data: { workspaceId, platform, handle, name: `我的${platform}` } });

  it('账号属于本工作区且平台相符：作品进自有作品、粉丝进账号日报；抠不出 ID 的行跳过', async () => {
    const a = await mkAccount('zhihu', 'me');
    const r = await ingestPlatformRecipeRowsAsOwn({
      workspaceId, platformKey: 'zhihu', accountId: a.id, channel: 'desktop',
      values: { f1: '2.3万', f2: '我' },
      rows: [
        { f3: 'A', f4: 'https://www.zhihu.com/answer/1001', f5: '1.2万', f6: '300' },
        { f3: '坏行', f4: 'https://www.zhihu.com/people/me' },
      ],
    });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (r.ok) { expect(r.posts).toBe(1); expect(r.skipped).toBe(1); expect(r.followers).toBe(23000); expect(r.account.id).toBe(a.id); }
    expect(await prisma.competitorAccount.count(), '自己的主页不许建成竞对').toBe(0);
    const rec = await prisma.publishRecord.findFirst({ where: { accountId: a.id, platformItemId: '1001' } });
    expect(rec, '作品没进自有作品').not.toBeNull();
    const stat = await prisma.accountDailyStat.findFirst({ where: { accountId: a.id } });
    expect(stat?.followers).toBe(23000);
  });

  it('🔒 账号的平台与配方对不上：拒绝，一条不写', async () => {
    const a = await mkAccount('douyin', 'dy');
    const r = await ingestPlatformRecipeRowsAsOwn({
      workspaceId, platformKey: 'zhihu', accountId: a.id, channel: 'local_browser',
      values: {}, rows: [{ f4: 'https://www.zhihu.com/answer/1' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('对不上');
  });

  it('🔒 账号不在本工作区：拒绝', async () => {
    const r = await ingestPlatformRecipeRowsAsOwn({
      workspaceId, platformKey: 'zhihu', accountId: 'nope', channel: 'desktop',
      values: {}, rows: [{ f4: 'https://www.zhihu.com/answer/1' }],
    });
    expect(r.ok).toBe(false);
  });
});
