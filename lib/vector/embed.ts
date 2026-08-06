// 文本嵌入。开发态用特征哈希（2-gram 分桶，无需模型即有真实词法相似度，可离线跑通语义召回）；
// 生产态切真实 embeddings 端点（BEACON_EMBED_*），支持两种报文格式：
//   · openai   —— `{model, input:[...]}` → `data[].embedding`（BGE-M3 / OpenAI / 多数网关）
//   · minimax  —— `{model, texts:[...], type:'db'}` → `vectors[]`（MiniMax embo-01，**参数名不是 input**）
// 格式由 `BEACON_EMBED_FORMAT` 显式指定；没指定时按 base URL 里有没有 "minimax" 猜一次。
// 猜错的表现是 HTTP 200 + `base_resp.status_code=2013 missing required parameter`（真机踩过），
// 所以 minimax 分支会把 base_resp 的错误当失败抛出，而不是当成空向量静默降级。
//
// EMBED_DIM 是**存储契约**，不是模型参数：pgvector 列写死 vector(1024)（prisma/postgres/01-pgvector.sql）。
// 供应商维度不等于 1024 时（embo-01 是 1536）走 projectTo() 做确定性降维，
// 而不是改库列——改列要停机重建 HNSW 索引，且 dev(sqlite) 与生产会分叉成两个契约。

export const EMBED_DIM = 1024;

export interface Embedder {
  readonly name: string;
  readonly mocked: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

// 特征哈希嵌入：把字符/2-gram 散列到固定维度，归一化。相似文本共享更多 gram → cosine 更高。
class HashingEmbedder implements Embedder {
  readonly name = 'hash-embed';
  readonly mocked = true;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => featureHash(t));
  }
}

class OpenAICompatibleEmbedder implements Embedder {
  readonly name = 'remote-embed';
  readonly mocked = false;
  constructor(private baseUrl: string, private apiKey: string, private model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`embed 失败 ${res.status}`);
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    const out = (data.data ?? []).map((d) => d.embedding);
    if (out.length !== texts.length) throw new Error(`embed 返回条数不符：要 ${texts.length} 得 ${out.length}`);
    return out.map((v) => projectTo(v)); // 不能直接传 projectTo：map 会把 index 当成第二参 dim（真被测试逮住）
  }
}

// MiniMax 原生 embeddings：参数是 `texts`（不是 input），返回 `vectors`，
// 且**失败也回 HTTP 200**，错误在 base_resp.status_code（0 才是成功）。
class MiniMaxEmbedder implements Embedder {
  readonly name = 'remote-embed(minimax)';
  readonly mocked = false;
  constructor(private baseUrl: string, private apiKey: string, private model: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      // type=db 是「入库向量」（检索侧用 query）。全站都拿它做两两余弦，
      // 混用 db/query 会让同一句话的两份向量对不上，所以统一 db。
      body: JSON.stringify({ model: this.model, texts, type: 'db' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`embed 失败 ${res.status}`);
    const data = (await res.json()) as { vectors?: number[][]; base_resp?: { status_code?: number; status_msg?: string } };
    const code = data.base_resp?.status_code ?? 0;
    if (code !== 0) throw new Error(`embed 失败 ${code}：${data.base_resp?.status_msg ?? ''}`);
    const out = data.vectors ?? [];
    if (out.length !== texts.length) throw new Error(`embed 返回条数不符：要 ${texts.length} 得 ${out.length}`);
    return out.map((v) => projectTo(v)); // 不能直接传 projectTo：map 会把 index 当成第二参 dim（真被测试逮住）
  }
}

/**
 * 把任意维度的向量确定性地压到 EMBED_DIM（稀疏随机投影 / hashing trick 的标准做法：
 * 按下标散列到目标桶并带符号累加，再 L2 归一化——内积在期望意义上保持）。
 * 维度已经相等时原样返回（只补一次归一化，供应商未必给单位向量）。
 */
export function projectTo(v: number[], dim = EMBED_DIM): number[] {
  if (!Array.isArray(v) || v.length === 0) return new Array<number>(dim).fill(0);
  let out: number[];
  if (v.length === dim) {
    out = v.slice();
  } else {
    out = new Array<number>(dim).fill(0);
    for (let i = 0; i < v.length; i++) {
      // 与 featureHash 同一族的整数散列，保证「同一个下标永远落同一个桶」跨进程稳定
      let h = 2166136261 ^ i;
      h = Math.imul(h, 16777619);
      h ^= h >>> 13;
      const idx = Math.abs(h) % dim;
      const sign = (h & 1) === 0 ? 1 : -1;
      out[idx] += sign * v[i];
    }
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

function featureHash(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  const clean = text.toLowerCase().replace(/\s+/g, '');
  const grams: string[] = [];
  for (const ch of clean) grams.push(ch); // 单字
  for (let i = 0; i < clean.length - 1; i++) grams.push(clean.slice(i, i + 2)); // 2-gram
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % EMBED_DIM;
    const sign = (h & 1) === 0 ? 1 : -1; // 有符号哈希，减少碰撞偏置
    v[idx] += sign;
  }
  // L2 归一化
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let cached: Embedder | null = null;
export function getEmbedder(): Embedder {
  if (cached) return cached;
  const base = process.env.BEACON_EMBED_BASE_URL;
  const key = process.env.BEACON_EMBED_API_KEY;
  if (base && key) {
    const model = process.env.BEACON_EMBED_MODEL || 'bge-m3';
    const fmt = (process.env.BEACON_EMBED_FORMAT || '').trim().toLowerCase();
    const isMiniMax = fmt === 'minimax' || (!fmt && /minimax/i.test(base));
    cached = isMiniMax ? new MiniMaxEmbedder(base, key, model) : new OpenAICompatibleEmbedder(base, key, model);
  } else {
    cached = new HashingEmbedder();
  }
  return cached;
}

/** 测试用：env 变了要能重新选实现（进程级缓存否则粘住第一次的选择）。 */
export function resetEmbedderCache(): void {
  cached = null;
}

/**
 * 当前嵌入通道的实况，给 UI 如实展示用。
 * 「降级必须说破」：跑在哈希近似上时，语义召回/聚类/粗排的效果和真模型不是一回事，
 * 页面上不能只字不提（那就成了「看着有、实则打折」）。
 */
export function embedderInfo(): { name: string; mocked: boolean; model: string | null } {
  const e = getEmbedder();
  return { name: e.name, mocked: e.mocked, model: e.mocked ? null : process.env.BEACON_EMBED_MODEL || 'bge-m3' };
}

export async function embedText(text: string): Promise<number[]> {
  const [v] = await getEmbedder().embed([text]);
  return v;
}

export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 两侧均已 L2 归一化，点积即余弦
}
