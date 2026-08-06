/**
 * 清理历史遗留的示例热榜条目。
 *
 * 背景：2026-07-30 之前有两条路径会把 Mock 词条写进全局 HotItem 表——
 *   1) lib/demo/seed.ts 的演示热榜（由「游客访问」触发，写全局表，已删除）；
 *   2) ingestHot 里 MockHotAdapter 的兜底产出（保留，但现在真源恢复时会自动清）。
 * 两者都打了 isMock=true，但当时的板块徽标是「全部 isMock 才标示例」，所以一旦某个源
 * 同时有真数据和假数据，假的就完全看不出来；候选池当时也不过滤 isMock，假词条会被
 * LLM 精排成一条看不出来的正经推荐。
 *
 * 现在：真源供数时 ingestHot 自动清该源残留（见 lib/pipeline.ts），逐条挂「示例」标，
 * 候选池与聚类都排除 isMock。这个脚本只处理**存量**——尤其是那些暂时没有真实通道、
 * 短期内不会被 ingestHot 自动清掉的源。
 *
 * 用法：
 *   npx tsx scripts/purge-mock-hotitems.ts            # 只看不删
 *   npx tsx scripts/purge-mock-hotitems.ts --apply    # 真删
 *   npx tsx scripts/purge-mock-hotitems.ts --apply --only-mixed
 *       只删「该源同时存在真数据」的假条目——最危险的那批（混在真榜单里没法分辨），
 *       保留纯示例板块的数据，让没有通道的源在页面上仍有内容可看（带示例标）。
 *
 * standalone 容器里跑：docker compose exec web npx tsx scripts/purge-mock-hotitems.ts --apply
 */
import { prisma } from '../lib/db';

async function main() {
  const apply = process.argv.includes('--apply');
  const onlyMixed = process.argv.includes('--only-mixed');

  const all = await prisma.hotItem.findMany({ select: { id: true, source: true, title: true, isMock: true } });
  const realSources = new Set(all.filter((i) => !i.isMock).map((i) => i.source));
  const mock = all.filter((i) => i.isMock);
  const targets = onlyMixed ? mock.filter((i) => realSources.has(i.source)) : mock;

  const bySource = new Map<string, string[]>();
  for (const t of targets) {
    if (!bySource.has(t.source)) bySource.set(t.source, []);
    bySource.get(t.source)!.push(t.title);
  }

  console.log(`HotItem 共 ${all.length} 条，其中示例 ${mock.length} 条。`);
  console.log(`本次${onlyMixed ? '（只清混在真数据里的）' : ''}命中 ${targets.length} 条：`);
  for (const [source, titles] of bySource) {
    const mixed = realSources.has(source) ? ' ⚠️ 该源有真实数据，假条目此前完全看不出来' : '';
    console.log(`  ${source} (${titles.length})${mixed}`);
    for (const t of titles.slice(0, 5)) console.log(`    · ${t}`);
    if (titles.length > 5) console.log(`    · …另有 ${titles.length - 5} 条`);
  }

  if (!apply) {
    console.log('\n（预演，未删除。加 --apply 才真删。）');
    return;
  }
  if (targets.length === 0) {
    console.log('\n没有需要清理的条目。');
    return;
  }
  const { count } = await prisma.hotItem.deleteMany({ where: { id: { in: targets.map((t) => t.id) } } });
  console.log(`\n已删除 ${count} 条。`);
  // 簇是榜单的派生物：删完条目后残留的空簇下一轮 clusterHotTopics 会全量重建，这里不动。
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
