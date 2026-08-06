import { prisma } from '../db';
import { parseJson, toJson } from '../json';
import { cosine, embedText } from './embed';

// 向量存储：dev 用 MemoryEntry.embedding(JSON) 做 JS 余弦；prod 用 pgvector embedding_vec 列 + HNSW。

function isPostgres() {
  return (process.env.DATABASE_URL || '').startsWith('postgres');
}

// 原始 SQL（$queryRawUnsafe/$executeRawUnsafe）不吃 Prisma 的 `?schema=` 参数：
// Prisma 生成的 ORM 查询会显式带上 "beacon"."MemoryEntry"，但裸 SQL 走连接的 search_path，
// 生产连接的 search_path 是 `"$user", public`（非 beacon），于是裸查 "MemoryEntry" 落在 public
// → relation "MemoryEntry" does not exist。这里从 DATABASE_URL 解析出 schema 显式限定表名。
function pgSchema(): string {
  const m = (process.env.DATABASE_URL || '').match(/[?&]schema=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : 'public';
}
function memoryTable(): string {
  return `"${pgSchema()}"."MemoryEntry"`;
}

// 写入某条记忆的向量
export async function upsertMemoryEmbedding(memoryId: string, text: string): Promise<void> {
  const vec = await embedText(text);
  // JSON 列（两库都写，保持可移植）
  await prisma.memoryEntry.update({ where: { id: memoryId }, data: { embedding: toJson(vec) } });
  // Postgres：额外写真正的 vector 列供 HNSW 检索
  if (isPostgres()) {
    const lit = `[${vec.join(',')}]`;
    await prisma.$executeRawUnsafe(`UPDATE ${memoryTable()} SET embedding_vec = $1::vector WHERE id = $2`, lit, memoryId);
  }
}

/**
 * 给缺向量的记忆补算（换嵌入模型后的自愈路径）。
 *
 * 为什么需要：向量只在**同一个模型内部**可比。换模型（如哈希近似 → 真 embedding）之后，
 * 库里旧向量与新查询向量是两套坐标系，硬比出来的「相似」是随机数——
 * 表现不是报错，而是语义召回时准时不准，最难被发现的那种坏。
 * 正确做法是把旧向量清成 NULL（此刻这条记忆退出语义召回，宁可少召回也不乱召回），
 * 再由本函数用**应用自己的嵌入器**补回来——绝不在运维脚本里复制一份嵌入逻辑，
 * 那份复制品迟早和 lib 里的实现漂移，且漂移了没人看得出来。
 *
 * 由 optimize_memory 每日任务调用，单次有上限：补不完明天接着补，不把一次任务拖成长跑。
 */
export async function backfillMissingEmbeddings(workspaceId: string, limit = 200): Promise<number> {
  let targets: { id: string; content: string }[];
  if (isPostgres()) {
    targets = await prisma.$queryRawUnsafe<{ id: string; content: string }[]>(
      `SELECT id, content FROM ${memoryTable()}
       WHERE "workspaceId" = $1 AND active = true AND embedding_vec IS NULL
       ORDER BY "updatedAt" DESC LIMIT $2`,
      workspaceId,
      limit,
    );
  } else {
    const rows = await prisma.memoryEntry.findMany({
      where: { workspaceId, active: true, OR: [{ embedding: null }, { embedding: '' }, { embedding: '[]' }] },
      select: { id: true, content: true },
      take: limit,
    });
    targets = rows;
  }

  let done = 0;
  for (const t of targets) {
    // 单条失败不阻断其余：嵌入服务抖一下不该让整个每日任务红掉
    try {
      await upsertMemoryEmbedding(t.id, t.content);
      done++;
    } catch {
      /* 下一轮再补 */
    }
  }
  return done;
}

export type MemoryHit = { id: string; content: string; type: string; score: number };

// 语义检索：返回与 query 最相关的生效记忆
export async function searchMemories(
  workspaceId: string,
  accountId: string | undefined,
  query: string,
  k = 8,
): Promise<MemoryHit[]> {
  const qvec = await embedText(query);

  if (isPostgres()) {
    // pgvector 最近邻（<=> 余弦距离）；账号级隔离：本账号记忆 + 工作区级共享记忆(accountId IS NULL)
    const lit = `[${qvec.join(',')}]`;
    const rows = await prisma.$queryRawUnsafe<{ id: string; content: string; type: string; dist: number }[]>(
      `SELECT id, content, type, (embedding_vec <=> $1::vector) AS dist
       FROM ${memoryTable()}
       WHERE "workspaceId" = $2 AND active = true AND embedding_vec IS NOT NULL
         AND ("accountId" = $4 OR "accountId" IS NULL)
       ORDER BY dist ASC LIMIT $3`,
      lit,
      workspaceId,
      k,
      accountId ?? null,
    );
    return rows.map((r) => ({ id: r.id, content: r.content, type: r.type, score: 1 - r.dist }));
  }

  // dev：JS 余弦
  const entries = await prisma.memoryEntry.findMany({
    where: { workspaceId, active: true, OR: [{ accountId: accountId ?? null }, { accountId: null }] },
  });
  const scored = entries
    .map((e) => {
      const vec = parseJson<number[]>(e.embedding ?? '', []);
      const score = vec.length ? cosine(qvec, vec) : 0;
      return { id: e.id, content: e.content, type: e.type, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
