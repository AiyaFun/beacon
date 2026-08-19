import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { llmImage, imageConfigured, imageSource, safeRemoteImageUrl, explainArkError } from '@/lib/llm/image';
import { IMAGE_DAILY_CAPS } from '@/lib/quota';

// llmImage 全链路：真 SQLite + stub 掉 fetch（图像端点无 Mock provider，成功路径靠 stub 造）。
// 配额/记账口径与 llmVideo 对齐：成功记一条 fn=image、失败归还不记账、未配置直接 not_configured。
// 新口径：response_format=b64_json、拿回**字节**不拿直链；水印服务端强制；图像专属日上限并联。

const OLD_ENV = { ...process.env };

function stubImageEnv() {
  process.env.BEACON_IMAGE_LLM_MODEL = 'test-seedream';
  process.env.BEACON_IMAGE_LLM_API_KEY = 'k';
  process.env.BEACON_IMAGE_LLM_BASE_URL = 'https://example.test/api/v3';
}

// 一个最小 JPEG 骨架的 base64（SOI + SOS + EOI），让 sniff 能认出 image/jpeg
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x12, 0xff, 0xd9]).toString('base64');
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');

async function mkTenant(plan = 'free') {
  return prisma.tenant.create({ data: { name: 't', plan } });
}

const okResponse = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });

beforeEach(async () => {
  await prisma.llmCallLog.deleteMany();
  await prisma.tenant.deleteMany();
  delete process.env.BEACON_IMAGE_LLM_MODEL;
  delete process.env.BEACON_IMAGE_LLM_API_KEY;
  delete process.env.BEACON_IMAGE_LLM_BASE_URL;
  delete process.env.BEACON_QUOTA_ENABLED;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.env = { ...OLD_ENV };
});

