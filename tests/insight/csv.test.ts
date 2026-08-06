import { describe, it, expect } from 'vitest';
import { buildCsv, publishCsv, snapshotCsv, sourceTier, type CsvRecord } from '@/lib/insight/csv';

// CSV 导出：BOM、RFC4180 转义、来源分档、逐日展开。

describe('buildCsv', () => {
  it('带 UTF-8 BOM 与 CRLF', () => {
    const csv = buildCsv(['a', 'b'], [[1, 2]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(csv).toContain('\r\n');
  });
  it('含逗号/引号/换行的字段被转义', () => {
    const csv = buildCsv(['x'], [['含,逗号'], ['含"引号'], ['含\n换行']]);
    expect(csv).toContain('"含,逗号"');
    expect(csv).toContain('"含""引号"');
    expect(csv).toContain('"含\n换行"');
  });
});

describe('sourceTier', () => {
  it('分三档', () => {
    expect(sourceTier('manual')).toBe('manual');
    expect(sourceTier(null)).toBe('manual');
    expect(sourceTier('plugin')).toBe('plugin');
    expect(sourceTier('wechat-datacube')).toBe('official');
    expect(sourceTier('tikhub')).toBe('official');
  });
});

const rec = (over: Partial<CsvRecord> = {}): CsvRecord => ({
  platform: 'douyin',
  title: '测试内容',
  publishedAt: new Date(Date.UTC(2026, 6, 1)),
  fromRecommend: true,
  metrics: JSON.stringify({ views: 1000, likes: 50, comments: 10 }),
  snapshots: [],
  ...over,
});

describe('publishCsv', () => {
  it('每篇一行，含来源分档与 AI推荐标注', () => {
    // 这条快照没有任何指标（metrics '{}'）→ 不参与取值竞选，值回落到 record.metrics；
    // 但出处仍标 tikhub——明知是适配器写的却标「手填」是另一种失真
    const csv = publishCsv([rec({ snapshots: [{ takenAt: new Date(Date.UTC(2026, 6, 3)), metrics: '{}', source: 'tikhub', milestone: 'D+2' }] })]);
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines[0]).toContain('平台');
    expect(lines[1]).toContain('抖音');
    expect(lines[1]).toContain('AI推荐');
    expect(lines[1]).toContain('官方');
    expect(lines[1]).toContain('1000'); // 空快照没把真实值抹成 0
  });

  // 导出的数字必须与 /data 页面一致：两份对不上，用户只会认为产品在乱报数
  it('取值走来源优先级：官方压过后写的手填，出处标被采用的那条', () => {
    const day = (n: number) => new Date(Date.UTC(2026, 6, 1) + n * 86_400_000);
    const csv = publishCsv([
      rec({
        metrics: JSON.stringify({ views: 900 }), // record 上是被手填盖过的值
        snapshots: [
          { takenAt: day(7), metrics: JSON.stringify({ views: 5000 }), source: 'tikhub', milestone: 'D+7' },
          { takenAt: new Date(day(7).getTime() + 3600_000), metrics: JSON.stringify({ views: 900 }), source: 'manual', milestone: null },
        ],
      }),
    ]);
    const line = csv.replace('﻿', '').split('\r\n')[1];
    expect(line).toContain('5000');
    expect(line).not.toContain('900');
    expect(line).toContain('官方');
  });
});

describe('snapshotCsv', () => {
  it('每篇×每逻辑日一行，逻辑日按 milestone 标签', () => {
    const csv = snapshotCsv([
      rec({
        snapshots: [
          { takenAt: new Date(Date.UTC(2026, 6, 2)), metrics: JSON.stringify({ views: 500 }), source: 'plugin', milestone: null },
          { takenAt: new Date(Date.UTC(2026, 6, 3)), metrics: JSON.stringify({ views: 1200 }), source: 'tikhub', milestone: 'D+2' },
        ],
      }),
    ]);
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines).toHaveLength(3); // 表头 + 2 快照行
    expect(lines[1]).toContain('D+1'); // 07-02 距发布 07-01 = 逻辑日 1（null milestone 折算）
    expect(lines[1]).toContain('插件');
    expect(lines[2]).toContain('D+2'); // milestone 标签优先
    expect(lines[2]).toContain('官方');
  });
});
