import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 插件消息通道的「写了没接」守卫（2026-08-30）。
//
// ── 为什么需要它 ──
// 服务端那侧早就有 tests/geo/wired-up.test.ts 在盯「导出了函数却没人调」。
// 插件这侧一直没有对应的东西，而它的形状更隐蔽：sw.js 里写好一个 `msg.type === 'x'`
// 的接收方，**只要没有任何界面发这条消息，那个能力就不存在**——
// 不报错、不变红，甚至代码读起来一切正常。
//
// 2026-08-30 真的踩到了：「任意站点采集配方」的插件那一半
//（beacon-recipes-refresh / beacon-recipe-run / beacon-recipe-grant 三条消息、
// runRecipeOnTab / refreshScrapeRecipes / requestSiteGrant 四个函数、tools/recipe-run.js）
// 全部写好了，而 sidepanel.js / popup.js / options.js **一个字都没提配方**。
// 记录里这个功能写着「已上线」，实际用户根本点不到。

const ROOT = process.cwd();
const SW = readFileSync(join(ROOT, 'extension/sw.js'), 'utf8');

/** 插件里除 sw.js 之外所有可能发消息的地方（含网页端的桥）。 */
function senderFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(join(ROOT, d))) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const rel = `${d}/${n}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(js|html|ts|tsx)$/.test(n) && !n.endsWith('sw.js') && !n.includes('.test.')) out.push(rel);
    }
  };
  for (const d of ['extension', 'lib', 'app', 'components']) walk(d);
  return out;
}

/**
 * 明知故犯的例外，每条都要写清为什么。
 * 【为什么要理由】没有理由的豁免清单会变成垃圾桶：谁遇到红就往里加一行。
 */
const EXEMPT: Record<string, string> = {
  'parser:refresh':
    '手动触发用。底下的 refreshParserRules 挂在 beacon-daily 闹钟上（sw.js:1624）真的在跑，'
    + '死的只是这条手动通道，能力本身是通的。',
  'beacon-create-account':
    '手动触发用。底下的 createAccount 在回填链路里有两处真实调用（sw.js:504 / 793），'
    + '死的只是这条手动通道，能力本身是通的。',
};

describe('sw.js 的每条消息都要有人发', () => {
  const types = [...new Set([
    ...[...SW.matchAll(/msg\?\.type === '([^']+)'/g)].map((m) => m[1]),
    ...[...SW.matchAll(/msg\.type === '([^']+)'/g)].map((m) => m[1]),
  ])].sort();

  const corpus = senderFiles().map((f) => readFileSync(join(ROOT, f), 'utf8'));

  it('确实扫到了消息类型（守卫自己不能空转）', () => {
    expect(types.length).toBeGreaterThan(20);
    expect(corpus.length).toBeGreaterThan(20);
  });

  it.each(types)('%s 有发送方', (t) => {
    if (EXEMPT[t]) {
      expect(EXEMPT[t].length, `${t} 的豁免理由不能是空的`).toBeGreaterThan(20);
      return;
    }
    const n = corpus.reduce((acc, src) => acc + src.split(`'${t}'`).length - 1 + src.split(`"${t}"`).length - 1, 0);
    expect(
      n,
      `sw.js 里写了 ${t} 的接收方，但**没有任何界面发这条消息**。\n`
      + '这就是插件版的「写了没接」：不报错、不变红，但那个能力用户根本点不到。\n'
      + '要么给它接上入口，要么把接收方删掉，要么在本文件的 EXEMPT 里写明理由。',
    ).toBeGreaterThan(0);
  });

  it('🔒 豁免清单里不许有已经不存在的条目（否则会慢慢变成垃圾桶）', () => {
    for (const t of Object.keys(EXEMPT)) {
      expect(types, `EXEMPT 里的 ${t} 已经不在 sw.js 里了，请删掉这条豁免`).toContain(t);
    }
  });
});

// ── 采集配方那条链路真的通了（2026-08-30 补的入口）─────────────────────────
describe('任意站点采集配方：插件这一半真的有入口', () => {
  const panelJs = readFileSync(join(ROOT, 'extension/sidepanel.js'), 'utf8');
  const panelHtml = readFileSync(join(ROOT, 'extension/sidepanel.html'), 'utf8');

  it('🔒 界面上有按钮，且按钮真的发那条消息', () => {
    expect(panelHtml, '侧栏里没有这个按钮').toContain('id="spRecipe"');
    expect(panelJs, '按钮没绑点击').toContain("getElementById('spRecipe')");
    expect(panelJs, '点了不发采集消息').toContain("type: 'beacon-recipe-run'");
  });

  it('🔒 授权在侧栏的 click 里直接调，不转发给 SW', () => {
    // chrome.permissions.request 必须在**用户手势**里调，而 MV3 里 SW 的 onMessage
    // 处理器不是手势上下文——转发过去会被 Chrome 拒掉。原来 sw.js 里那条
    // beacon-recipe-grant 的注释以为转发能保住手势，不成立。
    expect(panelJs, '授权没在侧栏直接调').toContain('chrome.permissions.request(');
    expect(SW, 'sw.js 里又出现了代为申请授权的转发（保不住手势）').not.toContain('chrome.permissions.request(');
  });

  it('🔒 只申请单个站点，绝不申请 <all_urls>', () => {
    // 装机提示会变成「读取和更改你在所有网站上的数据」——这条红线在 sw.js 开头写着
    expect(panelJs).toMatch(/origins: \[`\$\{[\w.]+\}\/\*`\]/);
    expect(panelJs).not.toContain('<all_urls>');
  });

  it('🔒 成功抓取不许被报成「结构变了」（mode 在两种情况下都有值）', () => {
    // runRecipeOnTab 成功时返回 mode:'scrape'，learn/stale 时返回 mode:'learn'|'stale'。
    // 只判「有没有 mode」会把成功当成失败报给用户——写这段时真踩了一次。
    expect(panelJs, "又变回只判 r.mode 了").toContain("r.mode === 'learn' || r.mode === 'stale'");
  });

  it('🔒 如实说抓到几个字段（只说「成功」的话，1 个和 11 个长得一样）', () => {
    expect(panelJs).toContain('r.got');
    expect(SW, 'sw.js 没把行数带回来，界面上那句就永远印不出行数').toContain('rows: (out.rows || []).length');
  });

  it('没匹配到配方时按钮不露出（凭空多个点不动的按钮更糟）', () => {
    expect(panelJs).toContain("spRecipeBtn.style.display = 'none'");
    expect(panelHtml, '按钮默认要是隐藏的').toMatch(/id="spRecipe"[^>]*display:none/);
  });
});
