import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { runCover } from '@/lib/cover/run';
import { readJpegAigcMetadata } from '@/lib/deliverable/jpeg-meta';
import { invalidateDfaCache } from '@/lib/compliance/engine';
import { MAX_REFERENCE_BYTES, MAX_COVER_IMAGES } from '@/lib/cover/rules';

// 封面运行内核：真 SQLite + stub fetch（图像端点）+ Mock 文本 LLM（清掉平台默认 env，抽标题落 Mock）。
// 钉死的契约：fail-fast / 参考图必须带同意 / 手填文案跳过抽取 / 红线只检上图文字 / 出图即打标 /
// 比例由平台推出。

delete process.env.BEACON_DEFAULT_LLM_BASE_URL;
delete process.env.BEACON_DEFAULT_LLM_API_KEY;

const OLD_ENV = { ...process.env };
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x12, 0xff, 0xd9]).toString('base64');
const okImage = () => new Response(JSON.stringify({ data: [{ b64_json: JPEG_B64 }] }), { status: 200 });

function stubImageEnv() {
  process.env.BEACON_IMAGE_LLM_MODEL = 'test-seedream';
  process.env.BEACON_IMAGE_LLM_API_KEY = 'k';
  process.env.BEACON_IMAGE_LLM_BASE_URL = 'https://example.test/api/v3';
}

async function mkTenant() {
  return prisma.tenant.create({ data: { name: 't', plan: 'free' } });
}

async function seedWord(word: string, tier: string, action: string) {
  await prisma.sensitiveWord.create({ data: { word, tier, action, category: 'test', version: 'test', enabled: true } });
  invalidateDfaCache();
}

