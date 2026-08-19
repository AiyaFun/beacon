import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { growthOverWindow, diffObservations, growthRate, windowRange, isApproximate, type Observation } from '@/lib/insight/growth';

// 区间增长的口径。三条纪律都拿反例钉死——这些恰恰是「看起来有数、其实是编的」的高发点。

const at = (iso: string) => new Date(iso);
const obs = (iso: string, m: Record<string, number>): Observation => ({ at: at(iso), metrics: m });

const FROM = at('2026-08-01T00:00:00Z');
const TO = at('2026-08-08T00:00:00Z');

describe('🔒 增长 · 两端都观测到才算', () => {
  it('两端都有 → 净增算得对', () => {
    const { delta, unavailable } = diffObservations({ views: 1000, likes: 50 }, { views: 1800, likes: 90 });
    expect(delta.views).toBe(800);
    expect(delta.likes).toBe(40);
    expect(unavailable).toEqual([]);
  });

  it('🔒 上次没采、这次采到 → 是「算不出增长」，不是「涨了这么多」', () => {
    // 真实场景：X 的书签数今天才开始采。旧快照没有 collects，新快照有 8249。
    // 按「缺席当 0」会报「收藏涨了 8249」——凭空造出一个增长事件。
    const { delta, unavailable } = diffObservations({ likes: 100 }, { likes: 120, collects: 8249 });
    expect(delta.collects).toBeUndefined();
    expect(unavailable).toContain('collects');
    expect(delta.likes).toBe(20); // 两端都有的键照常算
  });

  it('这次没采到（平台改版漏采）同样算不出，不许报成「跌到 0」', () => {
    const { delta, unavailable } = diffObservations({ views: 5000 }, { likes: 10 });
    expect(delta.views).toBeUndefined();
    expect(unavailable).toContain('views');
  });

  it('两端都没有的键不进 unavailable（该平台压根没这项，不必刷屏）', () => {
    const { unavailable } = diffObservations({ views: 1 }, { views: 2 });
    expect(unavailable).toEqual([]);
  });

  it('🔒 负增长如实呈现，不钳 0（掉粉/播放被回收都是真实信号）', () => {
    const { delta } = diffObservations({ followers: 10000 }, { followers: 9800 });
    expect(delta.followers).toBe(-200);
  });
});

describe('🔒 增长 · 基准点取窗口之前最近的观测', () => {
  it('窗口前有观测 → 用它当基准（否则会漏掉「窗口开始→首次采集」那段）', () => {
    const s = growthOverWindow(
      [
        obs('2026-07-31T12:00:00Z', { views: 1000 }), // 窗口之前
        obs('2026-08-03T00:00:00Z', { views: 1500 }),
        obs('2026-08-07T00:00:00Z', { views: 2200 }),
      ],
      FROM, TO,
    );
    expect(s.status).toBe('ok');
    expect(s.delta.views).toBe(1200); // 2200 - 1000（不是 2200-1500=700）
    expect(s.baselineInsideWindow).toBe(false);
  });

  it('窗口前没有观测 → 用窗口内首点，并标记这只是下界', () => {
    const s = growthOverWindow(
      [obs('2026-08-03T00:00:00Z', { views: 1500 }), obs('2026-08-07T00:00:00Z', { views: 2200 })],
      FROM, TO,
    );
    expect(s.delta.views).toBe(700);
    expect(s.baselineInsideWindow).toBe(true); // UI 必须据此标注「窗口开始那段没观测到」
  });

  it('窗口之后的观测不参与（不许把未来的数算进这个区间）', () => {
    const s = growthOverWindow(
      [obs('2026-08-03T00:00:00Z', { views: 1500 }), obs('2026-08-20T00:00:00Z', { views: 9999 })],
      FROM, TO,
    );
    expect(s.latest?.metrics.views).toBe(1500);
    expect(s.status).toBe('single-point');
  });
});

