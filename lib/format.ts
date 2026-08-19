import { BEIJING_TZ } from './beijing';

export function fmtNum(n: number | undefined | null): string {
  const v = n ?? 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}w`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

// ── 日期时间的展示口径：一律北京时间 ────────────────────────────────────
//
// 【为什么必须显式传 timeZone】不传就是「运行环境的本地时区」，而这里有两个运行环境：
//   · 服务端渲染跑在容器里 = **UTC** → 每天 00:00–08:00（北京）之间渲染出来的日期是**前一天**；
//   · 浏览器 = 用户机器的时区 → 出国/改过系统时区的用户看到的又是另一套。
// 同一个客户端组件两边都会渲染一遍，口径不一致还会在这八个小时里触发 hydration 不匹配。
// 产品的一切时间语义（平台发布时间、采集逻辑日、配额 0 点重置）都锚在北京时间上，
// 所以展示也只认北京时间——见 lib/beijing.ts。

const dateFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: BEIJING_TZ, month: '2-digit', day: '2-digit' });
const dateFullFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: BEIJING_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateLongFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: BEIJING_TZ, year: 'numeric', month: 'long', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BEIJING_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: BEIJING_TZ, hour: '2-digit', minute: '2-digit', hour12: false });

function toDate(d: Date | string | number | null | undefined): Date | null {
  if (d === null || d === undefined || d === '') return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 月-日（北京时间）。 */
export function fmtDate(d: Date | string | null | undefined): string {
  const date = toDate(d);
  return date ? dateFmt.format(date) : '—';
}

/** 年/月/日（北京时间）。到期日、发布日这类要写清哪一年的场合用它。 */
export function fmtDateFull(d: Date | string | null | undefined): string {
  const date = toDate(d);
  return date ? dateFullFmt.format(date) : '—';
}

/** 2026年8月18日（北京时间）。标题栏那种要读起来像话的场合用它。 */
export function fmtDateLong(d: Date | string | null | undefined): string {
  const date = toDate(d);
  return date ? dateLongFmt.format(date) : '—';
}

/** 年/月/日 时:分（北京时间，24 小时制）。 */
export function fmtDateTime(d: Date | string | null | undefined): string {
  const date = toDate(d);
  return date ? dateTimeFmt.format(date) : '—';
}

/** 时:分（北京时间，24 小时制）。 */
export function fmtTime(d: Date | string | null | undefined): string {
  const date = toDate(d);
  return date ? timeFmt.format(date) : '—';
}

export function relTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  const diff = Date.now() - date.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h}小时前`;
  const day = Math.floor(h / 24);
  return `${day}天前`;
}

export function scoreColor(score: number): string {
  if (score >= 75) return 'var(--green)';
  if (score >= 55) return 'var(--amber)';
  return 'var(--red)';
}
