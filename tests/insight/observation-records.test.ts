import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { observationRecords, sourceLabel } from '@/lib/insight/competitor-trend';
import type { MetricCountKey } from '@/lib/json';

// 数据记录：把每一次采集摊成一行，回答「这段时间涨了多少」。
//
// 这张表的成立前提是**每条记录都标了来源**。不同页面给的字段天差地别：
// 抖音主页只有点赞，评论/收藏/转发只有作品详情页才有。不标来源的话，
// 同一条作品的记录会在「只有点赞」和「四项齐全」之间反复横跳，
// 用户会以为平台改了或数据丢了，其实只是这次换了种采法。

const KEYS: readonly MetricCountKey[] = ['likes', 'comments', 'collects'];
const at = (d: string) => new Date(`2026-08-${d}T10:00:00Z`);

describe('🔒 每次采集一行，标明来源', () => {
  const snaps = [
    { takenAt: at('01'), metrics: JSON.stringify({ likes: 1000 }), source: 'home' },
    { takenAt: at('03'), metrics: JSON.stringify({ likes: 1200, comments: 50, collects: 30 }), source: 'detail' },
  ];

  it('最新的排最前（先看最近发生了什么）', () => {
    const rows = observationRecords(snaps, KEYS);
    expect(rows).toHaveLength(2);
    expect(rows[0].takenAt.getTime()).toBeGreaterThan(rows[1].takenAt.getTime());
  });

  it('来源写成人话', () => {
    const rows = observationRecords(snaps, KEYS);
    expect(rows[0].sourceText).toBe('作品详情页');
    expect(rows[1].sourceText).toBe('账号主页');
  });

  it('老数据没有 source 字段时按主页算，不炸也不显示「未知」', () => {
    const rows = observationRecords([{ takenAt: at('01'), metrics: '{}' }], KEYS);
    expect(rows[0].sourceText).toBe('账号主页');
  });

  it('间隔天数如实给出（间隔越大，两点之间的增长越不该被当成日增）', () => {
    const rows = observationRecords(snaps, KEYS);
    expect(rows[0].gapDays).toBe(2);
    expect(rows[1].gapDays).toBeNull(); // 首次观测没有上一次
  });
});

describe('🔒 增量只在两次都采到时才算', () => {
  const snaps = [
    { takenAt: at('01'), metrics: JSON.stringify({ likes: 1000 }), source: 'home' },
    { takenAt: at('03'), metrics: JSON.stringify({ likes: 1200, comments: 50 }), source: 'detail' },
  ];
  const latest = () => observationRecords(snaps, KEYS)[0];
  const cell = (k: MetricCountKey) => latest().cells.find((c) => c.key === k)!;

  it('两次都有 → 算出净增', () => {
    expect(cell('likes').delta).toBe(200);
    expect(cell('likes').note).toBeNull();
  });

  it('🔒 上次没采到这一项 → 不许算成「从 0 涨到 50」', () => {
    // 拿 0 当上次的值，会把「上次没采这项」变成一个凭空造出来的暴涨
    const c = cell('comments');
    expect(c.value).toBe(50);
    expect(c.delta).toBeNull();
  });

  it('🔒 而且要说清楚为什么算不出来——点名上次是从哪采的', () => {
    expect(cell('comments').note).toContain('账号主页');
    expect(cell('comments').note).toContain('没有这一项');
  });

  it('这次没采到的项：值为 null，不写 0', () => {
    const c = cell('collects');
    expect(c.value).toBeNull();
    expect(c.delta).toBeNull();
    expect(c.note).toBe('这次没采到');
  });

  it('首次观测的每一项都标「首次观测」，不是「涨了 0」', () => {
    const first = observationRecords(snaps, KEYS)[1];
    for (const c of first.cells) expect(c.note).toBe('首次观测');
    for (const c of first.cells) expect(c.delta).toBeNull();
  });
});

describe('掉量也如实呈现', () => {
  it('负增长照实给，不钳 0（删评论/取消点赞是真实信号）', () => {
    const rows = observationRecords(
      [
        { takenAt: at('01'), metrics: JSON.stringify({ likes: 1000 }), source: 'detail' },
        { takenAt: at('02'), metrics: JSON.stringify({ likes: 940 }), source: 'detail' },
      ],
      KEYS,
    );
    expect(rows[0].cells.find((c) => c.key === 'likes')!.delta).toBe(-60);
  });
});

describe('🔒 入库要按来源分类', () => {
  const SCHEMA = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const PG = readFileSync(resolve(process.cwd(), 'prisma/schema.postgres.prisma'), 'utf8');
  const INGEST = readFileSync(resolve(process.cwd(), 'lib/ingest/competitor.ts'), 'utf8');
  const PIPELINE = readFileSync(resolve(process.cwd(), 'lib/pipeline.ts'), 'utf8');
  const SW = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

  it('两份 schema 都有 source 字段（漏一份生产就跟本地对不上）', () => {
    for (const [name, s] of [['sqlite', SCHEMA], ['postgres', PG]] as const) {
      expect(s, `${name} 的 PostMetricSnapshot 缺 source`).toMatch(/model PostMetricSnapshot[\s\S]*?source\s+String/);
    }
  });

  it('插件回传的快照带上来源', () => {
    expect(INGEST).toContain("source: payload.source ?? 'home'");
  });

  it('服务端通道标 server，与插件在页面上采的分开', () => {
    expect(PIPELINE).toMatch(/source:\s*'server'/);
  });

  it('补齐详情那条通道标 detail', () => {
    expect(SW).toMatch(/source:\s*'detail'/);
  });

  it('🔒 source 在 zod 里必须是可选的——老版本插件不发这个字段', () => {
    // 加了 required（或 default 让 z.infer 变必填）会让旧插件的每一批被整包打回，
    // 而 zod 打回是静默的：用户只会看到「采不到」，查不出为什么。
    expect(INGEST).toMatch(/source: z\.enum\(\[[^\]]*\]\)\.optional\(\)/);
  });
});
