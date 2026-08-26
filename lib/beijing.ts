// 北京时间（Asia/Shanghai）口径的唯一事实源。
//
// 【为什么需要它】web / worker 容器跑在 **UTC** 上（docker-compose 里没有设 TZ，也刻意不设：
// 一个全局 TZ 会连带挪动配额窗口、账单月份、订单时间戳这些各自有口径的东西，
// blast radius 远大于它解决的问题）。于是凡是用「运行环境本地时区」做的日期计算，
// 在生产上算的都是 UTC 日，而这个偏差**只在每天 00:00–08:00（北京）之间显形**：
//
//   · 展示：那八个小时里所有日期都会渲染成**前一天**（服务端渲染的页面尤其明显）；
//   · 配额：文案写死「明日 0 点重置」，实际是 UTC 零点 = 北京时间**早上 8 点**才重置。
//
// 两件事都没有任何报错。同一个坑在定时任务（lib/jobs 的 tz）和竞对逐日快照
//（lib/insight/growth-store.ts 的 logicalDateCN）上各踩过一次，都是就地修的；
// 这个文件是把它收成一处，省得第三次。
//
// 【为什么用定值 +8 而不是 Intl】中国全境单一时区、1991 年后无夏令时，+8 就是精确值。
// 业务判定（配额窗口的键与生存期）每次 LLM 调用都要算一遍，不该押在运行环境的 ICU 数据上
// ——同 lib/bot/push-window.ts 的取舍。**给人看的格式化**另说：那里本来就要中文月份，
// 用 Intl 并显式传 timeZone（见 lib/format.ts）。

/** 给 Intl.DateTimeFormat 用的时区名（仅格式化用，业务判定用下面的定值偏移）。 */
export const BEIJING_TZ = 'Asia/Shanghai';

/** 北京时间相对 UTC 的偏移（分钟）。 */
export const BEIJING_OFFSET_MIN = 8 * 60;

const DAY_MS = 86_400_000;

/** 把时刻平移成「北京墙上时间的 UTC 影子」——只允许接着用 getUTC* 读，不要拿它当真实时刻。 */
function shadow(d: Date): Date {
  return new Date(d.getTime() + BEIJING_OFFSET_MIN * 60_000);
}

export type BeijingParts = { year: number; month: number; day: number; hour: number; minute: number };

/** 某个时刻在北京时间下的年/月/日/时/分。 */
export function beijingParts(d: Date = new Date()): BeijingParts {
  const s = shadow(d);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
  };
}

const pad2 = (n: number) => `${n}`.padStart(2, '0');

/** 北京时间的逻辑日 `YYYY-MM-DD`。与 lib/insight/growth-store.ts 的 logicalDateCN 同值。 */
export function beijingDayKey(d: Date = new Date()): string {
  const p = beijingParts(d);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 北京时间的逻辑月 `YYYY-MM`。 */
export function beijingMonthKey(d: Date = new Date()): string {
  const p = beijingParts(d);
  return `${p.year}-${pad2(p.month)}`;
}

/** 北京时间当日 00:00 对应的**真实时刻**（UTC 前一天 16:00）。 */
export function beijingStartOfDay(d: Date = new Date()): Date {
  const p = beijingParts(d);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - BEIJING_OFFSET_MIN * 60_000);
}

/** 北京时间次日 00:00 对应的真实时刻（= 当日额度的失效点）。 */
export function beijingEndOfDay(d: Date = new Date()): Date {
  return new Date(beijingStartOfDay(d).getTime() + DAY_MS);
}

/** 北京时间当月 1 日 00:00 对应的真实时刻。 */
export function beijingStartOfMonth(d: Date = new Date()): Date {
  const p = beijingParts(d);
  return new Date(Date.UTC(p.year, p.month - 1, 1) - BEIJING_OFFSET_MIN * 60_000);
}

/** 北京时间下月 1 日 00:00 对应的真实时刻（Date.UTC 会自动跨年，12 月不必特判）。 */
export function beijingEndOfMonth(d: Date = new Date()): Date {
  const p = beijingParts(d);
  return new Date(Date.UTC(p.year, p.month, 1) - BEIJING_OFFSET_MIN * 60_000);
}

/** 北京时间的「当日第几分钟」（0..1439）。 */
export function beijingMinuteOfDay(d: Date = new Date()): number {
  return (Math.floor(d.getTime() / 60_000) + BEIJING_OFFSET_MIN) % 1440;
}

/**
 * 北京时间的星期几（0=周日 … 6=周六，与 cron 和 JS 的 getDay 同一口径）。
 *
 * 【为什么不能用 d.getDay()】那是**本机时区**的星期。容器跑 UTC 时，
 * 北京周一早上 8 点在 UTC 还是周日晚上——一条 `0 8 * * 1` 的周报会整周不跑，
 * 而且不报错，只是那份周报从来不来。
 */
export function beijingWeekday(d: Date = new Date()): number {
  // 1970-01-01 是周四（getDay=4），所以从「北京时间过了多少个整日」推回星期
  const days = Math.floor((d.getTime() + BEIJING_OFFSET_MIN * 60_000) / 86_400_000);
  return (((days + 4) % 7) + 7) % 7;
}
