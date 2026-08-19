import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 「按钮亮着、点下去才说不支持」——2026-08-13 文案审计查出的两处同形问题。
//
// 这个仓库自己立过规矩（sidebar.js 的 RAIL_ACTIONS 注释）：**不满足条件时置灰而不是隐藏**。
// 置灰的前提是判据要对；判据比点击时那道闸宽，就变成「引着用户点一次无效操作」，
// 比直接隐藏更糟——用户会以为是功能坏了。
//
// 两处的坏法不同，但都出在「判据比实际支持范围宽」：
//   · 竖条的「加为竞对」：判据用兜底解析的 platform，而兜底对**任何**未知域名都返回
//     'bilibili'（common.js 的默认值），于是在知乎、任意新闻站上都不置灰；
//   · SidePanel 的「补齐前 20 条详情」：判据写成 `url.includes(host) && url.includes('/')`，
//     任何 URL 都含 '/'，等于只认域名——在 youtube.com/watch、x.com/home 上都会露出。

const SIDEBAR = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.js'), 'utf8');
const PANEL = readFileSync(resolve(process.cwd(), 'extension/sidepanel.js'), 'utf8');

// 否定断言（「不许再出现某写法」）必须扫**剥掉注释**的源码：
// 讲清楚一个坑就要原样引用那段错误写法，不剥的话「解释这个坑」这件事本身会把断言打红。
// 这个仓库已经在 work-selector-sync.test.ts 上栽过一次，同一形状。
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const PANEL_CODE = stripComments(PANEL);

/**
 * 从源码里抠出一个正则数组常量并**真求值**（不是字符串匹配——写错的正则会当场炸）。
 *
 * 数组元素可能是正则字面量，也可能是引用同文件里已定义的常量
 *（sidepanel.js 的 DETAIL_HOME_PAGES 就是复用 DY_SELF_PROFILE 那批，不再抄一份）。
 * 所以先把文件里所有「const 名 = 正则字面量;」一并求值出来当上下文，数组里引用得到。
 * 漏抄一个名字会直接 ReferenceError 变红，不会静默退化成空数组。
 */
