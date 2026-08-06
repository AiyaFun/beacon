import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { llmImage, imageConfigured } from '@/lib/llm/image';

// llmImage 全链路：真 SQLite + stub 掉 fetch（图像端点无 Mock provider，成功路径靠 stub 造）。
// 配额/记账口径与 llmVideo 对齐：成功记一条 fn=image、失败归还不记账、未配置直接 not_configured。

const OLD_ENV = { ...process.env };

function stubImageEnv() {
  process.env.BEACON_IMAGE_LLM_MODEL = 'test-seedream';
  process.env.BEACON_IMAGE_LLM_API_KEY = 'k';
  process.env.BEACON_IMAGE_LLM_BASE_URL = 'https://example.test/api/v3';
}

async function mkTenant() {
  return prisma.tenant.create({ data: { name: 't', plan: 'free' } });
}

beforeEach(async () => {
  await prisma.llmCallLog.deleteMany();
  await prisma.tenant.deleteMany();
  delete process.env.BEACON_IMAGE_LLM_MODEL;
  delete process.env.BEACON_IMAGE_LLM_API_KEY;
  delete process.env.BEACON_IMAGE_LLM_BASE_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

describe('llmImage', () => {
  it('未配置图像渠道 → not_configured', async () => {
    const t = await mkTenant();
    expect(await imageConfigured(t.id)).toBe(false);
    const r = await llmImage(t.id, { prompt: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_configured');
  });

  it('平台 env 配好 + 出图成功 → 返回图片、打到 images/generations、记一条 fn=image', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ url: 'https://img.test/x.png' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await llmImage(t.id, { prompt: '一张封面', referenceImages: ['data:image/png;base64,AA'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images[0].url).toBe('https://img.test/x.png');
    expect(r.source).toBe('platform');

    // 请求打到图像端点，且带上了参考图（单张 → 字符串）与默认水印
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/images/generations');
    const body = JSON.parse(String(init.body));
    expect(body.image).toBe('data:image/png;base64,AA');
    expect(body.watermark).toBe(true);
    expect(body.size).toBeTruthy();

    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].fn).toBe('image');
    expect(logs[0].costUsd).toBeGreaterThan(0); // 按张估成本，别记成 $0 低估毛利
  });

  it('多张参考图 → image 传数组', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ url: 'https://img.test/x.png' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await llmImage(t.id, { prompt: 'p', referenceImages: ['data:image/png;base64,A', 'data:image/png;base64,B'] });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(Array.isArray(body.image)).toBe(true);
    expect(body.image).toHaveLength(2);
  });

  it('HTTP 失败 → failed，且归还名额（不记账）', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await llmImage(t.id, { prompt: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('failed');
    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs).toHaveLength(0);
  });

  it('返回空 data → failed', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const r = await llmImage(t.id, { prompt: 'x' });
    expect(r.ok).toBe(false);
  });
});
