import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 执行可视化（0.9.10，「看着它干活」）。
//
// 【守的三条硬边界，与隐私政策逐字对应】
// ① 只跟着「用户当场点击」走：定时采集与后台派发**不看这个开关**，照旧全程后台
//   ——政策对那两条链路承诺的是「后台标签页」，开关不是改承诺的通道；
// ② 进度卡只在 SW 认过账的工作页上出现（live:query）：用户自己浏览触发的
//   「访问即采」绝不弹卡；
// ③ 可视化不许改变采集行为本身：前台工作页照样翻页深采（否则开了开关静默退化成只采首屏）。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('开关与默认值', () => {
  it('默认关：options 用 === true 判（只有显式存过 true 才算开）', () => {
    const js = read('extension/options.js');
    expect(js).toMatch(/liveViewEl\.checked = s\.liveView === true/);
    expect(js).toMatch(/chrome\.storage\.sync\.set\(\{ liveView: liveViewEl\.checked \}\)/);
    expect(read('extension/options.html')).toContain('id="liveView"');
  });

  it('sw.js 的读取同款：liveView === true 才算开', () => {
    expect(read('extension/sw.js')).toMatch(/liveView === true/);
  });
});

describe('边界①：只作用于当场点击的那两轮', () => {
  it('batchCollect 的 live 位必须含 opts.interactive === true（定时/派发调进来没有 interactive）', () => {
    const sw = read('extension/sw.js');
    expect(sw).toMatch(/const live = opts\.interactive === true && \(await liveViewOn\(\)\)/);
    // 工作页的前台与否只由 live 决定——写死 active: true 就是把定时轮也顶到前台
    expect(sw).toMatch(/chrome\.tabs\.create\(\{ url: c\.url, active: live \}\)/);
  });

  it('定时与派发的调用点都不带 interactive（带了 = 半夜弹前台页）', () => {
    const sw = read('extension/sw.js');
    // 定时轮：runScheduledCollect 里的调用
    const scheduled = sw.slice(sw.indexOf('async function runScheduledCollect'), sw.indexOf('async function runScheduledCollect') + 2000);
    expect(scheduled).toMatch(/batchCollect\(null\)/);
    expect(scheduled).not.toContain('interactive');
    // 派发轮：BrowserTask 执行点
    expect(sw).toMatch(/batchCollect\(null, \{ onlyCompetitorId: task\.payload\.competitorId, limit: task\.payload\.limit \}\)/);
  });

  it('用户当场点击的入口才带 interactive: true', () => {
    expect(read('extension/sw.js')).toMatch(/batchCollect\(_sender\?\.tab\?\.id, \{ interactive: true \}\)/);
  });
});

describe('边界②：进度卡只在 SW 认过账的页上出现', () => {
  it('内容脚本先问 live:query，SW 按 liveTabs 应答；访问即采那条路不登记 liveTabs', () => {
    const common = read('extension/content/common.js');
    expect(common).toMatch(/sendMessage\(\{ type: 'live:query' \}\)/);
    expect(common).toMatch(/if \(!r \|\| r\.live !== true\) return/);
    const sw = read('extension/sw.js');
    expect(sw).toMatch(/liveTabs\.get\(tabId\)/);
    // 登记只发生在两个批量循环里（liveTabs.set 恰好两处），访问即采完全不碰它
    expect(sw.match(/liveTabs\.set\(/g)?.length).toBe(2);
  });

  it('进度卡不拦点击（pointer-events:none，政策原文写了「不拦截任何点击」）', () => {
    expect(read('extension/content/common.js')).toContain("'pointer-events:none'");
  });

  it('可视化不注册第二个 onMessage 监听器（单测桩只保留最后一个监听，会把采集主通道顶掉）', () => {
    const common = read('extension/content/common.js');
    // 收尾状态由回传处就地点亮，不走 SW 发消息回来那条路
    expect(common).not.toContain("'live:done'");
    expect(common).toMatch(/beaconLiveDone\(!!r\?\.ok\)/);
    // 整个 common.js 只许有主监听这一个 addListener
    expect(common.match(/chrome\.runtime\.onMessage\.addListener/g)?.length).toBe(1);
  });
});

describe('边界③：可视化不改变采集行为', () => {
  it('前台工作页照样翻页深采：判据是 document.hidden || beaconLiveCard（少了后半句=开了开关只采首屏）', () => {
    expect(read('extension/content/common.js')).toMatch(/if \(document\.hidden \|\| beaconLiveCard\) \{/);
  });
});

describe('承诺与代码对得上', () => {
  it('三份隐私政策都写了：默认关 / 只当场点击 / 定时与派发仍全程后台 / 不拦点击', () => {
    for (const p of ['extension/store/privacy.md', 'app/(public)/legal/privacy/page.tsx', 'scripts/privacy-page.ts']) {
      const s = read(p);
      expect(s, `${p} 要有可视化披露`).toContain('执行可视化');
      expect(s, `${p} 要写默认关`).toContain('默认关');
      expect(s, `${p} 要写定时不受影响`).toContain('仍全程后台');
      expect(s, `${p} 要写不拦点击`).toContain('不拦截任何点击');
    }
  });

  it('插件版本已抬到 0.9.10+', () => {
    const manifest = JSON.parse(read('extension/manifest.json')) as { version: string };
    const [maj, min, pat] = manifest.version.split('.').map(Number);
    expect(maj * 10000 + min * 100 + pat).toBeGreaterThanOrEqual(910);
  });
});
