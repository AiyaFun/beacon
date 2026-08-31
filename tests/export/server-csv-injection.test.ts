import { describe, it, expect } from 'vitest';
import { publishCsv, snapshotCsv } from '@/lib/insight/csv';

// 服务端那两份导出也必须吃到公式注入的处置（2026-08-30）。
//
// 【为什么单独验一遍】修复是在 lib/csv.ts 里做的，insight/csv.ts 只是 re-export。
// 「改了共享函数所以两边都好了」是推断，不是证据——这个项目吃过太多次
// 「写了没接」的亏，共享层修好了而某条路根本没走它。这里走一遍真实的导出函数。
const rec = (title: string) => ({
  platform: 'douyin',
  title,
  publishedAt: new Date('2026-08-01T04:00:00Z'),
  fromRecommend: false,
  metrics: JSON.stringify({ views: 100, likes: 5 }),
  snapshots: [{ takenAt: new Date('2026-08-02T04:00:00Z'), metrics: JSON.stringify({ views: 200 }), source: 'manual', milestone: null }],
});

describe('发布明细 / 逐日快照导出', () => {
  const payload = '=HYPERLINK("http://evil","点我")';

  it.each([['publishCsv', publishCsv], ['snapshotCsv', snapshotCsv]] as const)('%s 中和公式引导符', (_n, fn) => {
    const csv = fn([rec(payload)]);
    expect(csv, '公式被原样写进单元格了').not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(csv).toContain("'=HYPERLINK");
  });

  it.each([['publishCsv', publishCsv], ['snapshotCsv', snapshotCsv]] as const)('%s 正常标题一个字不改', (_n, fn) => {
    expect(fn([rec('今天聊聊 AI')])).toContain('今天聊聊 AI');
  });

  it('🔒 两份导出都走同一个 buildCsv（不许有第三套拼装）', () => {
    // 这条防的是「以后有人在 insight/csv.ts 里又手搓一份」——
    // 那份不会吃到 lib/csv.ts 的任何后续修复
    for (const fn of [publishCsv, snapshotCsv]) {
      const csv = fn([rec('普通')]);
      expect(csv.charCodeAt(0), 'BOM 没了，说明没走 buildCsv').toBe(0xfeff);
      expect(csv, 'CRLF 没了，说明没走 buildCsv').toContain('\r\n');
    }
  });
});