describe('🔒 增长 · 算不出来时不许假装是 0', () => {
  it('窗口内只有一个点且没有更早基准 → single-point，delta 为空', () => {
    const s = growthOverWindow([obs('2026-08-03T00:00:00Z', { views: 1500 })], FROM, TO);
    expect(s.status).toBe('single-point');
    expect(s.delta.views).toBeUndefined();
  });

  it('窗口内一个点都没有 → no-data', () => {
    const s = growthOverWindow([obs('2026-07-01T00:00:00Z', { views: 1 })], FROM, TO);
    expect(s.status).toBe('no-data');
    expect(s.points).toEqual([]);
  });

  it('完全没有观测 → no-data，不炸', () => {
    const s = growthOverWindow([], FROM, TO);
    expect(s.status).toBe('no-data');
    expect(s.baseline).toBeNull();
  });
});

describe('增长 · 时点序列（用户要的「对应时间点的增长」）', () => {
  it('窗口内每次采集一个点，按时间升序，各带相对上一点的增量', () => {
    const s = growthOverWindow(
      [
        obs('2026-07-31T00:00:00Z', { views: 1000 }),
        obs('2026-08-02T00:00:00Z', { views: 1200 }),
        obs('2026-08-05T00:00:00Z', { views: 1700 }),
        obs('2026-08-06T00:00:00Z', { views: 1750 }),
      ],
      FROM, TO,
    );
    expect(s.points.map((p) => p.delta?.views)).toEqual([200, 500, 50]);
    expect(s.points.map((p) => p.at.toISOString().slice(0, 10))).toEqual(['2026-08-02', '2026-08-05', '2026-08-06']);
  });

  it('没有更早基准时，首点的增量是 null（不是 0——没有上一点就是算不出）', () => {
    const s = growthOverWindow(
      [obs('2026-08-02T00:00:00Z', { views: 1200 }), obs('2026-08-05T00:00:00Z', { views: 1700 })],
      FROM, TO,
    );
    expect(s.points[0].delta).toBeNull();
    expect(s.points[1].delta?.views).toBe(500);
  });

  it('乱序传入照样按时间排好', () => {
    const s = growthOverWindow(
      [obs('2026-08-05T00:00:00Z', { views: 1700 }), obs('2026-08-02T00:00:00Z', { views: 1200 })],
      FROM, TO,
    );
    expect(s.points.map((p) => p.metrics.views)).toEqual([1200, 1700]);
  });
});

describe('增长率', () => {
  it('正常算', () => {
    expect(growthRate(1000, 200)).toBeCloseTo(0.2, 6);
  });

  it('🔒 起点为 0 → null（从 0 涨到 100 的「增长率」写成任何数字都是假的）', () => {
    expect(growthRate(0, 100)).toBeNull();
    expect(growthRate(undefined, 100)).toBeNull();
  });

  it('净增缺席 → null', () => {
    expect(growthRate(1000, undefined)).toBeNull();
  });
});

