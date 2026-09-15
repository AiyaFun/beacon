import { beijingDayKey, beijingParts, beijingMinuteOfDay, BEIJING_OFFSET_MIN } from '../beijing';
import { hhmm } from './schedule-format';

// ── 定时任务的未来实例：从「配了一条定时」到「明天几点会跑什么、会不会撞」 ────
//
// 【为什么是算出来的而不是落库的】ScheduledAgent 只存规则（几点、周几、开没开）。
// 把未来 7 天的实例写成表就有了第二份真相：规则一改，实例表不改就是谎话。
// 所以实例是**每次读的时候按规则现算**的 read model，唯一的输入是规则行 + 现在几点。
// 例外（跳过一次）也不建表：跳过 = 把 lastRunDay 写成今天，这正是执行器判「今天跑过了」的那一列
//（lib/workflow/schedule.ts shouldRun），执行器与界面看的是同一个字段。
//
// 【时区】全部按北京时间（lib/beijing.ts）。容器跑 UTC，用本机时区算「明天 9 点」会差 8 小时——
// 这个坑项目里已经踩过两次，这里不再踩第三次。
//
// **纯函数，零 prisma**：客户端组件与用例都能 import。

export type OccurrenceRule = {
  id: string;
  /** 到点派什么，给人看的一句话（scheduleTargetLabel 算好传进来） */
  label: string;
  accountId: string;
  accountName?: string;
  atHour: number;
  atMinute: number;
  /** 空数组 = 每天（与 shouldRun 同口径） */
  weekdays: number[];
  enabled: boolean;
  lastRunDay: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failStreak: number;
  /** 跑一次最多烧多少次模型调用（预设任务 = callBudget；流水线 = 会花钱的步数）。不知道就 null */
  estCalls: number | null;
};

export type OccurrenceFlag =
  /** 今天这个时刻已经过了扫描窗口，而 lastRunDay 不是今天：定时器没跑到它 */
  | 'missed'
  /** 同一天排在第 N 条之后（N = 每日上限）：到点会被上限拦下，除非前面的没跑 */
  | 'capped'
  /** 同一账号同一分钟还有别的计划：两条会抢同一份额度与同一个账号上下文 */
  | 'overlap'
  /** 今天已经跑过（lastRunDay = 今天）——作为「今天这一格」保留在时间轴上 */
  | 'done_today'
  /** 今天被跳过了（手动跳过或被上限拦下） */
  | 'skipped_today';

export type Occurrence = {
  scheduleId: string;
  label: string;
  accountId: string;
  accountName?: string;
  /** 这一刻的绝对时间（UTC 瞬间；界面上按北京时间印） */
  at: Date;
  /** 北京时间的 YYYY-MM-DD */
  dayKey: string;
  /** 北京时间 HH:MM */
  time: string;
  /** 0=今天 1=明天 … */
  dayOffset: number;
  flags: OccurrenceFlag[];
  /** 这条实例是怎么来的，给人看（报告验收：每个实例可解释来源） */
  source: string;
  estCalls: number | null;
};

export type ProjectOptions = {
  /** 往后看几天（含今天） */
  days?: number;
  /** 每个工作区每天最多跑几次（lib/workflow/schedule.ts MAX_RUNS_PER_DAY） */
  maxPerDay: number;
  /** 扫描周期（分钟）：过了 target+tick 还没跑就是错过 */
  tickMinutes?: number;
};

const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** 北京时间某天某时刻对应的 UTC 瞬间。 */
function beijingInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MIN * 60_000);
}

