import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEmbedder, embedderInfo, resetEmbedderCache, projectTo, EMBED_DIM, cosine } from '@/lib/vector/embed';

// 嵌入通道：真模型 vs 哈希近似，以及两种报文格式。
// 这里钉死三件真机踩过的事：
//   ① MiniMax 的参数名是 texts 不是 input，用错会 HTTP 200 + base_resp 报错（不能被当成空向量吞掉）
//   ② 供应商维度（embo-01=1536）≠ pgvector 列宽（1024），必须降维且**确定性**
//   ③ 没配 key 时如实标 mocked（页面要说破，不能假装语义可用）

const ENVS = ['BEACON_EMBED_BASE_URL', 'BEACON_EMBED_API_KEY', 'BEACON_EMBED_MODEL', 'BEACON_EMBED_FORMAT'];

describe('嵌入通道', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetEmbedderCache();
  });
  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    resetEmbedderCache();
    vi.unstubAllGlobals();
  });

  it('没配 key → 哈希近似，且如实标 mocked', async () => {
    const info = embedderInfo();
    expect(info.mocked).toBe(true);
    expect(info.model).toBeNull();
    const [v] = await getEmbedder().embed(['测试']);
    expect(v).toHaveLength(EMBED_DIM);
  });

  it('base URL 含 minimax → 自动走原生格式（texts / vectors）', async () => {
    process.env.BEACON_EMBED_BASE_URL = 'https://api.minimax.chat/v1';
    process.env.BEACON_EMBED_API_KEY = 'k';
    process.env.BEACON_EMBED_MODEL = 'embo-01';
    resetEmbedderCache();

    let sentBody: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ vectors: [new Array(1536).fill(0.01)], base_resp: { status_code: 0 } }) } as any;
    });

    const [v] = await getEmbedder().embed(['你好']);
    expect(sentBody.texts).toEqual(['你好']); // ← 不是 input
    expect(sentBody.input).toBeUndefined();
    expect(v).toHaveLength(EMBED_DIM); // 1536 → 1024 已降维
    expect(embedderInfo().mocked).toBe(false);
  });

  it('MiniMax 的「200 但 base_resp 报错」必须抛出，不能当空向量', async () => {
    process.env.BEACON_EMBED_BASE_URL = 'https://api.minimax.chat/v1';
    process.env.BEACON_EMBED_API_KEY = 'k';
    process.env.BEACON_EMBED_FORMAT = 'minimax';
    resetEmbedderCache();
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ vectors: null, base_resp: { status_code: 2013, status_msg: 'missing required parameter' } }),
    }) as any);
    await expect(getEmbedder().embed(['x'])).rejects.toThrow(/2013/);
  });

  it('OpenAI 兼容格式仍走 input / data[].embedding', async () => {
    process.env.BEACON_EMBED_BASE_URL = 'https://api.example.com/v1';
    process.env.BEACON_EMBED_API_KEY = 'k';
    resetEmbedderCache();
    let sentBody: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: [{ embedding: new Array(EMBED_DIM).fill(0.02) }] }) } as any;
    });
    const [v] = await getEmbedder().embed(['你好']);
    expect(sentBody.input).toEqual(['你好']);
    expect(v).toHaveLength(EMBED_DIM);
  });

  it('降维是确定性的，且大体保住相似度关系', () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i) + 0.01);
    const far = Array.from({ length: 1536 }, (_, i) => Math.cos(i * 3.7));
    const pa = projectTo(a), pa2 = projectTo(a), pb = projectTo(b), pf = projectTo(far);
    expect(pa).toEqual(pa2); // 同一输入必得同一输出（跨进程稳定，否则库里旧向量全部对不上）
    expect(pa).toHaveLength(EMBED_DIM);
    expect(cosine(pa, pb)).toBeGreaterThan(cosine(pa, pf)); // 近的仍比远的近
    expect(Math.abs(Math.sqrt(pa.reduce((s, x) => s + x * x, 0)) - 1)).toBeLessThan(1e-6); // 已 L2 归一化
  });

  it('条数对不上直接失败（宁可报错也不静默错位对齐）', async () => {
    process.env.BEACON_EMBED_BASE_URL = 'https://api.example.com/v1';
    process.env.BEACON_EMBED_API_KEY = 'k';
    resetEmbedderCache();
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 2, 3] }] }) }) as any);
    await expect(getEmbedder().embed(['a', 'b'])).rejects.toThrow(/条数不符/);
  });
});
