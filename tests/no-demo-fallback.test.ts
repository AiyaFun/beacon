import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 功能真相层（2026-09-11 P0-1）：**没有真实数据就渲染示例数据** 是一种最糟的假绿——
// 页面既不报错也不空白，用户看到的是一个正在忙碌的假系统。
// 2026-09-11 之前 /runs 没数据时渲染四条写死的运行（含编造的耗时与只弹提示的按钮），
// /workflows 页顶画着三条写死的定时与三个「可用」智能体，开关一拨只改本地 state。
//
// 这条守卫钉住三件事：
//   ① 应用页面源码里不许再有「rows 空就用示例常量」这种回退；
//   ② 不许有 alert('已…') 这种「按钮点了只弹一句、什么都不做」的假动作；
//   ③ 判据本身得认得出这两种形状（判据坏了会静默全过）。

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app/(app)');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 剥掉注释：说明文字里写「以前这里有 DEMO_ROWS」不该让守卫变红 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** 形状①：`x.length > 0 ? x : SOME_CONST` / `x.length ? x : SOME_CONST` / 全大写的 DEMO_/DEFAULT_ 数据常量当回退 */
const FALLBACK = /\.length\s*(?:>\s*0\s*)?\?\s*\w+\s*:\s*(?:DEMO|DEFAULT|SAMPLE|MOCK)_[A-Z_]+/;
/** 形状①'：声明一个示例数据常量并在 JSX 里直接 .map 渲染 */
const DEMO_CONST_RENDER = /\b(?:DEMO|SAMPLE|MOCK)_(?:ROWS|ITEMS|DATA|AGENTS|ROUTINES)\b[^\n]*\.map\(/;
/** 形状②：alert('已…') —— 说「已经做了」而其实什么都没做 */
const FAKE_ALERT = /alert\(\s*['"`]已/;

describe('应用页面不许用示例数据冒充真实数据', () => {
  const files = walk(APP);

  it('扫到了页面源码（扫不到会静默全过）', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('没有「数据为空就回退到示例常量」的写法', () => {
    const hits = files.filter((f) => {
      const src = strip(fs.readFileSync(f, 'utf8'));
      return FALLBACK.test(src) || DEMO_CONST_RENDER.test(src);
    }).map((f) => path.relative(ROOT, f));
    expect(hits, `这些页面在没数据时渲染示例数据：${hits.join('、')}`).toEqual([]);
  });

  it('没有「点了只弹一句已完成、什么都不做」的按钮', () => {
    const hits = files.filter((f) => FAKE_ALERT.test(strip(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f));
    expect(hits, `这些页面有假动作按钮：${hits.join('、')}`).toEqual([]);
  });

  it('判据本身认得出这两种形状（判据坏了也会静默全过）', () => {
    expect(FALLBACK.test('const effectiveRows = rows.length > 0 ? rows : DEMO_ROWS;')).toBe(true);
    expect(FALLBACK.test('const list = items.length ? items : DEFAULT_ROUTINES;')).toBe(true);
    expect(DEMO_CONST_RENDER.test('{DEMO_AGENTS.map((a) => (')).toBe(true);
    expect(FAKE_ALERT.test("onClick={() => alert('已确认继续推进')}")).toBe(true);
    // 正常写法不误伤
    expect(FALLBACK.test('const rows = data.length > 0 ? data : [];')).toBe(false);
    expect(FAKE_ALERT.test("alert(isEn ? 'Export started' : '正在准备导出')")).toBe(false);
  });
});
