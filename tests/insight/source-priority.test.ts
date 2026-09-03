import { describe, it, expect } from 'vitest';
import {
  sourceRank,
  pickAuthoritativeSnapshot,
  authoritativeMetrics,
  type SnapshotLike,
} from '@/lib/insight/source-priority';

// 来源优先级：官方 > 插件 > 手填。
//
// 这个文件锁两件事：
//   1. 同一时点多来源冲突时，高可信来源说了算（修「谁最后写谁说了算」）；
//   2. 但**绝不**因此让陈旧的高可信数据压过更新的低可信数据——那会把长尾爆款判成跑输，
//      比原来的 bug 更糟。第 2 条是这条规则最容易被写坏的地方。

const PUB = new Date('2026-07-01T00:00:00Z');
const day = (n: number) => new Date(PUB.getTime() + n * 86_400_000);

const snap = (o: {
  d: number;
  source: string | null;
  views: number;
  milestone?: string | null;
  hour?: number;
}): SnapshotLike => ({
  takenAt: new Date(day(o.d).getTime() + (o.hour ?? 0) * 3_600_000),
  metrics: JSON.stringify({ views: o.views }),
  source: o.source,
  milestone: o.milestone ?? null,
});

const viewsOf = (s: SnapshotLike | null) => (s ? JSON.parse(s.metrics).views : null);

describe('sourceRank · 三档口径', () => {
  it('官方 > 插件 > 手填', () => {
    expect(sourceRank('tikhub')).toBeGreaterThan(sourceRank('plugin'));
    expect(sourceRank('plugin')).toBeGreaterThan(sourceRank('manual'));
  });
  it('各家官方适配器同档', () => {
    for (const s of ['wechat-datacube', 'tikhub', 'youtube-official', 'twitterapi-io', 'newrank']) {
      expect(sourceRank(s)).toBe(sourceRank('tikhub'));
    }
  });
  it('null / 空 / 未知都当手填（最保守的一档）', () => {
    expect(sourceRank(null)).toBe(sourceRank('manual'));
    expect(sourceRank(undefined)).toBe(sourceRank('manual'));
    expect(sourceRank('')).toBe(sourceRank('manual'));
  });
});

describe('pickAuthoritativeSnapshot · 同一天里高可信来源说了算', () => {
  it('同日：官方压过手填（无论谁后写）', () => {
    const s = pickAuthoritativeSnapshot(
      [
        snap({ d: 7, source: 'tikhub', views: 100000, hour: 1 }),
        snap({ d: 7, source: 'manual', views: 90000, hour: 9 }), // 手填后写
      ],
      PUB,
    );
    expect(viewsOf(s)).toBe(100000);
  });

  it('同日：官方压过插件，插件压过手填', () => {
    const all = [
      snap({ d: 7, source: 'manual', views: 1, hour: 9 }),
      snap({ d: 7, source: 'plugin', views: 2, hour: 8 }),
      snap({ d: 7, source: 'tikhub', views: 3, hour: 1 }),
    ];
    expect(viewsOf(pickAuthoritativeSnapshot(all, PUB))).toBe(3);
    expect(viewsOf(pickAuthoritativeSnapshot(all.slice(0, 2), PUB))).toBe(2);
  });

  it('同日同来源：取 takenAt 最新（沿用 toDailySeries 的既有口径）', () => {
    const s = pickAuthoritativeSnapshot(
      [
        snap({ d: 7, source: 'manual', views: 100, hour: 1 }),
        snap({ d: 7, source: 'manual', views: 200, hour: 9 }),
      ],
      PUB,
    );
    expect(viewsOf(s)).toBe(200);
  });
});