function evalRegexList(src: string, name: string): RegExp[] {
  // 收尾的 `];` 可能带缩进（sidebar.js 里这两个常量在 IIFE 内），所以要允许前导空白
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\s*\\];`).exec(src);
  if (!m) throw new Error(`找不到 ${name} —— 改了名字就要改这个测试`);
  const body = m[1].replace(/^\s*\/\/.*$/gm, '');
  // 单行与跨行两种写法都收（X_SELF_PAGE 是 `const X =\n  /.../;`）
  const decls = Array.from(
    src.matchAll(/const (\w+) =\s*(\/(?:\\.|\[[^\]]*\]|[^/\n])+\/[gimsuy]*);/g),
    (d) => `const ${d[1]} = ${d[2]};`,
  ).join('\n');
  const ctx: Record<string, unknown> = {};
  vm.createContext(ctx);
  return vm.runInContext(`${decls}\n;[${body}]`, ctx) as RegExp[];
}

describe('竖条「加为竞对」的置灰判据要与点击时那道闸一致', () => {
  it('🔒 判据就是 isCompetitorPage()，不掺兜底解析出来的 platform', () => {
    const m = /competitor: ([^\n,]+),/.exec(SIDEBAR);
    expect(m, 'refreshRailState 里找不到 competitor 判据').toBeTruthy();
    expect(m![1].trim()).toBe('isCompetitorPage()');
  });

  it('🔒 点击时的闸也还是它（两处一旦分叉就会再次出现「亮着但点不动」）', () => {
    expect(SIDEBAR).toMatch(/if \(!isCompetitorPage\(\)\) \{/);
  });

  const HOSTS = evalRegexList(SIDEBAR, 'COMPETITOR_HOSTS');
  const hit = (u: string) => HOSTS.some((re) => re.test(u));

  it.each([
    ['https://space.bilibili.com/123', true],
    ['https://www.douyin.com/user/abc', true],
    ['https://www.tiktok.com/@someone', true],
    ['https://www.zhihu.com/people/someone', false],
    ['https://news.example.com/2026/08/13', false],
    ['https://mp.weixin.qq.com/s/abc', false],
  ])('%s → 竞对页判定 %s', (url, want) => {
    expect(hit(url)).toBe(want);
  });
});

describe('SidePanel「补齐前 20 条详情」只在主页/空间页露出', () => {
  const PAGES = evalRegexList(PANEL, 'DETAIL_HOME_PAGES');
  const fit = (u: string) => PAGES.some((re) => re.test(u));

  it.each([
    // 主页/空间页 —— 该露
    ['https://www.douyin.com/user/MS4wLjABAAAA', true],
    ['https://space.bilibili.com/946974', true],
    ['https://www.xiaohongshu.com/user/profile/5f3a1b2c', true],
    ['https://www.youtube.com/@someone', true],
    ['https://www.youtube.com/channel/UCabc123', true],
    ['https://x.com/someone', true],
    // 🔒 作品页与功能页 —— 不该露（此前这五条全都会露）
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', false],
    ['https://x.com/home', false],
    ['https://x.com/explore', false],
    ['https://www.bilibili.com/video/BV1xx411c7mD', false],
    ['https://www.douyin.com/video/7065264218437717285', false],
    ['https://www.xiaohongshu.com/explore/65a1b2c3', false],
  ])('%s → 露出 %s', (url, want) => {
    expect(fit(url)).toBe(want);
  });

  // ⚠️ 上面 it.each 验的是**正则对不对**，不验**它有没有被用上**。
  // 这两件事必须分开钉：mutation 验过，把 fit 换成 `['douyin.com',…].some(h => url.includes(h))`
  // 之后正则那批断言照样全绿——因为没人再调它们了。
  it('🔒 露出判定真的走 DETAIL_HOME_PAGES（不是另起一套只认域名的判断）', () => {
    expect(PANEL_CODE).toMatch(/const fit = DETAIL_HOME_PAGES\.some\(\(re\) => re\.test\(url\)\)/);
  });

  it('🔒 判据不许退回「只认域名」（path 写成 "/" 等于任何 URL 都命中）', () => {
    expect(PANEL_CODE).not.toMatch(/path:\s*'\/'/);
    expect(PANEL_CODE).not.toMatch(/url\.includes\(p\.path\)/);
    // 直接拿裸域名串做包含判断，就是这个坑的另一种写法
    expect(PANEL_CODE).not.toMatch(/url\.includes\('(?:douyin|bilibili|xiaohongshu|youtube|x)\.com'\)/);
  });
});

describe('SidePanel 的「一键全部采集」必须有反馈', () => {
  it('🔒 竞对批量的两条进度消息都被接住了（此前只接了自有那半边）', () => {
    expect(PANEL).toMatch(/m\?\.type === 'batch-progress'/);
    expect(PANEL).toMatch(/m\?\.type === 'batch-done'/);
  });

  it('🔒 状态位 spBatchMsg 真的被写（html 里预留了它，此前从未被引用）', () => {
    expect(PANEL).toMatch(/getElementById\('spBatchMsg'\)/);
    expect(PANEL).toMatch(/batchMsg\.textContent/);
  });

  it('🔒 监听器不许再拿自有那半边的元素当整体前置条件', () => {
    // 原来第一行是 `const msg = getElementById('spSelfMsg'); if (!msg) return;`
    // ——只要那个元素不在，竞对分支永远轮不到。
    expect(PANEL_CODE).not.toMatch(/const msg = document\.getElementById\('spSelfMsg'\);\s*\n\s*if \(!msg\) return;/);
  });

  it('被上限/节流拦下的原因要显示出来，不能静默丢掉', () => {
    expect(PANEL).toMatch(/m\.notes/);
  });
});
