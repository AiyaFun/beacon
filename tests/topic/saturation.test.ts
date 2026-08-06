import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { saturationFromTitles, computeSaturation } from '@/lib/topic/saturation';

// 竞争饱和度取数（research-5 §5.2）。这个因子曾经是死代码：coarseRank 的 saturation 参数
// 从未被传过，satFactor 恒 0.7。现在数据源是真的（近 72h 全局竞对作品），这里锁住取数口径：
// 2-gram 重合判同话题、计数 5 封顶归一化、72h 窗口、竞对库为空不影响新账号。

const HOURS = 3600 * 1000;

async function seedCompetitor() {
  return prisma.competitorAccount.create({
    data: { platform: 'douyin', handle: `h-${Math.random().toString(36).slice(2)}`, name: '竞对' },
  });
}

let seq = 0;
async function seedPost(competitorId: string, title: string, opts: { publishedAt?: Date | null } = {}) {
  return prisma.crawledPost.create({
    data: {
      competitorId,
      platform: 'douyin',
      platformItemId: `p-${++seq}`,
      title,
      // 未显式给 publishedAt 时留 null（走 crawledAt 兜底路径，crawledAt 默认 now）
      publishedAt: opts.publishedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await prisma.crawledPost.deleteMany();
  await prisma.competitorAccount.deleteMany();
});

describe('saturationFromTitles · 纯函数口径', () => {
  it('2-gram 重合 ≥2 才算同话题：单个常见二字词撞上不算', () => {
    const sat = saturationFromTitles(['减脂餐一周食谱'], ['减脂餐做法合集', '世界杯冠军之夜']);
    // 「减脂餐做法合集」共享 减脂/脂餐 → 算；「世界杯冠军之夜」零重合 → 不算
    expect(sat['减脂餐一周食谱']).toBe(0.2); // 1 条 / 封顶 5
  });

  it('计数 5 封顶：6 条同话题作品饱和度也是 1.0', () => {
    const posts = Array.from({ length: 6 }, (_, i) => `减脂餐做法分享第${i}期`);
    const sat = saturationFromTitles(['减脂餐一周食谱'], posts);
    expect(sat['减脂餐一周食谱']).toBe(1.0);
  });

  it('中间档位按比例：3 条 → 0.6', () => {
    const posts = ['减脂餐做法一', '减脂餐做法二', '减脂餐做法三'];
    expect(saturationFromTitles(['减脂餐一周食谱'], posts)['减脂餐一周食谱']).toBe(0.6);
  });

  it('无竞对作品 → 全 0', () => {
    const sat = saturationFromTitles(['随便什么话题'], []);
    expect(sat['随便什么话题']).toBe(0);
  });

  it('不同候选各算各的，互不串味', () => {
    const sat = saturationFromTitles(
      ['减脂餐一周食谱', '增肌餐一周食谱'],
      ['减脂餐做法合集', '减脂餐避坑指南'],
    );
    expect(sat['减脂餐一周食谱']).toBe(0.4);
    expect(sat['增肌餐一周食谱']).toBe(0); // 「增肌餐」与减脂帖仅可能撞单个 gram，不够 2 个
  });
});

describe('computeSaturation · 真 SQLite 取数', () => {
  it('近 72h 的竞对作品计入（publishedAt 为空时退到 crawledAt）', async () => {
    const comp = await seedCompetitor();
    await seedPost(comp.id, '减脂餐做法合集'); // publishedAt null，crawledAt=now → 在窗口内
    await seedPost(comp.id, '减脂餐避坑指南', { publishedAt: new Date(Date.now() - 10 * HOURS) });
    const sat = await computeSaturation(['减脂餐一周食谱']);
    expect(sat['减脂餐一周食谱']).toBe(0.4);
  });

  it('72h 之前发布的老作品不计入', async () => {
    const comp = await seedCompetitor();
    await seedPost(comp.id, '减脂餐做法合集', { publishedAt: new Date(Date.now() - 80 * HOURS) });
    const sat = await computeSaturation(['减脂餐一周食谱']);
    expect(sat['减脂餐一周食谱'] ?? 0).toBe(0);
  });

  it('竞对库为空 → 空表（新账号不受影响，coarseRank 缺省按 0 处理）', async () => {
    const sat = await computeSaturation(['减脂餐一周食谱']);
    expect(sat).toEqual({});
  });

  it('候选为空 → 空表且不查库', async () => {
    expect(await computeSaturation([])).toEqual({});
  });
});