describe('🔒 增长追踪：没有独立页，且两页各管一侧', () => {
  // 用户 2026-08-10 两次定调：先是「融合在竞对监控里，不要单独做一个」，
  // 再是「自有放数据看板，竞对就放竞对单边」。
  // 守两件事：① 别把独立页加回来；② 别让两页互相掺对方的数据——
  // 掺了之后同一行会在两处出现，改一处忘一处就开始漂移。
  const COMP = readFileSync(resolve(process.cwd(), 'app/(app)/competitors/page.tsx'), 'utf8');
  const DATA = readFileSync(resolve(process.cwd(), 'app/(app)/data/page.tsx'), 'utf8');

  it('不许存在独立的 /growth 页面', () => {
    expect(existsSync(resolve(process.cwd(), 'app/(app)/growth/page.tsx'))).toBe(false);
  });

  it('导航里不许再出现 /growth 入口', () => {
    const nav = readFileSync(resolve(process.cwd(), 'lib/nav.ts'), 'utf8');
    const code = nav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain("'/growth'");
  });

  it('🔒 竞对页只取竞对增长，不许掺自有', () => {
    expect(COMP).toContain('loadRivalGrowth');
    expect(COMP).not.toContain('loadSelfGrowth');
  });

  it('🔒 数据看板只取自有增长，不许掺竞对', () => {
    expect(DATA).toContain('loadSelfGrowth');
    expect(DATA).not.toContain('loadRivalGrowth');
  });

  it('🔒 GrowthBoard 是客户端组件，props 里不许有函数类型', () => {
    // 2026-08-11 生产事故：给它传了 `windowHref: (k) => string`，
    // 服务端组件 → 客户端组件的边界不允许传函数，Next 在**渲染时**抛
    // 「Functions cannot be passed directly to Client Components」，/data 整页打不开。
    // ⚠️ `next build` 与「grep 产物里有没有这段文案」都查不出来 —— 前者不做跨边界序列化检查，
    // 后者只证明代码打进去了、不证明它能渲染。所以只能在源码层把契约钉死。
    const src = readFileSync(resolve(process.cwd(), 'components/GrowthBoard.tsx'), 'utf8');
    expect(src).toContain("'use client'");
    // 取 GrowthBoard 的 props 类型块（`}: {` 到与之匹配的 `}) {`）
    const m = /export function GrowthBoard\(\{[\s\S]*?\}: \{([\s\S]*?)\n\}\) \{/.exec(src);
    expect(m, '没找到 GrowthBoard 的 props 类型块').not.toBeNull();
    const props = m![1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(props, 'props 里出现了函数类型（=>），跨 client 边界会在渲染时炸').not.toMatch(/=>/);
  });

  it('🔒 两个调用页都不许把箭头函数当 prop 传给 GrowthBoard', () => {
    for (const [name, src] of [['竞对页', COMP], ['数据看板', DATA]] as const) {
      expect(src, `${name} 给 GrowthBoard 传了内联箭头函数`).not.toMatch(/<GrowthBoard[\s\S]{0,400}?=\{\([a-zA-Z]*\)\s*=>/);
    }
  });

  it('两页都真的渲染了增长看板', () => {
    for (const [name, src] of [['竞对页', COMP], ['数据看板', DATA]] as const) {
      expect(src, `${name} 少了 GrowthBoard`).toContain('GrowthBoard');
    }
  });
});

describe('🔒 约数标注（B站「1.0亿」这类展示值）', () => {
  // 用户决定 B站 就用页面采集的展示值、不调 API。那就必须把「这是约数」说出来：
  // 展示值要涨到 1.1亿 才会变，增长页会稳定显示「+0」，和「真的没涨」无法区分。
  it('B站 大数 → 标为约数', () => {
    expect(isApproximate('bilibili', [102372046])).toBe(true);
  });

  it('B站 小数（几千）→ 不标：那个量级页面上印的就是精确值，无谓打折扣', () => {
    expect(isApproximate('bilibili', [6746, 3200])).toBe(false);
  });

  it('🔒 X / YouTube 永远不标：它们取的是 aria-label / 内联脚本里的精确值', () => {
    expect(isApproximate('x', [2174478])).toBe(false);
    expect(isApproximate('youtube', [1802559974])).toBe(false);
  });

  it('抖音/小红书等中文平台同样按展示值处理', () => {
    expect(isApproximate('douyin', [97000])).toBe(true);
    expect(isApproximate('xiaohongshu', [12300])).toBe(true);
  });

  it('空值/缺席不触发标注', () => {
    expect(isApproximate('bilibili', [undefined, null])).toBe(false);
  });
});

describe('时间窗', () => {
  it('7 天窗口的起止对得上', () => {
    const now = at('2026-08-10T12:00:00Z');
    const { from, to } = windowRange('7d', now);
    expect(to).toEqual(now);
    expect(from.toISOString()).toBe('2026-08-03T12:00:00.000Z');
  });
});
