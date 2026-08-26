import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logicalDateCN, sumMetrics } from '@/lib/insight/growth-store';

describe('🔒 逻辑日必须按 Asia/Shanghai 折算', () => {
  it('UTC 前一天的晚上，在中国已经是第二天', () => {
    // 2026-08-09T23:30Z = 北京时间 08-10 07:30。容器跑在 UTC 上，
    // 直接 toISOString().slice(0,10) 会记成 08-09 —— 每天早上 8 点前的采集全部错位一天。
    expect(logicalDateCN(new Date('2026-08-09T23:30:00Z'))).toBe('2026-08-10');
  });

  it('UTC 当天的白天，中国还是同一天', () => {
    expect(logicalDateCN(new Date('2026-08-10T03:00:00Z'))).toBe('2026-08-10');
  });

  it('北京时间午夜整点归属当天', () => {
    // 2026-08-09T16:00Z = 北京 08-10 00:00
    expect(logicalDateCN(new Date('2026-08-09T16:00:00Z'))).toBe('2026-08-10');
  });

  it('🔒 结论与 UTC 口径确实不同（这条红了说明时区没生效）', () => {
    const d = new Date('2026-08-09T23:30:00Z');
    expect(logicalDateCN(d)).not.toBe(d.toISOString().slice(0, 10));
  });

  it('格式恒为 YYYY-MM-DD（要当唯一键用，格式漂了会写出重复行）', () => {
    expect(logicalDateCN(new Date('2026-01-05T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('🔒 合计 · 一条都没采到的键返回 null，不是 0', () => {
  it('全都有 → 正常求和', () => {
    expect(sumMetrics([{ views: 100, likes: 10 }, { views: 200, likes: 5 }]))
      .toEqual({ totalViews: 300, totalLikes: 15, totalComments: null });
  });

  it('🔒 该平台没有播放量（抖音/小红书）→ totalViews 是 null 而不是 0', () => {
    // 写成 0 的话，增长页会画出一条恒等于 0 的播放曲线，看着像「一直没人看」
    const r = sumMetrics([{ likes: 100, comments: 3 }, { likes: 50, comments: 1 }]);
    expect(r.totalViews).toBeNull();
    expect(r.totalLikes).toBe(150);
    expect(r.totalComments).toBe(4);
  });

  it('部分作品缺某项 → 只累加有的那些（不把缺席当 0 拉低合计）', () => {
    const r = sumMetrics([{ views: 100 }, { likes: 7 }]);
    expect(r.totalViews).toBe(100);
    expect(r.totalLikes).toBe(7);
  });

  it('空列表 → 三项全 null', () => {
    expect(sumMetrics([])).toEqual({ totalViews: null, totalLikes: null, totalComments: null });
  });
});

describe('🔒 采集通道必须留下时点（增长曲线的原料）', () => {
  const COMPETITOR = readFileSync(resolve(process.cwd(), 'lib/ingest/competitor.ts'), 'utf8');
  const PIPELINE = readFileSync(resolve(process.cwd(), 'lib/pipeline.ts'), 'utf8');

  it('🔒 两条通道都不许再有「和上次一样就不写快照」的判据', () => {
    // 原来是 `if (toJson(prev) !== toJson(metrics)) 才写`。它让「没涨」和「没采」
    // 在序列上无法区分；叠加展示值四舍五入后，大号可能几个月一条快照都写不出来。
    for (const [name, src] of [['competitor.ts', COMPETITOR], ['pipeline.ts', PIPELINE]] as const) {
      expect(src, `${name} 仍在按「指标有没有变」决定要不要写快照`)
        .not.toMatch(/if\s*\(\s*toJson\(prev\)\s*!==\s*toJson\(/);
    }
  });

  it('首次入库也要写快照（否则序列缺起点，第一段增长永远丢失）', () => {
    expect(COMPETITOR).toMatch(/createdPost\.id/);
  });

  it('两条通道都要记账号级当日快照', () => {
    // 【断在调用上】只验名字的话，`import { recordCompetitorDaily }` 那一行就够它绿了——
    // 把两处 await 调用删掉，快照一条不写，守卫毫无反应。
    expect(COMPETITOR, '只 import 了没调用').toMatch(/await recordCompetitorDaily\(/);
    expect(PIPELINE, '只 import 了没调用').toMatch(/await recordCompetitorDaily\(/);
  });
});
