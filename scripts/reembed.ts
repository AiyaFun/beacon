/**
 * 重算全部已存向量（换嵌入模型后**必须**跑一次）。
 *
 * 为什么必须：向量只在同一个模型内部可比。库里既有的向量是上一任嵌入器（哈希近似或旧模型）
 * 产出的，换成新模型后新旧混在同一列里，余弦相似度就是拿两套坐标系互比——
 * 表现不是报错，而是「语义召回时准时不准」，最难被发现的那种坏。
 *
 * 用法（默认试运行，只报数不写库）：
 *   npx tsx scripts/reembed.ts            # 看会重算多少条
 *   npx tsx scripts/reembed.ts --apply    # 真写
 *
 * 生产（standalone 容器里没有 tsx）：
 *   docker exec -w /app beacon-web-1 node -e "require('./scripts/reembed.js')"  ← 不适用
 * 生产改用容器内的 node 直接跑等价逻辑，或在部署机上 `npx tsx` 连生产 DATABASE_URL 执行。
 */
import { PrismaClient } from '@prisma/client';
import { embedderInfo, getEmbedder } from '../lib/vector/embed';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const BATCH = 32;

function pgSchema(): string {
  const m = (process.env.DATABASE_URL || '').match(/[?&]schema=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : 'public';
}
const isPg = (process.env.DATABASE_URL || '').startsWith('postgres');

async function main() {
  const info = embedderInfo();
  console.log(`嵌入通道：${info.name}${info.model ? ` · ${info.model}` : ''}${info.mocked ? '（哈希近似）' : ''}`);
  if (info.mocked) {
    console.log('⚠️  当前没配 BEACON_EMBED_*，重算出来的还是哈希向量。先配好 key 再跑，否则这一趟没有意义。');
  }

  const memories = await prisma.memoryEntry.findMany({ select: { id: true, content: true } });
  console.log(`记忆条目：${memories.length} 条`);

  if (!APPLY) {
    console.log('（试运行，未写库。加 --apply 真正重算）');
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  for (let i = 0; i < memories.length; i += BATCH) {
    const slice = memories.slice(i, i + BATCH);
    const vecs = await getEmbedder().embed(slice.map((m) => m.content));
    for (let j = 0; j < slice.length; j++) {
      const id = slice[j].id;
      const vec = vecs[j];
      await prisma.memoryEntry.update({ where: { id }, data: { embedding: JSON.stringify(vec) } });
      if (isPg) {
        await prisma.$executeRawUnsafe(
          `UPDATE "${pgSchema()}"."MemoryEntry" SET embedding_vec = $1::vector WHERE id = $2`,
          `[${vec.join(',')}]`,
          id,
        );
      }
      done++;
    }
    console.log(`  …${done}/${memories.length}`);
  }

  // 话题聚类的 centroid_vec 不在这里重算：cluster_topics 每 30 分钟跑一次、每次整体重算，
  // 半天内自己就会被新模型的向量覆盖。硬去改它反而要复制一份聚类逻辑。
  console.log(`✅ 记忆向量已重算 ${done} 条。话题聚类质心由 cluster_topics 定时任务自动刷新（≤30 分钟）。`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('重算失败：', e);
  await prisma.$disconnect();
  process.exit(1);
});
