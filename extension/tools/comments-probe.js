// 评论区 DOM 探针 —— 在作品详情页的 DevTools 控制台里粘贴运行。只读：不点击、不滚动、不发请求。
//
// 用途：`content/comments.js` 里那套 PLATFORM_RULES 是**照文档和经验写的，没有一条经过真机校准**。
// 校准不了就上线的后果不是「采不到」，是采到**错的东西**——把昵称列当评论正文传上去，
// 或者把推荐位标题当提问入库。两道闸（validateSource / validateShape）会拦下大部分，
// 但闸拦下之后你只看到一句 `shared_prefix`，不知道该改哪个选择器。这个探针补的就是那一步。
//
// 输出分三段：
//   ① 现行选择器逐条命中情况（容器 / 条目 / 正文），未命中的直接列出来
//   ② 抽样正文 + 两道闸的判定——闸不过时告诉你是哪一条、被什么触发
//   ③ 自动兜底扫描：当现行容器全落空时，按「重复结构 + 文本长度分布」猜出候选容器，
//      并打印它们的稳定选择器，供你直接填回 PLATFORM_RULES
//
// 用法：
//   1. 打开一条**评论已经展开、屏幕上看得见评论**的作品页（探针不替你翻页，这是产品红线）
//   2. F12 → Console → 粘贴本文件全部内容 → 回车
//   3. 把输出整段复制回来
//
// ⚠️ 探针跑在 MAIN world（控制台），插件内容脚本跑在隔离世界。DOM 两边一致，
//    但页面 JS 变量（Vue/React 内部状态）只有探针看得见——所以**别用探针里看得到的框架状态去写选择器**，
//    插件那边读不到（同 backend-probe.js 顶部那条教训）。

