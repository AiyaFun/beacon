// 清理历史遗留的 Mock 竞对作品（一次性运维脚本）。
//
// 背景：2026-07-29 之前，添加竞对时自带的那次试采在「该平台没有服务端采集通道」时会落到
// Mock 适配器，并把示例数据**写进 CrawledPost**——标题是「为什么你的完播率一直上不去」这类
// 通用文案、`url` 是 `#`、还带编造的上百万播放量。真机上加一个公众号就落 7 条。
// 危害不止于难看：那些假指标会被 buildBaseline 当成竞对基准去和用户真实数据比。
//
// 代码侧已经堵死（lib/pipeline.ts crawlOneCompetitor 的 isMock 闸 + tests/pipeline/mock-never-persisted.test.ts），
// 但**已经写进库的记录不会自己消失**，要用本脚本清一次。
//
// 用法（默认试运行，只打印不删）：
//   npx tsx scripts/clean-mock-competitor-posts.ts          # 看看会删哪些
//   npx tsx scripts/clean-mock-competitor-posts.ts apply    # 真删
//
// 生产上跑（在 web 容器里，DATABASE_URL 已注入）：
//   docker exec beacon-web-1 node_modules/.bin/tsx scripts/clean-mock-competitor-posts.ts
//   docker exec beacon-web-1 node_modules/.bin/tsx scripts/clean-mock-competitor-posts.ts apply
//
// 判据刻意取「两个特征同时成立」：`url === '#'` **且** platformItemId 形如 `<handle>-<数字>`
// ——这是 lib/adapters/mock.ts 生成数据的形状。只按其中一条筛会误伤真实作品。

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  const apply = process.argv[2] === 'apply';

  const competitors = await prisma.competitorAccount.findMany({ select: { id: true, handle: true, name: true } });
  const byId = new Map(competitors.map((c) => [c.id, c]));

  const suspects = await prisma.crawledPost.findMany({ where: { url: '#' } });
  const hits = suspects.filter((s) => {
    const c = byId.get(s.competitorId);
    return c ? new RegExp(`^${escapeRe(c.handle)}-\\d+$`).test(s.platformItemId) : false;
  });

  console.log(`${apply ? '[执行]' : '[试运行]'} 命中 ${hits.length} 条 Mock 作品`);
  for (const h of hits) {
    console.log(`  ${byId.get(h.competitorId)?.name ?? '(未知竞对)'} / ${h.platformItemId} / ${h.title}`);
  }

  if (!apply) {
    console.log('\n以上为试运行结果，未做任何修改。确认无误后加 apply 参数再跑一次。');
  } else if (hits.length > 0) {
    const ids = hits.map((h) => h.id);
    const snaps = await prisma.postMetricSnapshot.deleteMany({ where: { postId: { in: ids } } });
    const del = await prisma.crawledPost.deleteMany({ where: { id: { in: ids } } });
    console.log(`\n已删除作品 ${del.count} 条、指标快照 ${snaps.count} 条`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