describe('pickAuthoritativeSnapshot · 陈旧的高可信来源不许压过更新的低可信来源', () => {
  // 这是最要命的一条：官方 D+1 的 1000 若压过手填 D+30 的 50 万，
  // 一篇长尾爆款会被判成跑输，进而写一条「切入角未跑出基线」的错记忆。
  it('官方 D+1 vs 手填 D+30 → 取 D+30 的手填', () => {
    const s = pickAuthoritativeSnapshot(
      [
        snap({ d: 1, source: 'tikhub', views: 1000, milestone: 'D+1' }),
        snap({ d: 30, source: 'manual', views: 500000 }),
      ],
      PUB,
    );
    expect(viewsOf(s)).toBe(500000);
  });

  it('取最新逻辑日，再在该日内比可信度', () => {
    const s = pickAuthoritativeSnapshot(
      [
        snap({ d: 1, source: 'tikhub', views: 1000, milestone: 'D+1' }),
        snap({ d: 7, source: 'manual', views: 80000, hour: 9 }),
        snap({ d: 7, source: 'tikhub', views: 82000, milestone: 'D+7', hour: 1 }),
      ],
      PUB,
    );
    expect(viewsOf(s)).toBe(82000);
  });

  it('milestone 标签与 takenAt 混排时按逻辑日对齐（官方带标签、插件不带）', () => {
    const s = pickAuthoritativeSnapshot(
      [
        // 官方 D+7 的点，但写库时间很晚（回填是补写的）
        { takenAt: day(20), metrics: JSON.stringify({ views: 70000 }), source: 'tikhub', milestone: 'D+7' },
        // 插件在第 10 天现场抓的
        snap({ d: 10, source: 'plugin', views: 95000 }),
      ],
      PUB,
    );
    // 逻辑日 10 > 7，取插件那条——不能因为官方那条 takenAt 更晚就选它
    expect(viewsOf(s)).toBe(95000);
  });

  it('空快照 → null', () => {
    expect(pickAuthoritativeSnapshot([], PUB)).toBeNull();
  });

  // 「没有观测」≠「一个更可信的 0」。让无指标的快照顶掉有值的记录 = 凭空把数据抹成 0，
  // 比选错来源严重得多。
  it('🔒 没有任何指标的快照不参与竞选，哪怕它更新、来源更可信', () => {
    const empty = { takenAt: day(30), metrics: '{}', source: 'tikhub', milestone: null };
    expect(pickAuthoritativeSnapshot([empty], PUB)).toBeNull();
    const s = pickAuthoritativeSnapshot([snap({ d: 7, source: 'manual', views: 5000 }), empty], PUB);
    expect(viewsOf(s)).toBe(5000);
  });

  it('只有 completion（率）也算有指标 —— 后台常常只补得到完播率', () => {
    const onlyRate = { takenAt: day(7), metrics: JSON.stringify({ completion: 0.42 }), source: 'plugin', milestone: null };
    expect(pickAuthoritativeSnapshot([onlyRate], PUB)).not.toBeNull();
  });

  it('全是空快照 → 回落 record.metrics，不被抹成 0', () => {
    const m = authoritativeMetrics(JSON.stringify({ views: 1000 }), [
      { takenAt: day(7), metrics: '{}', source: 'tikhub', milestone: null },
    ], PUB);
    expect(m.views).toBe(1000);
  });
});

describe('authoritativeMetrics · 回落', () => {
  it('无快照 → 回落到 PublishRecord.metrics（老记录照常能下结论）', () => {
    expect(authoritativeMetrics(JSON.stringify({ views: 42 }), [], PUB)).toEqual({ views: 42 });
  });
  it('有快照 → 用挑出来的那条，不用 record.metrics 上被覆盖的值', () => {
    const m = authoritativeMetrics(
      JSON.stringify({ views: 90000 }), // 手填后写覆盖到 record 上的值
      [
        snap({ d: 7, source: 'tikhub', views: 100000, hour: 1 }),
        snap({ d: 7, source: 'manual', views: 90000, hour: 9 }),
      ],
      PUB,
    );
    expect(m.views).toBe(100000);
  });
  it('快照 JSON 损坏 → 空对象而不是抛（旁路增强不许打断主流程）', () => {
    const m = authoritativeMetrics('{}', [{ takenAt: day(1), metrics: 'not json', source: 'tikhub', milestone: null }], PUB);
    expect(m).toEqual({});
  });
});
