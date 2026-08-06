// 创作者后台 DOM 探针 —— 在后台页的 DevTools 控制台里粘贴运行，只读，不点击、不发请求。
//
// 用途：self-backend.js 的自检只会报「行内没有任何 <a> 链接」，此时它给不出任何可用线索
// （它只扫 href/data-href/data-url/data-link/data-src 五个属性，SPA 用 JS 跳转时一个都不存在）。
// 这个探针补上那一步：自动认出真正的重复行，把行上**所有**属性、封面图 URL、
// 以及框架内部状态（Vue/React）里长得像 ID 的字段全部打印出来。
//
// 关键区别（决定修法，输出里会分开标注）：
//   [DOM]  = 属性/图片 URL 里能拿到 → 插件（隔离世界）直接可用，改选择器即可。
//   [框架] = 只存在于 Vue/React 内部状态 → 插件在隔离世界读不到，需要 MAIN world 注入。
// 控制台运行在 MAIN world，所以能看到框架状态；插件内容脚本默认看不到。

(() => {
  const L = [];
  const P = (...a) => L.push(a.join(' '));
  const cut = (s, n = 110) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };

  P('════ 烽火台后台探针 ════');
  P('URL     ', location.href);
  P('hostname', location.hostname, '| pathname', location.pathname);

  // ── ① 插件当前认出来的东西（对照用） ──────────────────────────────
  // 与 self-backend.js 的 beaconDataRows 保持一致（含驼峰变体）。
  // 注意插件那边还会再筛掉：隐藏节点、导航区、插件自己的 UI，以及 arrow 这类子串误配，
  // 所以这里匹配到的个数通常**多于**自检报的行数。
  const EXT_ROW_SEL = 'tr, [role="row"], [class*="row"], [class*="item"], [class*="Row"], [class*="Item"]';
  const extRows = [...document.querySelectorAll(EXT_ROW_SEL)];
  P('');
  P('── ① 插件现在的行选择器 ──');
  P('  ' + EXT_ROW_SEL);
  P('  匹配到', extRows.length, '个元素（自检报的就是这个数）');

  // ── ② 自动认出真正的「重复行」 ────────────────────────────────────
  // 数据行的特征：同一个父节点下、标签+class 签名相同、重复 ≥4 次、行内文本含 ≥2 个数字。
  // （单元格通常只含 1 个数字，靠这一条把行和单元格分开。）
  const numCount = (el) => (String(el.textContent || '').match(/\d[\d.,]*\s*[%万亿]?/g) || []).length;
  const groups = new Map();
  for (const el of document.querySelectorAll('*')) {
    const p = el.parentElement;
    if (!p) continue;
    const sig = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '');
    const key = sig + ' ⟨under⟩ ' + p.tagName.toLowerCase() +
      (typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, sig, els: [] }));
    g.els.push(el);
  }
  const cands = [...groups.values()]
    .filter((g) => g.els.length >= 4)
    .map((g) => ({ ...g, rich: g.els.filter((e) => numCount(e) >= 2).length }))
    .filter((g) => g.rich >= 4)
    // 行 > 单元格：同样重复的前提下，优先取「含数字更多、文本更长」的那层
    .sort((a, b) => b.rich - a.rich || (b.els[0].textContent || '').length - (a.els[0].textContent || '').length)
    .slice(0, 3);

  P('');
  P('── ② 自动识别的候选数据行（前 3 组） ──');
  if (!cands.length) {
    P('  ⚠️ 没找到重复 ≥4 次且含 ≥2 个数字的结构。');
    P('     可能：列表还没加载完 / 是虚拟滚动只渲染了几行 / 数据在 canvas 或 iframe 里。');
    P('     请确认页面已完全显示出作品列表再重跑。');
    const ifr = [...document.querySelectorAll('iframe')];
    if (ifr.length) P('     ⓘ 本页有', ifr.length, '个 iframe：', ifr.map((f) => cut(f.src, 60)).join(' | '),
      '→ 数据可能在 iframe 内，需在 iframe 的上下文里重跑本探针（控制台左上角切换 frame）。');
  }

  // 框架内部状态里找 ID：跳过会拖出整棵树的指针字段
  const SKIP = new Set(['return', 'child', 'sibling', 'stateNode', 'alternate', '_owner', 'memoizedState',
    'dependencies', 'updateQueue', 'firstEffect', 'lastEffect', '$parent', '$root', '$children', '_vnode',
    'parent', 'subTree', 'ctx', 'appContext', 'component', 'el', 'children', 'scope', 'effect', 'provides']);
  // 键名像不像 ID。要认出 objectId / export_id / eid 这些真实写法，又不能把 valid / grid / uuid 当成 ID：
  // 靠「驼峰大小写边界」或「下划线」来区分——objectId 的 t→I 是边界，valid 的 l→i 不是。
  const idKeyLike = (k) =>
    /^id$/i.test(k) ||
    /_id$/i.test(k) ||
    /[a-z0-9](Id|ID)$/.test(k) ||
    /^(eid|sn|token|bvid|vid|mid|aid|cid)$/i.test(k) ||
    /(export|object|aweme|appmsg|nonce)/i.test(k);
  const idHunt = (obj, depth, seen, hits) => {
    if (!obj || typeof obj !== 'object' || depth > 4 || hits.length >= 30) return hits;
    if (seen.has(obj)) return hits;
    seen.add(obj);
    let keys = [];
    try { keys = Object.keys(obj); } catch { return hits; }
    for (const k of keys) {
      if (SKIP.has(k)) continue;
      let v;
      try { v = obj[k]; } catch { continue; }
      if (v == null) continue;
      const t = typeof v;
      if (t === 'string' || t === 'number') {
        const s = String(v);
        if (idKeyLike(k) && s.length >= 6 && s.length <= 140 && !/\s/.test(s)) {
          const line = k + ' = ' + cut(s, 70);
          if (!hits.includes(line)) hits.push(line);
        }
      } else if (t === 'object') {
        idHunt(v, depth + 1, seen, hits);
      }
    }
    return hits;
  };
  const frameworkState = (el) => {
    const out = [];
    for (const k of Object.keys(el)) {
      if (/^__(react|vue)/i.test(k) || k === '__vue__' || k === '_vnode') {
        let v; try { v = el[k]; } catch { continue; }
        out.push(...idHunt(v, 0, new Set(), []));
      }
    }
    return [...new Set(out)];
  };

  cands.forEach((g, gi) => {
    const row = g.els.find((e) => numCount(e) >= 2) || g.els[0];
    P('');
    P(`  ▸ 候选 ${gi + 1}：${g.key}`);
    P(`    重复 ${g.els.length} 次（其中 ${g.rich} 个含≥2数字）`);
    P('    行文本：', cut(row.textContent, 150));

    // [DOM] 全部属性（不只是那 5 个）
    const attrs = [];
    for (const el of [row, ...row.querySelectorAll('*')].slice(0, 400)) {
      for (const a of el.attributes || []) {
        if (/^(class|style)$/i.test(a.name)) continue;
        if (/^data-v-/.test(a.name)) continue; // Vue scoped-CSS 标记，无信息
        const v = a.value;
        if (!v || v === '#') continue;
        const line = a.name + '="' + cut(v, 80) + '"';
        if (!attrs.includes(line)) attrs.push(line);
        if (attrs.length >= 24) break;
      }
      if (attrs.length >= 24) break;
    }
    P('    [DOM] 行内全部属性：', attrs.length ? '\n        ' + attrs.join('\n        ') : '（一个都没有 → 纯 JS 跳转）');

    // [DOM] 图片 URL——封面链接里常常带着作品 ID
    const imgs = [];
    for (const im of row.querySelectorAll('img')) {
      const s = im.currentSrc || im.src || im.getAttribute('data-src') || '';
      if (s && !s.startsWith('data:') && !imgs.includes(s)) imgs.push(cut(s, 130));
      if (imgs.length >= 3) break;
    }
    if (imgs.length) P('    [DOM] 封面图 URL：\n        ' + imgs.join('\n        '));

    // [框架] Vue/React 内部状态
    let fw = frameworkState(row);
    if (!fw.length) {
      let p = row.parentElement, hop = 0;
      while (p && hop++ < 3 && !fw.length) { fw = frameworkState(p); p = p.parentElement; }
    }
    P('    [框架] Vue/React 状态里的 ID 字段：', fw.length ? '\n        ' + fw.slice(0, 12).join('\n        ') : '（没找到）');
  });

  // ── ③ 表头（列名别名校准用） ──────────────────────────────────────
  const heads = [...document.querySelectorAll('th, thead [class*="cell"], [role="columnheader"]')]
    .map((e) => String(e.textContent || '').replace(/\s+/g, '').trim()).filter(Boolean);
  P('');
  P('── ③ 表头 ──');
  P('  ', heads.length ? heads.join(' / ') : '（没有 th/columnheader；列名可能画在 div 里，看上面的行文本）');

  const text = L.join('\n');
  console.log(text);
  try { copy(text); console.log('%c✅ 已复制到剪贴板，直接粘给 Claude 即可', 'color:#16a34a;font-weight:bold'); } catch {}
  return '↑ 把上面这段整个复制给 Claude';
})();
