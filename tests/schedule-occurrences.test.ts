import { describe, it, expect } from 'vitest';
import { projectOccurrences, summarizeOccurrences, type OccurrenceRule } from '@/lib/workflow/schedule-occurrences';
import { MAX_RUNS_PER_DAY } from '@/lib/workflow/schedule';

// 定时运营中心（2026-09-11 P0-3）：从「配了一条定时」到「未来 7 天几点跑什么、会不会撞、有没有错过」。
// 全是按规则现算的 read model，不落库；时区一律北京时间。

/** 北京时间的某时刻（容器跑 UTC，用例不能写本地时间） */
const cn = (iso: string) => new Date(`${iso}+08:00`);

const rule = (p: Partial<OccurrenceRule> = {}): OccurrenceRule => ({
  id: 'a', label: '🧩 日更', accountId: 'acc', atHour: 9, atMinute: 0, weekdays: [], enabled: true,
  lastRunDay: null, lastStatus: null, lastError: null, failStreak: 0, estCalls: 4, ...p,
});
const opts = { days: 7, maxPerDay: MAX_RUNS_PER_DAY, tickMinutes: 10 };

describe('投影：每天 / 周几 / 停用', () => {
  it('每天 09:00 往后看 7 天就是 7 条，时刻是北京时间 09:00', () => {
    const list = projectOccurrences([rule()], cn('2026-09-11T08:00:00'), opts);
    expect(list).toHaveLength(7);
    expect(list[0].dayKey).toBe('2026-09-11');
    expect(list[0].time).toBe('09:00');
    // 北京 09:00 = UTC 01:00
    expect(list[0].at.toISOString()).toBe('2026-09-11T01:00:00.000Z');
    expect(list[6].dayKey).toBe('2026-09-17');
    expect(list[0].source).toContain('每天');
  });

  it('周几按北京时间的星期算；2026-09-11 是周五，只挑周一、周五', () => {
    const list = projectOccurrences([rule({ weekdays: [1, 5] })], cn('2026-09-11T08:00:00'), opts);
    expect(list.map((o) => o.dayKey)).toEqual(['2026-09-11', '2026-09-14']);
    expect(list[0].source).toContain('每周一、五');
  });

  it('跨零点那几小时星期不能按 UTC 算：北京 9/12 01:00 已是周六', () => {
    // UTC 仍是 9/11 17:00（周五）。按 UTC 算今天会误判成周五
    const list = projectOccurrences([rule({ weekdays: [6], atHour: 10 })], cn('2026-09-12T01:00:00'), { ...opts, days: 1 });
    expect(list).toHaveLength(1);
    expect(list[0].dayKey).toBe('2026-09-12');
  });

  it('停用的不投影', () => {
    expect(projectOccurrences([rule({ enabled: false })], cn('2026-09-11T08:00:00'), opts)).toEqual([]);
  });

  it('跨月：9/29 往后 7 天走到 10/5', () => {
    const list = projectOccurrences([rule()], cn('2026-09-29T08:00:00'), opts);
    expect(list[6].dayKey).toBe('2026-10-05');
  });
});

describe('今天这一格：错过 / 已跑 / 已跳过', () => {
  it('过了扫描窗口还没跑 = 错过；窗口内不算错过', () => {
    expect(projectOccurrences([rule()], cn('2026-09-11T09:10:00'), opts)[0].flags).toContain('missed');
    expect(projectOccurrences([rule()], cn('2026-09-11T09:09:59'), opts)[0].flags).not.toContain('missed');
    expect(projectOccurrences([rule()], cn('2026-09-11T08:59:00'), opts)[0].flags).toEqual([]);
  });

  it('lastRunDay 是今天 = 今天已跑，不算错过；lastStatus=skipped 标成已跳过', () => {
    const a = projectOccurrences([rule({ lastRunDay: '2026-09-11', lastStatus: 'done' })], cn('2026-09-11T12:00:00'), opts)[0];
    expect(a.flags).toEqual(['done_today']);
    const b = projectOccurrences([rule({ lastRunDay: '2026-09-11', lastStatus: 'skipped' })], cn('2026-09-11T12:00:00'), opts)[0];
    expect(b.flags).toEqual(['skipped_today']);
  });

  it('明天那一格永远不带今天的标记', () => {
    const list = projectOccurrences([rule({ lastRunDay: '2026-09-11' })], cn('2026-09-11T12:00:00'), opts);
    expect(list[1].flags).toEqual([]);
  });
});

describe('撞车与上限', () => {
  it('同一账号同一分钟两条 = 撞车；不同账号不算', () => {
    const list = projectOccurrences([rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c', accountId: 'other' })], cn('2026-09-11T08:00:00'), { ...opts, days: 1 });
    const flags = Object.fromEntries(list.map((o) => [o.scheduleId, o.flags]));
    expect(flags.a).toContain('overlap');
    expect(flags.b).toContain('overlap');
    expect(flags.c).not.toContain('overlap');
  });

  it(`一天排到第 ${MAX_RUNS_PER_DAY + 1} 条起会被上限拦下；今天已跑的也占名额`, () => {
    const rules = Array.from({ length: MAX_RUNS_PER_DAY + 1 }, (_, i) => rule({ id: `r${i}`, accountId: `acc${i}`, atHour: 8 + i }));
    const list = projectOccurrences(rules, cn('2026-09-11T00:00:00'), { ...opts, days: 1 });
    expect(list.filter((o) => o.flags.includes('capped')).map((o) => o.scheduleId)).toEqual([`r${MAX_RUNS_PER_DAY}`]);

    // 前面一条今天已经跑过：它占了名额，最后那条照样被拦
    const rules2 = rules.map((r, i) => (i === 0 ? { ...r, lastRunDay: '2026-09-11', lastStatus: 'done' } : r));
    const list2 = projectOccurrences(rules2, cn('2026-09-11T12:00:00'), { ...opts, days: 1 });
    expect(list2.filter((o) => o.flags.includes('capped')).map((o) => o.scheduleId)).toEqual([`r${MAX_RUNS_PER_DAY}`]);
    expect(list2[0].flags).toEqual(['done_today']);
  });
});

describe('汇总：预计最多烧多少次调用', () => {
  it('只算会真的跑的那些；估不了的单独计数', () => {
    const list = projectOccurrences(
      [rule({ id: 'a', estCalls: 4 }), rule({ id: 'b', estCalls: null, atHour: 10 }), rule({ id: 'c', estCalls: 30, lastRunDay: '2026-09-11', lastStatus: 'done', atHour: 7 })],
      cn('2026-09-11T08:00:00'),
      { ...opts, days: 1 },
    );
    const s = summarizeOccurrences(list);
    expect(s.total).toBe(3);
    expect(s.estCallsMax).toBe(4);
    expect(s.unknownEst).toBe(1);
  });
});