(() => {
  const L = [];
  const P = (...a) => L.push(a.join(' '));
  const cut = (s, n = 60) => {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };

  // ── 与 content/comments.js 保持一字不差的副本（改那边记得改这边）──
  const MAX_COMMENTS = 200;
  const MIN_LEN = 5;
  const MAX_LEN = 60;
  const NOISE_PREFIX = /^[\s\d.、)）:：]*(?:回复\s*[^\s:：]+\s*[:：]?\s*|@[^\s]+\s*)?/;

  // ⚠️ 必须与 content/comments.js 的 PLATFORM_RULES 一字不差。不一致的探针比没有探针更坏——
  //    它会告诉你「选择器没问题」，而插件用的是另一套。改一边就改另一边。
  //    2026-08-08 真机校准：douyin(时间锚)/bilibili(四层shadow链)/xiaohongshu(排sub)/youtube/x(排主推文)；
  //    tiktok 未登录看不到评论，仍未校准。
  const PLATFORM_RULES = {
    douyin: {
      containers: ['[data-e2e="comment-list"]'],
      items: ['[data-e2e="comment-item"]'],
      textStrategy: 'time-anchor',
      textInItem: [],
    },
    bilibili: {
      containers: ['bili-comments'],
      items: ['bili-comment-thread-renderer'],
      shadowChain: ['bili-comment-renderer', 'bili-rich-text', '#contents'],
      shadow: true,
    },
    xiaohongshu: {
      containers: ['.comments-container'],
      items: ['.comment-item:not(.comment-item-sub)'],
      textInItem: ['.content', '.note-text'],
    },
    youtube: {
      containers: ['ytd-comments', '#comments'],
      items: ['ytd-comment-thread-renderer'],
      textInItem: ['#content-text'],
    },
    x: {
      containers: ['section[role="region"]', '[aria-label*="Timeline"]'],
      items: ['article[data-testid="tweet"][tabindex="0"]'],
      textInItem: ['[data-testid="tweetText"]'],
    },
    tiktok: {
      containers: ['[data-e2e="comment-list"]', '[class*="CommentList"]'],
      items: ['[data-e2e="comment-list-item"]', '[class*="DivCommentItemContainer"]', '[class*="DivCommentObjectWrapper"]', '[class*="CommentItem"]'],
      textInItem: ['[data-e2e="comment-level-1"] p', 'p[data-e2e="comment-level-1"]', '[data-e2e="comment-level-1"]'],
    },
  };

  function detectPlatform() {
    const h = location.hostname;
    if (h.includes('douyin.com')) return 'douyin';
    if (h.includes('bilibili.com')) return 'bilibili';
    if (h.includes('xiaohongshu.com')) return 'xiaohongshu';
    if (h.includes('youtube.com')) return 'youtube';
    if (h.includes('x.com') || h.includes('twitter.com')) return 'x';
    if (h.includes('tiktok.com')) return 'tiktok';
    return null;
  }

  function extractText(root, textSelectors) {
    // 与 comments.js 同一条纪律：命中选择器即定局（空文本 = 纯表情 = 跳过这条），
    // 指定选择器全部落空也**不再**拿整条 item 的 textContent 兜底——那是昵称/时间/IP
    // 混进正文的唯一通道（2026-08-08 小红书真机踩实）。
    for (const sel of textSelectors) {
      let node = null;
      try { node = root.querySelector(sel); } catch { continue; }
      if (node) {
        let t = (node.textContent || '').trim().replace(NOISE_PREFIX, '').trim();
        if (t.length > MAX_LEN) return { text: t.slice(0, MAX_LEN), via: sel + ' (截断)' };
        if (t.length >= MIN_LEN) return { text: t, via: sel };
        return { text: null, via: `∅ ${sel} 命中但文本空/过短（纯表情评论？）` };
      }
    }
    return { text: null, via: '∅ 全部正文选择器落空（页面改版？看第 ⑤ 段兜底扫描）' };
  }

  // ── 与 content/comments.js 同一份的三策略提取（改那边记得改这边）──
  function finalizeText(raw) {
    let t = (raw || '').trim().replace(/\s+/g, ' ');
    t = t.replace(NOISE_PREFIX, '').trim();
    if (t.length > MAX_LEN) return t.slice(0, MAX_LEN);
    if (t.length >= MIN_LEN) return t;
    return null;
  }

  function extractViaShadowChain(el, chain) {
    let node = el;
    for (const sel of chain) {
      const root = node.shadowRoot;
      if (!root) return { text: null, via: `shadow链断在 ${sel} 前（无 shadowRoot）` };
      try { node = root.querySelector(sel); } catch { return { text: null, via: `shadow链 ${sel} 选择器非法` }; }
      if (!node) return { text: null, via: `shadow链 ${sel} 未命中` };
    }
    const t = finalizeText(node.textContent);
    return t ? { text: t, via: 'shadowChain ' + chain.join(' → ') } : { text: null, via: 'shadow链走通但文本为空/过短（纯图评论？）' };
  }

  const TIME_ANCHOR_RE = /^(\d+\s*[天周小时分钟月年秒]+前|刚刚|昨天|前天|今天)/;
  function extractViaTimeAnchor(item) {
    let anchor = null;
    for (const n of item.querySelectorAll('span, div, p')) {
      const own = [...n.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent).join('').trim();
      if (own && TIME_ANCHOR_RE.test(own)) { anchor = n; break; }
    }
    if (!anchor) return { text: null, via: '没找到「x前(·地名)」时间锚——页面改版或评论未渲染' };
    let n = anchor;
    while (n && n !== item) {
      const prev = n.previousElementSibling;
      if (prev) {
        if (prev.querySelector('[data-e2e="video-comment-more"]') || /info-wrap/.test(prev.className || '')) {
          return { text: null, via: '时间行前兄弟是昵称行 → 纯表情评论，正确跳过' };
        }
        const t = finalizeText(prev.textContent);
        return t ? { text: t, via: 'time-anchor 前兄弟' } : { text: null, via: '正文行文本为空/过短' };
      }
      n = n.parentElement;
    }
    return { text: null, via: '时间锚向上爬到 item 都没有前兄弟' };
  }

  // 两道闸：与 comments.js 同一份实现，这样探针说「会被拒」就是真的会被拒
  function validateSource(items) {
    if (items.length < 3) return { ok: false, reason: 'too_few', detail: `只有 ${items.length} 条，阈值 3` };
    const lens = items.map((t) => t.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length;
    if (variance < 4 && items.length > 5) {
      return { ok: false, reason: 'uniform_length', detail: `长度方差 ${variance.toFixed(2)} < 4（像标题列不像评论）` };
    }
    return { ok: true, detail: `${items.length} 条，长度方差 ${variance.toFixed(2)}` };
  }

  function validateShape(items) {
    const ts = items.find((t) => /\d+[天小时分钟秒]前/.test(t));
    if (ts) return { ok: false, reason: 'timestamp_in_text', detail: `时间戳混进正文：「${cut(ts)}」→ 正文选择器选大了` };
    const ui = items.find((t) => /(回复|展开|查看全部|更多回复)$/.test(t));
    if (ui) return { ok: false, reason: 'ui_text_suffix', detail: `结尾是 UI 文本：「${cut(ui)}」→ 正文选择器选大了` };
    if (items.length >= 5) {
      const prefixes = {};
      for (const t of items) {
        for (let len = 2; len <= 4 && len < t.length; len++) {
          const p = t.slice(0, len);
          prefixes[p] = (prefixes[p] || 0) + 1;
        }
      }
      for (const [p, count] of Object.entries(prefixes)) {
        if (count >= items.length * 0.6 && p.length >= 2) {
          return { ok: false, reason: 'shared_prefix', detail: `${count}/${items.length} 条共享前缀「${p}」→ 抓到的是昵称列，不是正文` };
        }
      }
    }
    return { ok: true, detail: '正文形状看起来是干净的' };
  }

  // 稳定选择器：优先 data-* / id / 自定义元素名，最后才退到 class（class 常是编译期哈希，会变）
  function stableSelector(el) {
    if (!el || !el.tagName) return '(null)';
    const tag = el.tagName.toLowerCase();
    if (tag.includes('-')) return tag; // 自定义元素（bili-comments / ytd-comment-thread-renderer）最稳
    for (const a of ['data-e2e', 'data-testid', 'data-type', 'id']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) return a === 'id' ? `#${v}` : `[${a}="${v}"]`;
    }
    const cls = (el.className && typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean);
    const stable = cls.find((c) => /comment|reply|note|list|content/i.test(c) && !/^[a-z0-9_-]{8,}$/i.test(c));
    if (stable) return `${tag}.${stable}`;
    return cls.length ? `${tag}.${cls[0]}  ⚠️(class 可能是编译期哈希，会变)` : tag;
  }

  P('════════ 烽火台评论区探针 ════════');
  P('URL      ', location.href);
  P('hostname ', location.hostname);

  const platform = detectPlatform();
  P('platform ', platform || '❌ 不在支持列表里 —— comments.js 会直接返回 unknown_platform');
  if (!platform) { console.log(L.join('\n')); return; }

  const rules = PLATFORM_RULES[platform];

  // ── ① 容器 ──────────────────────────────────────────────────
  P('');
  P('──── ① 容器候选（第一个命中的胜出）────');
  let container = null;
  let containerSel = null;
  for (const sel of rules.containers) {
    let el = null;
    try { el = document.querySelector(sel); } catch { P(`  ✗ ${sel}  （选择器语法非法）`); continue; }
    if (!el) { P(`  ✗ ${sel}`); continue; }
    if (el.shadowRoot) {
      P(`  ✓ ${sel}  → 命中，且有 shadowRoot（评论在影子树里，只能从 shadowRoot 往下找）`);
      container = el.shadowRoot;
    } else {
      P(`  ✓ ${sel}  → 命中（无 shadowRoot）`);
      container = el;
    }
    containerSel = sel;
    break;
  }
  if (!container) P('  ❌ 全部落空 → comments.js 会返回 no_container。看第 ③ 段的兜底扫描。');

  // ── ② 条目 + 正文 ────────────────────────────────────────────
  let texts = [];
  if (container) {
    P('');
    P('──── ② 条目候选 ────');
    let itemSel = null;
    let els = [];
    for (const sel of rules.items) {
      let found = [];
      try { found = [...container.querySelectorAll(sel)]; } catch { P(`  ✗ ${sel}  （选择器语法非法）`); continue; }
      P(`  ${found.length > 0 ? '✓' : '✗'} ${sel}  → ${found.length} 条`);
      if (found.length > 0 && !itemSel) { itemSel = sel; els = found; }
    }
    if (!itemSel) {
      P('  ❌ 全部落空 → comments.js 会返回 no_items。容器对了但条目选择器不对，看第 ③ 段。');
    } else {
      P('');
      P(`──── ③ 正文抽取（用 ${itemSel} 的前 ${Math.min(8, els.length)} 条抽样）────`);
      const viaCount = {};
      for (const el of els.slice(0, MAX_COMMENTS)) {
        // 与 comments.js 的 readItems 同一套分支：shadowChain(B站) / time-anchor(抖音) / 选择器
        let r = null;
        if (rules.shadowChain) {
          r = extractViaShadowChain(el, rules.shadowChain);
        } else if (rules.textStrategy === 'time-anchor') {
          r = extractViaTimeAnchor(el);
        } else {
          const root = (rules.shadow && el.shadowRoot) ? el.shadowRoot : el;
          r = extractText(root, rules.textInItem);
        }
        if (r && r.text) { texts.push(r.text); viaCount[r.via] = (viaCount[r.via] || 0) + 1; }
        else if (r && r.via) { viaCount['∅ ' + r.via] = (viaCount['∅ ' + r.via] || 0) + 1; }
      }
      texts.slice(0, 8).forEach((t, i) => P(`  ${String(i + 1).padStart(2)}. ${cut(t)}`));
      P('');
      P('  正文选择器命中分布：');
      for (const [via, n] of Object.entries(viaCount)) P(`    ${n} 条 ← ${via}`);
      P(`  合计取到 ${texts.length} 条正文（页面上共 ${els.length} 个条目）`);

      P('');
      P('──── ④ 两道闸（这就是上线后会不会静默出错的地方）────');
      const s = validateSource(texts);
      P(`  来源闸 validateSource : ${s.ok ? '✓ 通过' : '❌ 拒发 ' + s.reason}  —— ${s.detail}`);
      const sh = validateShape(texts);
      P(`  形状闸 validateShape  : ${sh.ok ? '✓ 通过' : '❌ 拒发 ' + sh.reason}  —— ${sh.detail}`);
      if (s.ok && sh.ok) P('  → 这一页能正常出提问。把当前三条选择器记下来就是校准结果。');
    }
  }

  // ── ⑤ 兜底扫描：容器/条目落空时，猜候选 ─────────────────────
  if (!container || texts.length === 0) {
    P('');
    P('──── ⑤ 兜底扫描（现行选择器不管用时看这里）────');
    // 找「同一个父节点下有 ≥5 个结构相同的子节点，且子节点文本长度在 5–200 之间」的簇
    const parents = new Map();
    const all = document.querySelectorAll('div, li, section, article, [class*="comment"], [class*="reply"]');
    for (const el of all) {
      const p = el.parentElement;
      if (!p) continue;
      const t = (el.textContent || '').trim();
      if (t.length < MIN_LEN || t.length > 200) continue;
      const key = p;
      if (!parents.has(key)) parents.set(key, []);
      parents.get(key).push(el);
    }
    const clusters = [...parents.entries()]
      .filter(([, kids]) => kids.length >= 5)
      .map(([p, kids]) => {
        const lens = kids.map((k) => (k.textContent || '').trim().length);
        const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
        const variance = lens.reduce((a, b) => a + (b - avg) ** 2, 0) / lens.length;
        return { p, kids, avg, variance };
      })
      // 评论簇的特征：条数多、长度参差（方差大）。导航/标签列是等长的，方差接近 0
      .filter((c) => c.variance > 20)
      .sort((a, b) => b.kids.length - a.kids.length)
      .slice(0, 5);

    if (clusters.length === 0) {
      P('  没扫到像评论列表的重复结构。');
      P('  最可能的原因：评论还没加载出来 / 评论在 iframe 里 / 评论在别的 shadowRoot 里。');
      P('  先在页面上把评论区滚出来、确认屏幕上看得见评论，再重跑一次探针。');
    } else {
      P(`  扫到 ${clusters.length} 个候选评论簇（按条数排序）：`);
      clusters.forEach((c, i) => {
        P('');
        P(`  【候选 ${i + 1}】${c.kids.length} 条，平均 ${Math.round(c.avg)} 字，长度方差 ${Math.round(c.variance)}`);
        P(`    容器选择器 : ${stableSelector(c.p)}`);
        P(`    条目选择器 : ${stableSelector(c.kids[0])}`);
        P(`    抽样：`);
        c.kids.slice(0, 3).forEach((k) => P(`      · ${cut(k.textContent)}`));
      });
      P('');
      P('  把命中的那一组填回 content/comments.js 的 PLATFORM_RULES[' + platform + ']，再重跑探针确认两道闸通过。');
    }
  }

  P('');
  P('════════ 探针结束 ════════');
  P('注意：探针只看当前屏幕上已经渲染出来的评论——和插件的行为一致（不翻页、不展开、不加载你没看到的内容）。');
  console.log(L.join('\n'));
})();
