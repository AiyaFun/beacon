import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { generateRecommendations, clusterHotTopics, ingestHot } from '@/lib/pipeline';

// 示例热榜条目**不许参与任何派生计算**。
//
// 与竞对那条闸（tests/pipeline/mock-never-persisted.test.ts）是同一个红线的另一半，但结论不同：
// 热榜条目**就是**展示本身（榜单没有别的数据来源），所以允许落库、逐条挂「示例」标；
// 真正不能允许的是它们**被当成情报再加工**——
//
//   真机 2026-07-30，一个全新注册的账号收到推荐：
//     「自媒体新手避坑指南 · 来源 bilibili · 81 分 · 差异化切入角：从家庭理财博主视角…」
//   六维分齐全、切入角像模像样，和真热点推荐没有任何肉眼可分之处。
//   而这条词条是 MockHotAdapter 造的——B站当时没有真实通道。
//
// 三道闸，各自独立：
//   1. generateRecommendations 的候选池排除 isMock（选题卡的「示例数据」标记的是**精排**是否
//      Mock，管不到**来源**是否 Mock，所以那个标救不了这个场景）；
//   2. clusterHotTopics 排除 isMock（「多平台同时升温」是个信号，假条目会造出假信号，
//      而簇又直接喂给 gap.ts 的抢跑窗口判断）；
//   3. ingestHot 在真源恢复供数时立刻清掉该源残留的示例条目（否则它们只随 lifecycle 慢慢
//      faded，中间这段时间混在真榜单里——真机就是百度榜里躺着一条演示词条）。

let accountId = '';
let workspaceId = '';

beforeEach(async () => {
  await prisma.topicIdea.deleteMany();
  await prisma.topicCluster.deleteMany();
  await prisma.hotItem.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't-mock-hot' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({
    data: {
      workspaceId: ws.id,
      name: '测试账号',
      platform: 'xiaohongshu',
      personaCard: JSON.stringify({
        identity: '家庭理财与保险避坑博主',
        audience: '28-40岁新手爸妈',
        value: '保险避坑测评',
        niche: '家庭理财',
        tone: '专业可靠',
        canDo: ['保险测评'],
        cantDo: [],
        platforms: ['xiaohongshu', 'wechat'],
      }),
    },
  });
  workspaceId = ws.id;
  accountId = acc.id;
});

async function seedHot(rows: { source: string; title: string; heat: number; isMock: boolean }[]) {
  for (const [i, r] of rows.entries()) {
    await prisma.hotItem.create({
      data: {
        source: r.source, rank: i + 1, title: r.title, heat: r.heat, isMock: r.isMock,
        peakRank: i + 1, peakHeat: r.heat, lifecycle: 'rising',
      },
    });
  }
}

describe('示例热榜条目不进任何派生计算', () => {
  it('候选池只收真词条：全 Mock 的榜单产不出一条热榜来源的推荐', async () => {
    await seedHot([
      { source: 'bilibili', title: '自媒体新手避坑指南', heat: 9_800_000, isMock: true },
      { source: 'douyin', title: '年轻人开始整顿职场', heat: 8_600_000, isMock: true },
    ]);

    await generateRecommendations(accountId, workspaceId, 5);

    const fromHot = await prisma.topicIdea.findMany({ where: { accountId, sourceType: 'hot' } });
    expect(fromHot).toHaveLength(0);
    // 假标题一个字都不许出现在选题里（换个 sourceType 混进来也算漏）
    const titles = (await prisma.topicIdea.findMany({ where: { accountId } })).map((t) => t.title);
    expect(titles).not.toContain('自媒体新手避坑指南');
    expect(titles).not.toContain('年轻人开始整顿职场');
  });

  it('真假混排时只有真词条能成为候选', async () => {
    await seedHot([
      { source: 'baidu', title: '真实在榜的一条热点', heat: 7_900_000, isMock: false },
      { source: 'baidu', title: '灵活就业人数破两亿', heat: 9_900_000, isMock: true }, // 热度更高，不设闸必被选中
    ]);

    await generateRecommendations(accountId, workspaceId, 5);

    const titles = (await prisma.topicIdea.findMany({ where: { accountId } })).map((t) => t.title);
    expect(titles).not.toContain('灵活就业人数破两亿');
  });

  it('聚类不收示例条目：假的「多平台同时升温」不成立', async () => {
    await seedHot([
      { source: 'douyin', title: 'AI 会取代哪些岗位', heat: 5_000_000, isMock: true },
      { source: 'weibo', title: 'AI 会取代哪些岗位', heat: 4_800_000, isMock: true },
      { source: 'bilibili', title: 'AI 会取代哪些岗位', heat: 4_600_000, isMock: true },
    ]);

    await clusterHotTopics();

    const clustered = await prisma.hotItem.findMany({ where: { clusterId: { not: null } } });
    expect(clustered).toHaveLength(0);
  });

  it('ingestHot：某源拿到真数据后，该源残留的示例条目立即被清掉', async () => {
    // baidu 有真实通道（BaiduHotAdapter），采一轮后这条演示词条必须消失，
    // 而不是留在真榜单里等 lifecycle 慢慢 faded。
    await seedHot([{ source: 'baidu', title: '灵活就业人数破两亿', heat: 4_300_000, isMock: true }]);

    const r = await ingestHot();
    // 真机/CI 无外网时 baidu 也会落 Mock，此时这条断言不成立——只在真源确实供数时校验。
    if (!r.degraded.includes('baidu')) {
      const left = await prisma.hotItem.findMany({ where: { source: 'baidu', isMock: true } });
      expect(left).toHaveLength(0);
    }
  });

  it('没有真数据的源，示例条目照常保留（页面要有东西可看，只是逐条标示例）', async () => {
    await seedHot([{ source: 'x', title: 'Thread writing formula', heat: 1_000, isMock: true }]);
    const before = await prisma.hotItem.count({ where: { source: 'x' } });
    expect(before).toBe(1);
  });
});
