import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BEIJING_TZ,
  beijingParts,
  beijingDayKey,
  beijingMonthKey,
  beijingStartOfDay,
  beijingEndOfDay,
  beijingStartOfMonth,
  beijingEndOfMonth,
  beijingMinuteOfDay,
} from '@/lib/beijing';
import { fmtDate, fmtDateFull, fmtDateTime, fmtTime, fmtDateLong } from '@/lib/format';
import { logicalDateCN } from '@/lib/insight/growth-store';

// 北京时间口径的守卫。
//
// 【被守的是什么】容器跑在 UTC 上。任何用「运行环境本地时区」算出来的日期，在北京时间
// 00:00–08:00 之间都会差一天——而这八小时恰好是最少有人盯着的时候，所以这类错误
// 一直没被发现：日额度文案写「明日 0 点重置」，实际早上八点才重置；页面上的发布日期
// 在清晨显示成前一天。下面每一条都用**落在那八小时里**的时刻来断言。

// 2026-08-18 23:30 UTC = 2026-08-19 07:30 北京（正在坑里）
const EARLY = new Date('2026-08-18T23:30:00.000Z');
// 2026-08-18 09:00 UTC = 2026-08-18 17:00 北京（不在坑里，两种口径同值）
const NOON = new Date('2026-08-18T09:00:00.000Z');

// 用 Intl 的真时区数据独立算一遍，证明定值 +8 不是拍脑袋
function viaIntl(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

describe('北京时间口径', () => {
  it('清晨那八个小时里，UTC 日与北京日不是同一天', () => {
    expect(EARLY.toISOString().slice(0, 10)).toBe('2026-08-18'); // UTC 说是 18 号
    expect(beijingDayKey(EARLY)).toBe('2026-08-19'); // 北京已经 19 号了
    expect(beijingDayKey(NOON)).toBe('2026-08-18');
  });

  it('🔒 定值 +8 与 Intl 的 Asia/Shanghai 逐时对账，全年任意时刻都相等', () => {
    // 每 37 分钟取一个点扫满一年（含闰年 2 月、年末跨年），避免只测整点掩盖偏移错误
    const start = Date.UTC(2026, 0, 1);
    const mismatches: string[] = [];
    for (let t = start; t < start + 366 * 86_400_000; t += 37 * 60_000) {
      const d = new Date(t);
      if (beijingDayKey(d) !== viaIntl(d)) mismatches.push(d.toISOString());
      if (mismatches.length > 3) break;
    }
    expect(mismatches).toEqual([]);
  });

  it('logicalDateCN（竞对逐日快照）与共享口径同值', () => {
    for (const d of [EARLY, NOON, new Date('2026-12-31T16:00:00.000Z')]) {
      expect(logicalDateCN(d)).toBe(beijingDayKey(d));
    }
  });

  it('日边界落在北京 0 点，不是 UTC 0 点', () => {
    // 北京 2026-08-19 00:00 = UTC 2026-08-18 16:00
    expect(beijingStartOfDay(EARLY).toISOString()).toBe('2026-08-18T16:00:00.000Z');
    expect(beijingEndOfDay(EARLY).toISOString()).toBe('2026-08-19T16:00:00.000Z');
    // 边界自身归属当日（左闭）
    const edge = new Date('2026-08-18T16:00:00.000Z');
    expect(beijingDayKey(edge)).toBe('2026-08-19');
    expect(beijingStartOfDay(edge).getTime()).toBe(edge.getTime());
  });

  it('月边界同理，且 12 月能正确跨年', () => {
    expect(beijingStartOfMonth(EARLY).toISOString()).toBe('2026-07-31T16:00:00.000Z');
    expect(beijingEndOfMonth(EARLY).toISOString()).toBe('2026-08-31T16:00:00.000Z');
    const dec = new Date('2026-12-20T00:00:00.000Z');
    expect(beijingMonthKey(dec)).toBe('2026-12');
    expect(beijingEndOfMonth(dec).toISOString()).toBe('2026-12-31T16:00:00.000Z'); // = 2027-01-01 00:00 北京
  });

  it('beijingParts 给的是北京的墙上时间', () => {
    expect(beijingParts(EARLY)).toEqual({ year: 2026, month: 8, day: 19, hour: 7, minute: 30 });
    expect(beijingMinuteOfDay(EARLY)).toBe(7 * 60 + 30);
  });
});

describe('展示口径（fmt*）一律北京时间', () => {
  it('🔒 清晨的时刻不会被渲染成前一天', () => {
    expect(fmtDateFull(EARLY)).toContain('2026');
    expect(fmtDateFull(EARLY)).toMatch(/08.*19/); // 19 号，不是 18 号
    expect(fmtDate(EARLY)).toMatch(/08.*19/);
    expect(fmtDateLong(EARLY)).toBe('2026年8月19日');
    expect(fmtDateTime(EARLY)).toMatch(/07:30/);
    expect(fmtTime(EARLY)).toBe('07:30');
  });

  // ⚠️ 上面那条断言在**本机时区恰好是 +8** 时会自动变绿（缺了 timeZone 也照样输出 19 号），
  // 而生产容器跑 UTC —— 这正是「本地全绿、线上出错」的经典形状。所以再钉一条与本机时区无关的：
  // lib/format.ts 里每一个 Intl.DateTimeFormat 都必须显式带上 timeZone。
  // （改 process.env.TZ 起不到这个作用：模块级已经建好的 formatter 不会因此重新解析时区。）
  it('🔒 lib/format.ts 里没有一个 formatter 漏掉 timeZone', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'lib', 'format.ts'), 'utf8');
    const formatters = [...src.matchAll(/new Intl\.DateTimeFormat\(([\s\S]*?)\)\;/g)].map((m) => m[1]);
    expect(formatters.length).toBeGreaterThanOrEqual(5); // 守卫本身不许因为改名而静默失效
    expect(formatters.filter((f) => !f.includes('timeZone: BEIJING_TZ'))).toEqual([]);
  });

  it('空值与非法值给「—」，不给 Invalid Date', () => {
    for (const bad of [null, undefined, '', 'not-a-date']) {
      expect(fmtDate(bad as never)).toBe('—');
      expect(fmtDateTime(bad as never)).toBe('—');
    }
  });
});

