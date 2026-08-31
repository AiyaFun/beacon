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
    // role 与 data-testid 的**值**：类名被混淆成随机哈希时，它们是仅剩的稳定锚点。
    // 服务端 vetRole / vetTestId 会再卡一道（role 只认标准词表、testid 只认标识符形状）
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test')
      || el.getAttribute('data-qa') || el.getAttribute('data-cy') || '';
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).slice(0, 4) : [],
      attrs: [...el.attributes].map((a) => a.name).filter((n) => n !== 'style').slice(0, 8),
      role: el.getAttribute('role') || '',
      tid: tid,
      // 【字段名必须是 shape，且必须是字符串】服务端 sanitizeSkeleton 只认
      // shape:string / text:string / text:string[]。这里原来是 `text: [...]`，
      // 在服务端补上数组兼容之前，**整层文本被静默丢掉**：模型看不到任何文字，
      // 永远提不出文本锚点，学出来的规则只剩改版最先碎的类名。
      shape: own.slice(0, 3).join(' '),
      children: kids,
    };
  }

  /**
   * 按一条规则在 root 下取值。选择器优先，取不到再用文本锚点找相邻文本。
   *
   * 【root 就是行边界】给了 rowSelector 时，每一行只在自己那棵子树里找——
   * 不这样的话，第二行取不到就会退到全局，把第一行的值当成自己的（跨条目串数）。
   */
  function pick(rule, root) {
    for (const sel of rule.selectors || []) {
      try {
        const el = root.querySelector(sel);
        const v = el && el.textContent && el.textContent.trim();
        if (v) return v.slice(0, 200);
      } catch { /* 选择器写坏了就试下一个，不让整次抓取挂掉 */ }
    }
    // 锚点法：找到那段固定文字，取它**紧邻**的文本。
    // 【为什么限定紧邻而不是全局搜】抖音「关注 178 / 粉丝 328.3万」三个数字挨着，
    // 全局搜「粉丝」再取第一个数字，会取到关注数——这个事故真发生过。
    for (const anchor of rule.anchors || []) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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

  const opts = recipe.options || {};
  const values = {};
  let got = 0;
  for (const rule of recipe.rules) {
    const v = pick(rule, document.body);
    if (v) { values[rule.key] = v; got += 1; }
  }

  // 列表行。上限 50——与服务端硬上限同一个数（超一条整批被打回那个）
  const rows = [];
  if (opts.rowSelector) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(opts.rowSelector)]; } catch { nodes = []; }
    for (const node of nodes.slice(0, 50)) {
      const row = {};
      for (const rule of recipe.rules) { const v = pick(rule, node); if (v) row[rule.key] = v; }
      // 空行不收：一行一个字段都没取到，说明 rowSelector 指到了容器而不是行
      if (Object.keys(row).length > 0) rows.push(row);
    }
  }

  // 【有行就算抓到了】纯列表页往往没有任何页面级标量（没有「总数」这种东西），
  // 只看 got 会把一次满载的采集判成「站点改版了」，然后拿去重学——越学越差
  if (got === 0 && rows.length === 0) return { ok: false, mode: 'stale', skeleton: skeleton(document.body) };
  return { ok: true, mode: 'scrape', values, rows, got, want: recipe.rules.length };
})();
