import { describe, it, expect } from 'vitest';
import { analyzePublishTiming } from '@/lib/insight/timing';
import { toDailySeries, logicalDay } from '@/lib/insight/timeseries';
import { filterRecordsByRange, prevPeriodRecords } from '@/lib/insight/dashboard-filter';

// 没有发布时间的作品，不许被当成「今天发的」（2026-08-30）。
//
// ── 缺陷 ──
// lib/ingest/own-post.ts 的新建分支原来是 `publishedAt: post.publishedAt ?? new Date()`，
// 把**插件回填那一刻**当成发布时间存进库。小红书笔记页、B站视频页、YouTube 播放页的
// 解析器结构上就不产出这个字段，而「这是我的作品」按钮在这几页都是露出的。
//
// 下面三条就是它造成的三个用户可见的错误结论。它们**在修复之前一条测试都没有**——
// 所以这一组不只是防复发，也是把当初漏掉的那层覆盖补上。
const M = (views: number) => JSON.stringify({ views });
const at = (iso: string) => new Date(iso);

describe('🔒 时段分析：不知道几点发的，回答不了「几点发效果好」', () => {
  it('无发布时间的记录不进任何时段桶', () => {
    // 三条都在 UTC 02:00（北京 10:00），一条没有时间。
    // 如果那一条被算进来，它会落进「运行这段测试的那个时辰」，凭空多出一个桶。
    const r = analyzePublishTiming([
      { publishedAt: at('2026-06-01T02:00:00Z'), metrics: M(1000) },
      { publishedAt: at('2026-06-02T02:00:00Z'), metrics: M(1000) },
      { publishedAt: at('2026-06-03T02:00:00Z'), metrics: M(1000) },
      { publishedAt: null, metrics: M(999999) }, // 播放量极高，混进去必然改变结论
    ]);
    expect(r.hourSlots.length, '多出了一个来自「回填那一刻」的时段桶').toBe(1);
    expect(r.best?.sample).toBe(3);
    expect(r.overallAvg, '那条 999999 被算进均播了').toBe(1000);
  });

  it('🔒 但要说破有几条没参与（不说的话用户只会觉得「怎么少了几条」）', () => {
    const r = analyzePublishTiming([
      { publishedAt: at('2026-06-01T02:00:00Z'), metrics: M(1000) },
      { publishedAt: null, metrics: M(500) },
      { publishedAt: null, metrics: M(0) }, // 没播放量的本来就不参与统计，不该重复计入
    ]);
    expect(r.undated, '没采到发布时间、但有播放量的应该是 1 条').toBe(1);
  });

  it('全都没有发布时间时如实说不出结论，而不是编一个', () => {
    const r = analyzePublishTiming([
      { publishedAt: null, metrics: M(1000) },
      { publishedAt: null, metrics: M(2000) },
    ]);
    expect(r.hourSlots).toEqual([]);
    expect(r.best).toBeNull();
    expect(r.conclusive).toBe(false);
    expect(r.undated).toBe(2);
  });
});

describe('🔒 逐日曲线：没有发布时间就没有「发布后第 N 天」', () => {
  const snap = (iso: string, views: number) => ({
    takenAt: at(iso), metrics: { views }, source: 'plugin' as string | null, milestone: null as string | null,
  });

  it('publishedAt 为空 → 空序列（不是从今天起画一条假的）', () => {
    // 这正是缺陷的形状：建档时那条快照会落在 D+0，却携带这条作品**全生命周期**的
    // 累计播放，于是 analyzeCurveShape 一律判成 first_day_burst「首日爆发」。
    expect(toDailySeries([snap('2026-06-10T00:00:00Z', 500000)], null)).toEqual([]);
  });

  it('有发布时间时照常出序列（没把正常情况一起弄坏）', () => {
    const s = toDailySeries(
      [snap('2026-06-01T00:00:00Z', 100), snap('2026-06-04T00:00:00Z', 900)],
      at('2026-06-01T00:00:00Z'),
    );
    expect(s.map((p) => p.day)).toEqual([0, 3]);
  });

  it('logicalDay 对空发布时间返回 null，不返回 0', () => {
    // 返回 0 意味着「就是发布当天」——那是一个我们没有依据的断言
    expect(logicalDay(null, at('2026-06-10T00:00:00Z'), null)).toBeNull();
    expect(logicalDay(at('2026-06-01T00:00:00Z'), at('2026-06-04T00:00:00Z'), null)).toBe(3);
  });

  it('milestone 仍然优先（它自带 D+N，不依赖发布时间）', () => {
    expect(logicalDay(at('2026-06-01T00:00:00Z'), at('2026-06-09T00:00:00Z'), 'D+2')).toBe(2);
  });
});