function dayKeyOf(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 把规则投影成未来 N 天的实例，并标出错过 / 会被上限拦下 / 撞车。
 *
 * 排序：按时间。同一天内先按时间再按 id，保证「谁排第 6 条」是确定的——
 * 上限闸在执行器里也是按扫描顺序先到先得，这里的判定是**估计**而非承诺，界面上要说清。
 */
export function projectOccurrences(rules: readonly OccurrenceRule[], now: Date, opts: ProjectOptions): Occurrence[] {
  const days = Math.max(1, Math.min(31, opts.days ?? 7));
  const tick = opts.tickMinutes ?? 10;
  const today = beijingDayKey(now);
  const nowMin = beijingMinuteOfDay(now);
  const base = beijingParts(now);
  const out: Occurrence[] = [];

  for (let d = 0; d < days; d += 1) {
    // 用 UTC 日期加减做「北京时间的第 d 天」：跨月跨年都由 Date 自己处理
    const dt = new Date(Date.UTC(base.year, base.month - 1, base.day + d));
    const year = dt.getUTCFullYear();
    const month = dt.getUTCMonth() + 1;
    const day = dt.getUTCDate();
    const dow = dt.getUTCDay();
    const dayKey = dayKeyOf(year, month, day);

    for (const r of rules) {
      if (!r.enabled) continue;
      if (r.weekdays.length > 0 && !r.weekdays.includes(dow)) continue;
      const flags: OccurrenceFlag[] = [];
      if (d === 0 && r.lastRunDay === today) {
        flags.push(r.lastStatus === 'skipped' || r.lastStatus === 'skipped_manual' ? 'skipped_today' : 'done_today');
      } else if (d === 0 && nowMin >= r.atHour * 60 + r.atMinute + tick) {
        flags.push('missed');
      }
      const when = r.weekdays.length === 0 ? '每天' : `每周${r.weekdays.map((w) => DOW_CN[w]).join('、')}`;
      out.push({
        scheduleId: r.id,
        label: r.label,
        accountId: r.accountId,
        accountName: r.accountName,
        at: beijingInstant(year, month, day, r.atHour, r.atMinute),
        dayKey,
        time: hhmm(r.atHour, r.atMinute),
        dayOffset: d,
        flags,
        source: `${when} ${hhmm(r.atHour, r.atMinute)}（北京时间）`,
        estCalls: r.estCalls,
      });
    }
  }

  out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.scheduleId.localeCompare(b.scheduleId));

  // 撞车：同一账号同一分钟不止一条
  const slot = new Map<string, Occurrence[]>();
  for (const o of out) {
    const k = `${o.accountId}|${o.at.getTime()}`;
    const arr = slot.get(k) ?? [];
    arr.push(o);
    slot.set(k, arr);
  }
  for (const arr of slot.values()) {
    if (arr.length > 1) for (const o of arr) if (!o.flags.includes('overlap')) o.flags.push('overlap');
  }

  // 上限：同一天按顺序数，排到第 maxPerDay 条之后的会被拦。
  // 今天已跑/已跳过的也占名额（执行器 runsToday 数的是 lastRunDay=今天的行，不分成败）。
  const perDay = new Map<string, number>();
  for (const o of out) {
    const n = (perDay.get(o.dayKey) ?? 0) + 1;
    perDay.set(o.dayKey, n);
    const consumed = o.flags.includes('done_today') || o.flags.includes('skipped_today');
    if (n > opts.maxPerDay && !consumed) o.flags.push('capped');
  }

  return out;
}

export type OccurrenceSummary = {
  total: number;
  missed: number;
  capped: number;
  overlap: number;
  /** 未来这些实例最多会烧多少次调用（只算能估的；估不了的条数在 unknownEst 里） */
  estCallsMax: number;
  unknownEst: number;
};

/** 顶部那几格数字。 */
export function summarizeOccurrences(list: readonly Occurrence[]): OccurrenceSummary {
  const s: OccurrenceSummary = { total: list.length, missed: 0, capped: 0, overlap: 0, estCallsMax: 0, unknownEst: 0 };
  for (const o of list) {
    if (o.flags.includes('missed')) s.missed += 1;
    if (o.flags.includes('capped')) s.capped += 1;
    if (o.flags.includes('overlap')) s.overlap += 1;
    const willRun = !o.flags.includes('done_today') && !o.flags.includes('skipped_today') && !o.flags.includes('capped');
    if (!willRun) continue;
    if (o.estCalls == null) s.unknownEst += 1;
    else s.estCallsMax += o.estCalls;
  }
  return s;
}
