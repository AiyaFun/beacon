import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ingestScreenshot, describeScreenshotResult } from '@/lib/bot/screenshot';
import { messageText, hasImage } from '@/lib/llm/types';

// 截图 → 自有作品表现数据。
//
// 这条链路会**写进表现基线**（PublishRecord / PerformanceSnapshot，并触发学习与爆款预警），
// 所以测试的重点不是「识别多准」，而是「不确定时绝不写库」：
// 假指标一旦入库会静默带偏后续所有分析，比功能不可用糟得多。

const IMG = { data: Buffer.from('fake-png-bytes'), mime: 'image/png' };

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' } });
});
afterEach(() => vi.restoreAllMocks());

async function mockVision(payload: unknown, ok = true) {
  const gw = await import('@/lib/llm/gateway');
  vi.spyOn(gw, 'llmVision').mockResolvedValue(
    ok
      ? ({ ok: true, text: typeof payload === 'string' ? payload : JSON.stringify(payload), model: 'vl' } as any)
      : (payload as any),
  );
}

describe('ingestScreenshot · 不确定时绝不写库', () => {
  it('🔒 没配视觉模型 → 明确报错，绝不用 Mock 编数据', async () => {
    await mockVision({ ok: false, reason: 'not_configured', error: '未配置视觉模型' }, false);
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_vision_model');
    expect(await prisma.publishRecord.count()).toBe(0);
  });

  it('🔒 识图调用失败 → 不写库', async () => {
    await mockVision({ ok: false, reason: 'failed', error: '502' }, false);
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('vision_failed');
    expect(await prisma.publishRecord.count()).toBe(0);
  });

  it('🔒 置信度不足 → 不写库（读错的指标比没指标更糟）', async () => {
    await mockVision({ platform: 'douyin', confidence: 0.3, posts: [{ platformItemId: 'v1', metrics: { views: 1000 } }] });
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('low_confidence');
    expect(await prisma.publishRecord.count()).toBe(0);
  });

  it('🔒 图里不是后台数据（聊天截图/风景照）→ 不写库', async () => {
    await mockVision({ posts: [], confidence: 0 });
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_data');
    expect(await prisma.publishRecord.count()).toBe(0);
  });

  it('🔒 平台认不出/瞎编一个 → 不写库', async () => {
    await mockVision({ platform: '某不存在平台', confidence: 0.9, posts: [{ platformItemId: 'v1', metrics: { views: 1 } }] });
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_platform');
    expect(await prisma.publishRecord.count()).toBe(0);
  });

  it('🔒 模型返回非 JSON → 不写库，不抛异常', async () => {
    await mockVision('我看到这张图里有一些数据');
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(false);
    expect(await prisma.publishRecord.count()).toBe(0);
  });
});

describe('ingestScreenshot · 正常入库', () => {
  it('读到指标 → 建记录并落快照', async () => {
    await mockVision({
      platform: 'douyin',
      confidence: 0.92,
      posts: [{ platformItemId: 'v_abc', title: '露营装备测评', metrics: { views: 12000, likes: 340, comments: 21 } }],
    });
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(1);
      expect(r.platform).toBe('douyin');
    }
    const rec = await prisma.publishRecord.findFirst();
    expect(rec).toBeTruthy();
    expect(await prisma.performanceSnapshot.count()).toBe(1);
  });

  it('完播率百分数自动折算成 0-1（沿用 own-post 的归一化）', async () => {
    await mockVision({
      platform: 'douyin', confidence: 0.9,
      posts: [{ platformItemId: 'v_c', metrics: { views: 100, completion: 42.3 } }],
    });
    expect((await ingestScreenshot('w1', IMG)).ok).toBe(true);
    const rec = await prisma.publishRecord.findFirst();
    expect(JSON.parse(rec!.metrics).completion).toBeCloseTo(0.423, 3);
  });

  it('🔒 省略的字段不会被补成 0（0 会被当真值参与均值和爆款判定）', async () => {
    await mockVision({
      platform: 'douyin', confidence: 0.9,
      posts: [{ platformItemId: 'v_d', metrics: { views: 5000 } }], // 只读到播放
    });
    expect((await ingestScreenshot('w1', IMG)).ok).toBe(true);
    const m = JSON.parse((await prisma.publishRecord.findFirst())!.metrics);
    expect(m.views).toBe(5000);
    expect(m.likes).toBeUndefined();
    expect(m.comments).toBeUndefined();
  });

  it('超过 20 条截断（截图里塞不下更多，多半是模型在编）', async () => {
    await mockVision({
      platform: 'douyin', confidence: 0.9,
      posts: Array.from({ length: 40 }, (_, i) => ({ platformItemId: `v${i}`, metrics: { views: 100 + i } })),
    });
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.count).toBe(20);
  });

  it('工作区没有账号 → 如实报错', async () => {
    await prisma.creatorAccount.deleteMany({});
    await mockVision({ platform: 'douyin', confidence: 0.9, posts: [{ platformItemId: 'v1', metrics: { views: 1 } }] });
    const r = await ingestScreenshot('w1', IMG);
    expect(r.ok).toBe(false);
  });
});

describe('describeScreenshotResult · 回执要能指导下一步', () => {
  it('没配视觉模型 → 告诉用户找管理员配什么', () => {
    const s = describeScreenshotResult({ ok: false, reason: 'no_vision_model', error: 'x' });
    expect(s).toContain('BEACON_VISION_LLM_MODEL');
  });

  it('置信度低 → 说明为什么宁可不入库', () => {
    const s = describeScreenshotResult({ ok: false, reason: 'low_confidence', error: '把握不足（0.30）' });
    expect(s).toContain('更清晰');
  });

  it('不是数据图 → 告诉用户该发哪一屏', () => {
    expect(describeScreenshotResult({ ok: false, reason: 'not_data', error: 'x' })).toContain('创作者后台');
  });

  it('成功 → 带上条数与把握度，并提示可手工纠正', () => {
    const s = describeScreenshotResult({ ok: true, platform: 'douyin', updated: 1, created: 0, skipped: 0, count: 1, confidence: 0.92 });
    expect(s).toContain('1 条');
    expect(s).toContain('92%');
    expect(s).toContain('手工改');
  });
});

describe('多模态消息基建', () => {
  it('messageText 取出文本片段、忽略图片', () => {
    expect(messageText('纯文本')).toBe('纯文本');
    expect(messageText([
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
    ])).toBe('看这张图');
  });

  it('hasImage 能识别带图消息', () => {
    expect(hasImage([{ role: 'user', content: '文字' }])).toBe(false);
    expect(hasImage([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }])).toBe(true);
  });
});
