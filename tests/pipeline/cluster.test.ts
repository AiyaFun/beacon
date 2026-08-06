import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { clusterHotTopics } from '@/lib/pipeline';

// F1-2 跨平台话题簇（PRD §6）。
//
// 本文件存在的理由：原实现的聚类键是 `it.title.slice(0, 2)`——**按标题前两个字归并**。
// 它在线上把「直击重庆彭水垮塌救援现场」和「直击马龙许昕冲击全锦赛八强」并成了同一个簇，
// 只因为都以「直击」开头。这样的簇当时有 82 个，正在喂推荐候选池。
// 现在改成 embedText + 阈值聚类。下面锁死三件事：不硬凑、能合并、不累积垃圾。

const hot = (source: string, rank: number, title: string, heat = 100) =>
  prisma.hotItem.create({ data: { source, rank, title, heat } });

beforeEach(async () => {
  await prisma.hotItem.deleteMany();
  await prisma.topicCluster.deleteMany();
});

describe('F1-2 · 不硬凑（slice(0,2) 事故回归锁）', () => {
  it('同样以「直击」开头的两条无关热点，绝不能进同一个簇', async () => {
    // 这就是线上那个垃圾簇的原始形态
    await hot('douyin', 1, '直击重庆彭水垮塌救援现场', 900);
    await hot('toutiao', 1, '直击马龙许昕冲击全锦赛八强', 800);
    const rep = await clusterHotTopics();
    expect(rep.clusters).toBe(0); // 两条无关 → 一个跨源簇都不该有
  });

  it('共享同一个前缀词的无关热点不合并', async () => {
    await hot('weibo', 1, '如何看待某明星塌房', 900);
    await hot('zhihu', 1, '如何看待房价走势', 800);
    const rep = await clusterHotTopics();
    expect(rep.clusters).toBe(0);
  });
});

describe('F1-2 · 能合并（AC②：同一事件出现在 ≥2 平台时正确合并）', () => {
  it('同一事件的跨平台标题合并成一个簇，sources 记全', async () => {
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', 1, '重庆山体垮塌已救出10人', 800);
    await hot('weibo', 1, '重庆彭水山体垮塌', 700);
    const rep = await clusterHotTopics();
    expect(rep.clusters).toBe(1);
    const c = await prisma.topicCluster.findFirstOrThrow({ include: { hotItems: true } });
    expect(c.hotItems).toHaveLength(3);
    expect(JSON.parse(c.sources).sort()).toEqual(['douyin', 'toutiao', 'weibo']);
    expect(c.heat).toBe(900); // 簇热度取成员最大值
    expect(c.title).toBe('重庆彭水山体垮塌已救出10人'); // 簇首 = 热度最高那条
  });

  it('单平台内的同事件多条不成簇（F1-2 要的是跨平台簇）', async () => {
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 900);
    await hot('douyin', 2, '重庆彭水山体垮塌救援进展', 800);
    const rep = await clusterHotTopics();
    expect(rep.clusters).toBe(0);
  });
});

describe('F1-2 · 簇是派生物，不是累积资产', () => {
  it('重复跑不累积旧簇（线上 82 个簇里 73 个是没有成员的孤儿）', async () => {
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', 1, '重庆山体垮塌已救出10人', 800);
    await clusterHotTopics();
    await clusterHotTopics();
    await clusterHotTopics();
    expect(await prisma.topicCluster.count()).toBe(1); // 原实现这里会是 3
  });

  it('榜单换血后，上一轮的簇不残留（旧簇此刻还挂着成员，只收孤儿收不掉）', async () => {
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', 1, '重庆山体垮塌已救出10人', 800);
    await clusterHotTopics();
    expect(await prisma.topicCluster.count()).toBe(1);

    // 模拟 ingestHot：清空重建
    await prisma.hotItem.deleteMany();
    await hot('douyin', 1, '功夫女足票房破10亿', 900);
    await hot('toutiao', 1, '《功夫女足》上映七天票房破10亿登顶暑期档', 800);
    await clusterHotTopics();

    const all = await prisma.topicCluster.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('功夫女足票房破10亿');
  });

  it('空榜单不炸', async () => {
    const rep = await clusterHotTopics();
    expect(rep.clusters).toBe(0);
  });
});

describe('F1-2 · dev 降级模式必须自报家门', () => {
  it('无 BEACON_EMBED_* 时 mode=lexical-degraded，不许冒充语义聚类', async () => {
    await hot('douyin', 1, '重庆彭水山体垮塌已救出10人', 900);
    await hot('toutiao', 1, '重庆山体垮塌已救出10人', 800);
    const rep = await clusterHotTopics();
    // HashingEmbedder 是字符 2-gram 特征哈希，只有词形重合度、没有语义。
    // 实测：互不相关的英文标题相似度中位 0.478 / 最高 0.714，比中文真同事件(0.46–0.55)还高。
    expect(rep.mode).toBe('lexical-degraded');
  });

  it('lexical 模式跳过拉丁文标题，且把跳过条数报出来（不静默）', async () => {
    await hot('x', 1, 'How creators plan content', 900);
    await hot('youtube', 1, 'The creator economy in 2026', 800);
    const rep = await clusterHotTopics();
    // 这两条是完全不同的话题，字符 2-gram 却给到 0.714——硬聚就是又一批垃圾簇
    expect(rep.clusters).toBe(0);
    expect(rep.skippedLatin).toBe(2);
  });
});
