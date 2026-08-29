// 任意站点采集配方的执行器（2026-08-29）。
//
// 【它和 content/ 里那些解析器的区别】那些是**逐平台手写**的，知道抖音的粉丝数长什么样；
// 这个什么都不知道——它只按服务端下发的 rules（选择器 + 文本锚点）取值，
// 站点由用户自己指定。所以它必须做到两件事：
//   ① 取不到就如实说取不到，绝不猜（猜出来的数会污染库，而且看不出是猜的）
//   ② 取不到时把**页面结构骨架**传回去，让服务端学新规则——这就是「进化」那一环
//
// 【为什么由 chrome.scripting 动态注入，而不是写进 manifest 的 content_scripts】
// manifest 里的匹配规则是**安装时固定**的，写不了「用户以后会指定的任意站点」。
// 动态注入配合 optional_host_permissions，才能做到「你说抓哪个站，就只申请那个站」。
(() => {
  const MAX_DEPTH = 12;
  const MAX_NODES = 1500;

  /** 文本形状：数字→NUM、长中文→CJK。与服务端 textShape 同一口径，不含真实内容。 */
  function shape(s) {
    const t = String(s || '').trim().slice(0, 40);
    if (!t) return '';
    if (/^[\d.,%万千亿]+$/.test(t)) return 'NUM';
    if (/[一-龥]{4,}/.test(t)) return 'CJK';
    return t;
  }

  /** 页面结构骨架：标签、类名、属性名、文本形状。**不含正文、昵称、链接、图片**。 */
  function skeleton(node, depth = 0, budget = { n: 0 }) {
    if (!node || depth > MAX_DEPTH || budget.n > MAX_NODES) return null;
    if (node.nodeType !== 1) return null;
    budget.n += 1;
    const el = node;
    const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => shape(c.textContent)).filter(Boolean);
    const kids = [];
    for (const c of el.children) {
      const k = skeleton(c, depth + 1, budget);
      if (k) kids.push(k);
      if (budget.n > MAX_NODES) break;
    }
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).slice(0, 4) : [],
      attrs: [...el.attributes].map((a) => a.name).filter((n) => n !== 'style').slice(0, 8),
      text: own.slice(0, 3),
      children: kids,
    };
  }

  /** 按一条规则取值。选择器优先，取不到再用文本锚点找相邻文本。 */
  function pick(rule) {
    for (const sel of rule.selectors || []) {
      try {
        const el = document.querySelector(sel);
        const v = el && el.textContent && el.textContent.trim();
        if (v) return v.slice(0, 200);
      } catch { /* 选择器写坏了就试下一个，不让整次抓取挂掉 */ }
    }
    // 锚点法：找到那段固定文字，取它**紧邻**的文本。
    // 【为什么限定紧邻而不是全局搜】抖音「关注 178 / 粉丝 328.3万」三个数字挨着，
    // 全局搜「粉丝」再取第一个数字，会取到关注数——这个事故真发生过。
    for (const anchor of rule.anchors || []) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!n.textContent || !n.textContent.includes(anchor)) continue;
        const host = n.parentElement;
        if (!host) continue;
        const near = [host.nextElementSibling, host.previousElementSibling, host.parentElement]
          .filter(Boolean)
          .map((e) => (e.textContent || '').replace(anchor, '').trim())
          .find((t) => t && t.length < 60);
        if (near) return near.slice(0, 200);
      }
    }
    return null;
  }

  const recipe = window.__beaconRecipe;
  if (!recipe) return { ok: false, error: '没有配方' };

  // 还没学会 / 坏了 → 交骨架去学，不硬抓
  if (recipe.status !== 'active' || !Array.isArray(recipe.rules) || recipe.rules.length === 0) {
    return { ok: true, mode: 'learn', skeleton: skeleton(document.body) };
  }

  const values = {};
  let got = 0;
  for (const rule of recipe.rules) {
    const v = pick(rule);
    if (v) { values[rule.key] = v; got += 1; }
  }
  // 一个都没取到 = 站点改版了。连骨架一起传回去，服务端据此重学（这就是「进化」）
  if (got === 0) return { ok: false, mode: 'stale', skeleton: skeleton(document.body) };
  return { ok: true, mode: 'scrape', values, got, want: recipe.rules.length };
})();
