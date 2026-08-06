// 读当前页面的正文（资讯库入库用）。按需注入，不常驻。
//
// 【为什么正文非得在浏览器里读】服务器直连小红书/抖音/X/公众号，拿到的不是验证页就是 JS 空壳
// （见服务端 lib/clip/platform.ts 的 canFetch 表）。而这里跑在用户自己的标签页里：
// 页面已经渲染好、登录态也在，正文就在 DOM 上摆着。读的是**用户眼睛看得到的那一页**，
// 不额外发任何请求、不动任何接口——这也是它和「爬虫」的区别。
//
// 取正文的策略与服务端 lib/clip/extract.ts 一致（站点专属容器 → 语义容器 → 最大文本块），
// 但这边有真 DOM，用 innerText 就能拿到人眼看到的文本，比正则拆 HTML 干净得多。

(() => {
  // 站点专属正文容器：命中即认，比任何启发式都准
  const SITE_SELECTORS = [
    '#js_content', // 微信公众号
    '.note-content, #detail-desc, .desc .note-text', // 小红书笔记
    '[data-e2e="detail-video-desc"], .video-info-detail', // 抖音
    'article[data-testid="tweet"]', // X 单条推文
    '#description-inline-expander, #description', // YouTube 简介
    '.article-content, .post-content, .entry-content, .rich_media_content', // 通用 CMS
    '.RichText', // 知乎
  ];
  const SEMANTIC = ['article', 'main', '[role="main"]'];
  // 整块跳过的噪声
  const NOISE = 'script,style,nav,header,footer,aside,form,iframe,noscript,button';

  function textOf(el) {
    if (!el) return '';
    // 克隆后剪掉噪声再取 innerText —— 直接取会把导航、推荐位、版权声明一起带进来
    const clone = el.cloneNode(true);
    clone.querySelectorAll(NOISE).forEach((n) => n.remove());
    return (clone.innerText || clone.textContent || '')
      .split('\n')
      .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function pickBody() {
    for (const sel of SITE_SELECTORS) {
      const el = document.querySelector(sel);
      const t = textOf(el);
      if (t.length > 0) return t; // 站点容器命中就照单全收，短文也算（与服务端同一口径）
    }
    for (const sel of SEMANTIC) {
      const t = textOf(document.querySelector(sel));
      if (t.length > 200) return t;
    }
    // 兜底：页面上文本量最大的块。只看 div/section，避免整个 body 一把抓
    let best = '';
    for (const el of document.querySelectorAll('div,section')) {
      if (el.querySelector('div,section')) continue; // 只看叶子块，防父子重复计数
      const t = textOf(el);
      if (t.length > best.length) best = t;
    }
    return best;
  }

  function meta(names) {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      const c = el?.getAttribute('content')?.trim();
      if (c) return c;
    }
    return '';
  }

  const title =
    meta(['og:title', 'twitter:title']) ||
    document.querySelector('h1')?.innerText?.trim() ||
    document.title ||
    '';
  const author =
    meta(['author', 'article:author']) ||
    document.querySelector('#js_name, .rich_media_meta_nickname, [rel="author"]')?.innerText?.trim() ||
    '';

  // 上限与服务端 MAX_STORE_CHARS 对齐；超长在这里就截断，别把 20 万字塞进一次请求
  const text = pickBody().slice(0, 20_000);

  // executeScript 取的是最后一个表达式的值
  return { title: title.slice(0, 200), author: author.slice(0, 80), text, chars: text.length };
})();