beforeEach(async () => {
  await prisma.llmCallLog.deleteMany();
  await prisma.sensitiveWord.deleteMany();
  await prisma.tenant.deleteMany();
  delete process.env.BEACON_IMAGE_LLM_MODEL;
  delete process.env.BEACON_IMAGE_LLM_API_KEY;
  delete process.env.BEACON_IMAGE_LLM_BASE_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

const REF = 'data:image/jpeg;base64,' + JPEG_B64;

describe('runCover', () => {
  it('未配置图像渠道 → not_configured，且不烧抽标题那次调用', async () => {
    const t = await mkTenant();
    const fetchMock = vi.fn(okImage);
    vi.stubGlobal('fetch', fetchMock);
    const r = await runCover({ tenantId: t.id, platform: 'xiaohongshu', instruction: '抽', fallbackTitle: '标题' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.llmCallLog.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('带参考图但没勾同意 → 拒绝（input），一次调用都不发', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(okImage);
    vi.stubGlobal('fetch', fetchMock);
    const r = await runCover({
      tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: '大字' }, fallbackTitle: 'x',
      subjectImages: [REF],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('input');
    expect(r.error).toContain('同意');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('参考图超张数 / 超大小 / 非图片 data URI → input 拒绝', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(okImage));
    const base = { tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: '大字' }, fallbackTitle: 'x', portraitConsent: true };
    const tooMany = await runCover({ ...base, subjectImages: [REF, REF] });
    expect(tooMany.ok).toBe(false);
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 100);
    const tooBig = await runCover({ ...base, subjectImages: [big] });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain('MB');
    const notImg = await runCover({ ...base, backgroundImages: ['https://evil.test/x.jpg'] });
    expect(notImg.ok).toBe(false);
  });

  it('手填大字 → 跳过抽取（不记 generation 账），出图打标、比例按平台（抖音 9:16）', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(okImage);
    vi.stubGlobal('fetch', fetchMock);
    const r = await runCover({
      tenantId: t.id, platform: 'douyin', meta: { mainTitle: '三天瘦五斤', subTitle: '亲测' }, fallbackTitle: 'x',
      styleKey: 'big-text-bg', subjectImages: [REF], backgroundImages: [REF], portraitConsent: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.metaFromUser).toBe(true);
    expect(r.spec.ratio).toBe('9:16');
    expect(r.images).toHaveLength(1);
    expect(r.images[0].aigcEmbedded).toBe(true);
    // 没给 workspaceId → 退回 data URL（技能面板那条老路径的行为）。解回字节，XMP 里能读到 ProduceID 含租户 id
    expect(r.images[0].id).toBeUndefined();
    expect(r.images[0].url.startsWith('data:')).toBe(true);
    const b64 = r.images[0].url.split(',')[1];
    const meta = readJpegAigcMetadata(new Uint8Array(Buffer.from(b64, 'base64')));
    expect(meta).toBeTruthy();
    expect(JSON.parse(meta!).AIGC.ProduceID).toContain(t.id);

    // 只有一次调用：图像端点；size 与提示词比例都跟着抖音走；参考图两张进数组
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.size).toBe(r.spec.size);
    expect(String(body.prompt)).toContain('9:16');
    expect(String(body.prompt)).toContain('主体保真');
    expect(String(body.prompt)).toContain('背景取材');
    expect(body.image).toHaveLength(2);
    // 账本：只有 image 一条，没有 generation（抽取被跳过了）
    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs.map((l) => l.fn)).toEqual(['image']);
  });

  it('没手填 → 走抽取（Mock）→ 回落草稿标题仍能出图；抽取那步 mocked=true 透传', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(okImage));
    const r = await runCover({ tenantId: t.id, platform: 'xiaohongshu', instruction: '从正文抽要素：xxx', fallbackTitle: '草稿标题' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.metaFromUser).toBe(false);
    expect(r.meta.mainTitle.length).toBeGreaterThan(0);
    expect(r.spec.ratio).toBe('3:4');
  });

  it('既没手填也没抽取指令 → input 错误', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const r = await runCover({ tenantId: t.id, platform: 'xiaohongshu', fallbackTitle: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('input');
  });

  it('上图文字命中红线 → 拒绝且不生图；备注命中红线同样拦', async () => {
    stubImageEnv();
    await seedWord('国家级', 'legal', 'block');
    const t = await mkTenant();
    const fetchMock = vi.fn(okImage);
    vi.stubGlobal('fetch', fetchMock);
    const a = await runCover({ tenantId: t.id, platform: 'wechat', meta: { mainTitle: '国家级团队' }, fallbackTitle: 'x' });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe('redline');
    const b = await runCover({ tenantId: t.id, platform: 'wechat', meta: { mainTitle: '正常' }, extra: '写上国家级三个字', fallbackTitle: 'x' });
    expect(b.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('生图失败 → failed 原样透传', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 502 })));
    const r = await runCover({ tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: 'x' }, fallbackTitle: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('failed');
  });
});

// ── 第三期：变体 / 多风格 / 公众号成对 ────────────────────────────────
// 要钉死的是「一次多张」这件事上最容易错的三点：文案只抽一次、张数封顶、部分失败不作废已出的那几张。

describe('runCover · 一次多张', () => {
  it('变体：抽一次文案出 N 张，N 次出图调用', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(okImage);
    vi.stubGlobal('fetch', fetchMock);
    const r = await runCover({
      tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: '大字' }, fallbackTitle: 'x', variants: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 账本：3 条 image，0 条 generation（文案是手填的，只抽 0 次）
    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs.map((l) => l.fn)).toEqual(['image', 'image', 'image']);
  });

  it('🔒 张数封顶 MAX_COVER_IMAGES（每张都是一次真实付费调用）', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(okImage);
    vi.stubGlobal('fetch', fetchMock);
    const r = await runCover({
      tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: '大字' }, fallbackTitle: 'x', variants: 99,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images.length).toBe(MAX_COVER_IMAGES);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_COVER_IMAGES);
  });

  it('多选风格：每个风格各一张，每张记下自己的风格与比例', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(okImage));
    const r = await runCover({
      tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: '大字' }, fallbackTitle: 'x',
      styleKeys: ['magazine', 'minimal-ins'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images.map((i) => i.styleKey)).toEqual(['magazine', 'minimal-ins']);
    expect(new Set(r.images.map((i) => i.specKey))).toEqual(new Set(['xhs-3-4']));
  });

  it('公众号成对：主图 2.35:1 + 次图 1:1，两张比例不同', async () => {
    stubImageEnv();
    const t = await mkTenant();
    const fetchMock = vi.fn(okImage);
    vi.stubGlobal('fetch', fetchMock);
    const r = await runCover({
      tenantId: t.id, platform: 'wechat', meta: { mainTitle: '大字' }, fallbackTitle: 'x', wechatSquareToo: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images.map((i) => i.specKey)).toEqual(['wechat-235-1', 'square-1-1']);
    const sizes = fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).size);
    expect(new Set(sizes).size).toBe(2);
  });

  it('🔒 部分失败：已经出好的那几张照常返回，并如实说明失败了几张（钱已经花了，不能作废）', async () => {
    stubImageEnv();
    const t = await mkTenant();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      return n === 2 ? new Response('boom', { status: 500 }) : okImage();
    }));
    const r = await runCover({
      tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: '大字' }, fallbackTitle: 'x', variants: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images).toHaveLength(2);
    expect(r.warning).toContain('成功 2 张');
    // 失败那张不记账（llmImage 里已归还名额）
    expect(await prisma.llmCallLog.count({ where: { tenantId: t.id } })).toBe(2);
  });

  it('🔒 全部失败 → 把第一次失败的原因原样交出去（quota 与 failed 对用户是两件事）', async () => {
    stubImageEnv();
    const t = await mkTenant();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await runCover({
      tenantId: t.id, platform: 'xiaohongshu', meta: { mainTitle: '大字' }, fallbackTitle: 'x', variants: 2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('failed');
  });
});
