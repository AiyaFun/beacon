import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 正文配图。三条要钉死的规矩：
//   ① 出图字节必须打 AIGC 标识（与封面同一条管线，不许因为「这是配图」而绕过）；
//   ② 红线词拦在出图之前（拦晚了钱已经花了）；
//   ③ 配图与封面共用回收规则——漏了它，磁盘会一直涨到满（07-23 事故的同一种形状）。

const h = vi.hoisted(() => ({
  imageOk: true,
  calls: [] as { prompt: string; size: string }[],
}));

vi.mock('@/lib/llm/image', () => ({
  llmImage: async (_t: string, opts: { prompt: string; size: string }) => {
    h.calls.push({ prompt: opts.prompt, size: opts.size });
    if (!h.imageOk) return { ok: false, reason: 'quota', error: '额度用尽' };
    // 一个最小合法 PNG（8 字节签名 + 空 IHDR 前缀足够走通打标分支的容错路径）
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return { ok: true, images: [{ bytes: png, mime: 'image/png' }], model: 'seedream', source: 'byok' };
  },
  imageConfigured: () => true,
  IMAGE_MODEL_HINT: '',
}));

const { runIllustration, planScenes, MAX_ILLUSTRATIONS } = await import('@/lib/illustration/run');
const { GENERATED_KINDS, purgeExpiredCovers } = await import('@/lib/media/store');

let workspaceId: string;
let tenantId: string;

beforeEach(async () => {
  h.imageOk = true;
  h.calls = [];
  await prisma.mediaAsset.deleteMany();
  await prisma.sensitiveWord.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = tenant.id;
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  workspaceId = ws.id;
});

describe('入口守卫', () => {
  it('没有画面清单就不出图（不许拿空提示词去烧钱）', async () => {
    const r = await runIllustration({ tenantId, workspaceId, platform: 'xiaohongshu', scenes: [] });
    expect(r.ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('红线词拦在出图之前', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '最强', tier: 'legal', action: 'block', enabled: true, category: '广告法' },
    });
    const r = await runIllustration({
      tenantId, workspaceId, platform: 'xiaohongshu',
      scenes: [{ scene: '画一个最强产品的横幅' }],
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('redline');
    expect(h.calls, '红线拦下时不该已经调过出图').toHaveLength(0);
  });

  it('张数超上限时只取前 N 张', async () => {
    const scenes = Array.from({ length: MAX_ILLUSTRATIONS + 3 }, (_, i) => ({ scene: `画面 ${i}` }));
    await runIllustration({ tenantId, workspaceId, platform: 'xiaohongshu', scenes });
    expect(h.calls.length).toBe(MAX_ILLUSTRATIONS);
  });
});

describe('出图与落库', () => {
  it('每张都落进 MediaAsset，kind=illustration，并带 AIGC 标识信息', async () => {
    const r = await runIllustration({
      tenantId, workspaceId, platform: 'xiaohongshu',
      scenes: [{ scene: '一杯冒热气的咖啡放在木桌上', anchor: '早上第一件事' }],
    });
    expect(r.ok).toBe(true);
    const rows = await prisma.mediaAsset.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('illustration');
    const meta = JSON.parse(rows[0].meta) as Record<string, unknown>;
    expect(meta.aigcProduceId).toBeTruthy();
    expect(meta.scene).toContain('咖啡');
  });

  it('提示词里始终带「不要出现文字」的硬约束', async () => {
    await runIllustration({ tenantId, workspaceId, platform: 'xiaohongshu', scenes: [{ scene: '海边日落' }] });
    expect(h.calls[0].prompt).toContain('不要出现任何文字');
  });

  it('配额撞墙时立刻停手，不把剩下几张也试一遍', async () => {
    h.imageOk = false;
    const r = await runIllustration({
      tenantId, workspaceId, platform: 'xiaohongshu',
      scenes: [{ scene: 'a' }, { scene: 'b' }, { scene: 'c' }],
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('quota');
    expect(h.calls).toHaveLength(1);
  });
});

describe('回收', () => {
  it('配图与封面同属「AI 生成图」，一起走保留期回收', async () => {
    expect(GENERATED_KINDS).toContain('illustration');
    expect(GENERATED_KINDS).toContain('cover');
  });

  it('过期的配图会被清掉（漏了它磁盘会一直涨）', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    await prisma.mediaAsset.create({
      data: {
        workspaceId, kind: 'illustration', mime: 'image/png',
        data: Buffer.from([1, 2, 3]), size: 3, meta: '{}', createdAt: old, pinned: false,
      },
    });
    const n = await purgeExpiredCovers();
    expect(n).toBe(1);
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it('钉住的不清（用户明确要留的）', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    await prisma.mediaAsset.create({
      data: {
        workspaceId, kind: 'illustration', mime: 'image/png',
        data: Buffer.from([1, 2, 3]), size: 3, meta: '{}', createdAt: old, pinned: true,
      },
    });
    expect(await purgeExpiredCovers()).toBe(0);
  });
});

describe('拆画面', () => {
  it('Mock 模型下返回空，不拿示例文案去烧真实出图的钱', async () => {
    // 没配任何渠道 → llmComplete 走 Mock
    const scenes = await planScenes(tenantId, { title: 'T', content: '一段正文', count: 3, platform: 'xiaohongshu' });
    expect(scenes).toEqual([]);
  });
});