describe('llmImage', () => {
  it('未配置图像渠道 → not_configured；imageSource 为 null', async () => {
    const t = await mkTenant();
    expect(await imageConfigured(t.id)).toBe(false);
    expect(await imageSource(t.id)).toBeNull();
    const r = await llmImage(t.id, { prompt: 'x', size: '1x1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_configured');
  });

  it('平台 env 配好 + b64_json 出图 → 返回字节与 mime、打到 images/generations、记一条 fn=image', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(async () => okResponse({ data: [{ b64_json: JPEG_B64 }] }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await llmImage(t.id, { prompt: '一张封面', size: '1728x2304', referenceImages: ['data:image/png;base64,AA'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images).toHaveLength(1);
    expect(r.images[0].mime).toBe('image/jpeg');
    expect(r.images[0].bytes[0]).toBe(0xff);
    expect(r.source).toBe('platform');
    expect(await imageSource(t.id)).toBe('platform');

    // 请求打到图像端点，且：参考图（单张 → 字符串）、size 透传、要 b64_json、水印强制 true
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/images/generations');
    const body = JSON.parse(String(init.body));
    expect(body.image).toBe('data:image/png;base64,AA');
    expect(body.watermark).toBe(true);
    expect(body.size).toBe('1728x2304');
    expect(body.response_format).toBe('b64_json');

    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].fn).toBe('image');
    expect(logs[0].costUsd).toBeGreaterThan(0); // 按张估成本，别记成 $0 低估毛利
  });

  it('多张参考图 → image 传数组', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(async () => okResponse({ data: [{ b64_json: PNG_B64 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await llmImage(t.id, { prompt: 'p', size: '1x1', referenceImages: ['data:image/png;base64,A', 'data:image/png;base64,B'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images[0].mime).toBe('image/png');
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(Array.isArray(body.image)).toBe(true);
    expect(body.image).toHaveLength(2);
  });

  it('provider 只回 url（安全的 https 域名）→ 服务端取回成字节', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).includes('/images/generations')) return okResponse({ data: [{ url: 'https://img.example.test/a.jpg' }] });
      return new Response(Buffer.from(JPEG_B64, 'base64'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await llmImage(t.id, { prompt: 'p', size: '1x1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images[0].mime).toBe('image/jpeg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('provider 回的 url 指向内网 / 非 https → 不取回，视为没图（failed），且不记账', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(async () => okResponse({ data: [{ url: 'http://127.0.0.1:6379/x' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await llmImage(t.id, { prompt: 'p', size: '1x1' });
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 没去拉内网地址
    expect(await prisma.llmCallLog.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('HTTP 失败 → failed，且归还名额（不记账）', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await llmImage(t.id, { prompt: 'x', size: '1x1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('failed');
    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs).toHaveLength(0);
  });

  it('返回空 data → failed', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ data: [] })));
    const r = await llmImage(t.id, { prompt: 'x', size: '1x1' });
    expect(r.ok).toBe(false);
  });

  it('图像专属日上限：free 档平台 key 到顶后 → quota，且不再打 provider', async () => {
    stubImageEnv();
    vi.stubEnv('BEACON_QUOTA_ENABLED', '1');
    const t = await mkTenant('free');
    const cap = IMAGE_DAILY_CAPS.platform.free;
    // 账本里种 cap 条今天的图像调用（普通日额 30 还远没到，所以拦下来的一定是图像闸）
    await prisma.llmCallLog.createMany({
      data: Array.from({ length: cap }, () => ({
        tenantId: t.id, fn: 'image', provider: 'platform-image', model: 'm', mocked: false,
        promptTokens: 0, completionTokens: 0, costUsd: 0.03,
      })),
    });
    const fetchMock = vi.fn(async () => okResponse({ data: [{ b64_json: JPEG_B64 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await llmImage(t.id, { prompt: 'x', size: '1x1' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('quota');
    expect(r.error).toContain(`${cap} 张`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('safeRemoteImageUrl', () => {
  it('只放行 https 且非 IP 字面量 / localhost / 内网后缀', () => {
    expect(safeRemoteImageUrl('https://ark-content.volces.com/a.jpg')).toBe(true);
    expect(safeRemoteImageUrl('http://ark-content.volces.com/a.jpg')).toBe(false);
    expect(safeRemoteImageUrl('https://127.0.0.1/a')).toBe(false);
    expect(safeRemoteImageUrl('https://localhost/a')).toBe(false);
    expect(safeRemoteImageUrl('https://redis.internal/a')).toBe(false);
    expect(safeRemoteImageUrl('https://[::1]/a')).toBe(false);
    expect(safeRemoteImageUrl('not a url')).toBe(false);
  });
});

// 方舟报错的人话翻译。守的是「用户看到一句话就知道下一步做什么」——
// 原样甩 `{"error":{"code":"InvalidParameter",...}}` 给用户，他既不知道是哪一步的问题，也不知道该改什么。
describe('explainArkError', () => {
  const M = 'doubao-seedream-4-0-250828';
  const S = '1728x2304';

  it('模型没开通 → 指到方舟控制台 / 换渠道', () => {
    const e = explainArkError(400, '{"error":{"code":"ModelNotFound","message":"the model is not found"}}', M, S);
    expect(e).toContain('没开通');
    expect(e).toContain(M);
  });

  it('尺寸不合法 → 说清是哪个尺寸、并给出下一步', () => {
    const e = explainArkError(400, '{"error":{"message":"invalid size"}}', M, '1024x1024');
    expect(e).toContain('太小');
    expect(e).toContain('换一个比例');
  });

  it('限流 / 鉴权 / 余额各自给不同的自救指引', () => {
    expect(explainArkError(429, 'rate limit exceeded', M, S)).toContain('限流');
    expect(explainArkError(401, 'invalid api key', M, S)).toContain('Key');
    expect(explainArkError(400, 'insufficient balance', M, S)).toContain('余额');
  });

  it('认不出的错误如实原样带上状态码与详情（不假装知道原因）', () => {
    const e = explainArkError(500, 'something weird happened', M, S);
    expect(e).toContain('500');
    expect(e).toContain('something weird');
  });
});