describe('🔒 没有人再按「运行环境本地时区」渲染日期', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const DIRS = ['app', 'components', 'lib'];

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  // 注释里会引用错误写法讲坑（本文件头上就有），扫源码前必须先把注释剥掉，
  // 否则守卫会被自己的说明骗（这个仓库栽过不止一次）。
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('toLocaleDateString / toLocaleTimeString 不再出现；toLocaleString 只用于数字千分位', () => {
    const bad: string[] = [];
    for (const dir of DIRS) {
      for (const f of walk(path.join(ROOT, dir))) {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        const rel = path.relative(ROOT, f);
        if (/toLocaleDateString|toLocaleTimeString/.test(src)) bad.push(`${rel}: toLocaleDateString/TimeString`);
        // 日期版 toLocaleString 一定带 locale 参数（'zh-CN' 等）；数字千分位是无参调用
        if (/toLocaleString\(\s*['"]/.test(src)) bad.push(`${rel}: toLocaleString(locale)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('日期展示不许用 toISOString().slice 切日（那是 UTC 日）', () => {
    const bad: string[] = [];
    for (const dir of DIRS) {
      for (const f of walk(path.join(ROOT, dir))) {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        if (/toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/.test(src)) bad.push(path.relative(ROOT, f));
      }
    }
    // 允许的例外：导出文件名里的日期戳（不是业务日期）——若要新增必须在这里写明理由
    expect(bad).toEqual([]);
  });
});

// ── 配额窗口与它对外承诺的「0 点」是同一个 0 点 ─────────────────────────────
//
// 【被守的是什么】三处文案写死「明日 0 点重置 / 每日 0 点重置」。窗口此前按容器本地时区
// （生产 = UTC）划，实际重置点是北京时间**早上 8 点**：用户 22 点被拦，零点半回来还是拦着。
// 这种偏差没有任何报错，只有用户自己发现——所以文案与窗口必须由测试绑在一起。
describe('🔒 日额度「0 点重置」= 北京 0 点', () => {
  const ROOT = path.resolve(__dirname, '..', '..');

  it('quota 的日/月边界取自 lib/beijing，没有 setHours / getFullYear 这类本地时区写法', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'quota.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).toMatch(/beijingStartOfDay\(\)/);
    expect(src).toMatch(/beijingEndOfDay\(\)/);
    expect(src).toMatch(/beijingStartOfMonth\(\)/);
    expect(src).toMatch(/beijingEndOfMonth\(\)/);
    expect(src).toMatch(/beijingDayKey\(\)/);
    expect(src).toMatch(/beijingMonthKey\(\)/);
    // 本地时区写法一个都不许留（留一个就够让种子与键指向不同的两天）
    expect(src).not.toMatch(/setHours\(/);
    expect(src).not.toMatch(/new Date\(\)\.get(FullYear|Month|Date)\(/);
  });

  it('承诺「0 点重置」的文案确实存在，且窗口正好在北京 0 点翻页', () => {
    const quotaSrc = fs.readFileSync(path.join(ROOT, 'lib', 'quota.ts'), 'utf8');
    expect(quotaSrc).toContain('明日 0 点重置'); // 文案没了就该重新审视这条守卫
    // 北京 23:59 与次日 00:01 必须落在不同的日桶里
    const before = new Date('2026-08-18T15:59:00.000Z'); // 北京 23:59
    const after = new Date('2026-08-18T16:01:00.000Z'); // 北京次日 00:01
    expect(beijingDayKey(before)).toBe('2026-08-18');
    expect(beijingDayKey(after)).toBe('2026-08-19');
    // 而按 UTC 划的话这两个时刻是同一天——正是修掉的那个错
    expect(before.toISOString().slice(0, 10)).toBe(after.toISOString().slice(0, 10));
  });
});