describe('🔒 时间段筛选：不知道哪天发的，不进有界窗口', () => {
  const now = at('2026-06-30T00:00:00Z').getTime();
  const rows = [
    { publishedAt: at('2026-06-29T00:00:00Z') },
    { publishedAt: at('2026-01-01T00:00:00Z') },
    { publishedAt: null },
  ];

  it('近 7 天 / 近 30 天都不含它；「全部」里看得见', () => {
    expect(filterRecordsByRange(rows, '7d', now)).toHaveLength(1);
    expect(filterRecordsByRange(rows, '30d', now)).toHaveLength(1);
    expect(filterRecordsByRange(rows, 'all', now)).toHaveLength(3);
  });

  it('环比的上一周期同样不含它（否则环比分母里混进不知道哪天的东西）', () => {
    expect(prevPeriodRecords(rows, '7d', now).every((r) => r.publishedAt !== null)).toBe(true);
  });
});

// ── 竞对趋势的「净增」不许拿累计总数冒充（2026-08-30 修）─────────────────────
//
// 原来的判据是 `if (a == null && b == null) continue`——只在**两端都没有**时跳过。
// 于是首末观测有一端缺这一项时：
//   · 首次没采到、末次采到了 → `a - 0 = a`，把**这条作品的累计总数**印成「本段净增」；
//   · 首次采到了、末次没采到 → `0 - b` 钳成 0 → 印成「没涨」，而事实是「不知道」。
// 「抖音主页给不了收藏数、作品详情页给得了」这种一端有一端无是常态，不是边角。
//
// 同一个组件里、十几行之外的记录表就写着「⚠️ 原来这里是 `?? 0` —— 把『这次没采到
// 这一项』印成 0」——那处修过了，净增那处没有。
describe('🔒 竞对净增：一端缺失就是算不出来，不是 0 也不是累计值', () => {
  const snap = (iso: string, m: Record<string, number>) =>
    ({ takenAt: new Date(iso), metrics: JSON.stringify(m), source: 'plugin' as string | null });

  it('首次没采到这一项 → 不写这个键（绝不把累计总数当净增）', async () => {
    const { competitorTrend } = await import('@/lib/insight/competitor-trend');
    const t = competitorTrend([
      snap('2026-06-01T00:00:00Z', { views: 1000 }),            // 没有 collects
      snap('2026-06-08T00:00:00Z', { views: 1500, collects: 3400 }),
    ]);
    expect(t.growth?.views, '两端都有的照常算').toBe(500);
    expect(
      t.growth?.collects,
      '把 3400（这条作品的累计收藏）印成了「7 天内 +3400」',
    ).toBeUndefined();
  });

  it('末次没采到这一项 → 同样不写（否则印成「没涨」）', async () => {
    const { competitorTrend } = await import('@/lib/insight/competitor-trend');
    const t = competitorTrend([
      snap('2026-06-01T00:00:00Z', { views: 1000, collects: 200 }),
      snap('2026-06-08T00:00:00Z', { views: 1500 }),
    ]);
    expect(t.growth?.collects, '「不知道」被说成了「没涨」').toBeUndefined();
  });

  it('两端都有才给数（正常情况没被弄坏）', async () => {
    const { competitorTrend } = await import('@/lib/insight/competitor-trend');
    const t = competitorTrend([
      snap('2026-06-01T00:00:00Z', { views: 1000, collects: 200 }),
      snap('2026-06-08T00:00:00Z', { views: 1500, collects: 260 }),
    ]);
    expect(t.growth?.collects).toBe(60);
  });

  it('🔒 界面上算不出来时说破，而不是 ?? 0 印成「净增 0」', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'app/(app)/competitors/CompetitorTrendCell.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, '又变回 ?? 0 了').toContain("trend.growth?.[metric] ?? null");
    expect(src, '没说破「算不出来」').toContain('算不出来');
  });
});
