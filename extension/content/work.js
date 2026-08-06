// 读当前作品页，供「一键拆解这条作品」用。按需注入，不常驻。
//
// ⚠️【这个文件绝不能定义 __beaconParse】
// 同条 manifest 规则里的多个内容脚本共用一个 window，后注入的会把先前的 __beaconParse 覆盖掉，
// 使前面那个变成永远跑不到的死代码（抖音/B站/小红书主页解析器就这么静默失效过）。
// 这里走 executeScript 按需注入 + 直接返回值的路子（与 article.js 一致），完全不碰那个全局。
//
// 【它读什么、不读什么——这条边界就是产品本身】
// 读：标题、文案/简介、作者、公开指标、封面图。全是**用户自己眼睛在这一页上看得到的东西**。
// 不读：视频文件。作品页上的 <video> 基本是 blob: 的 MSE 流，就算偶尔是直链也带防盗链；
//      我们**不去解也不去绕**，更不会替用户「自动下载」竞对视频——那正是
//      「要分析视频画面就自己下载后上传」这条产品规矩的另一面。
//
// 唯一一次额外网络请求是封面图：它页面上已经加载过了，这里 fetch 基本是缓存命中，
// 且带的是页面自己的 referer（没有伪装任何东西）。取回来就地缩到 1280px 再转 data URI——
// 既控住体积，也避免把原图整张塞进模型白烧 token。

(async () => {
  const clean = (s) => (s || '').replace(/[ \t ]+/g, ' ').trim();

  // ── 平台判定 ──
  const host = location.hostname;
  const P = /bilibili\.com|b23\.tv/.test(host)
    ? 'bilibili'
    : /douyin\.com/.test(host)
      ? 'douyin'
      : /xiaohongshu\.com/.test(host)
        ? 'xiaohongshu'
        : /youtube\.com|youtu\.be/.test(host)
          ? 'youtube'
          : /tiktok\.com/.test(host)
            ? 'tiktok'
            : /(^|\.)(x|twitter)\.com/.test(host)
              ? 'x'
              : null;

  // ── 每家的选择器 ──
  // ⚠️ B站这组是真机校准过的；抖音/小红书/TikTok 那几组是多重回退的 best-effort，
  // 失效时改这里对应的一行即可（不要去动通用逻辑）。
  const RULES = {
    bilibili: {
      title: 'h1.video-title, .video-title, h1',
      desc: '.desc-info-text, .basic-desc-info, #v_desc',
      author: 'a.up-name, .up-info-container .up-name',
      cover: 'meta[property="og:image"]',
      metrics: { views: '.view.item', danmaku: '.dm.item', likes: '.video-like-info', coins: '.video-coin-info', collects: '.video-fav-info', shares: '.video-share-info-text' },
    },
    douyin: {
      title: '[data-e2e="video-desc"], h1',
      desc: '[data-e2e="video-desc"]',
      author: '[data-e2e="video-author-nickname"], [data-e2e="user-name"]',
      cover: 'meta[property="og:image"]',
      metrics: { likes: '[data-e2e="video-player-digg-count"], [data-e2e="like-count"]', comments: '[data-e2e="video-player-comment-count"]', collects: '[data-e2e="video-player-collect-count"]', shares: '[data-e2e="video-player-share-count"]' },
    },
    xiaohongshu: {
      title: '#detail-title, .title',
      desc: '.note-content, #detail-desc, .desc .note-text',
      author: '.author-wrapper .name, .username',
      cover: 'meta[property="og:image"]',
      metrics: { likes: '.like-wrapper .count', collects: '.collect-wrapper .count', comments: '.chat-wrapper .count' },
    },
    youtube: {
      title: 'h1.ytd-watch-metadata, h1.title',
      desc: '#description-inline-expander, #description',
      author: 'ytd-channel-name a, #channel-name a',
      cover: 'meta[property="og:image"]',
      metrics: {},
    },
    tiktok: {
      title: '[data-e2e="browse-video-desc"], h1',
      desc: '[data-e2e="browse-video-desc"]',
      author: '[data-e2e="browse-username"]',
      cover: 'meta[property="og:image"]',
      metrics: { likes: '[data-e2e="browse-like-count"]', comments: '[data-e2e="browse-comment-count"]', shares: '[data-e2e="browse-share-count"]' },
    },
    x: {
      title: 'article[data-testid="tweet"] [data-testid="tweetText"]',
      desc: 'article[data-testid="tweet"] [data-testid="tweetText"]',
      author: 'article[data-testid="tweet"] [data-testid="User-Name"] a',
      cover: 'meta[property="og:image"]',
      metrics: {},
    },
  };

  const rule = RULES[P] || { title: 'h1', desc: 'article, main', author: '', cover: 'meta[property="og:image"]', metrics: {} };

  const pick = (sel) => {
    if (!sel) return '';
    for (const s of sel.split(',')) {
      const el = document.querySelector(s.trim());
      const t = el && clean(el.innerText || el.textContent);
      if (t) return t;
    }
    return '';
  };

  // 数字解析与 common.js 的 parseCount 同口径（万/亿/K/M/B）
  const parseCount = (raw) => {
    const s = clean(raw).replace(/,/g, '');
    if (!s) return 0;
    const m = s.match(/([\d.]+)\s*([万億亿kKmMbB]?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    const mult = { 万: 1e4, 億: 1e8, 亿: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 }[m[2]] || 1;
    return Math.round(n * mult);
  };

  const metrics = {};
  for (const [k, sel] of Object.entries(rule.metrics || {})) {
    const v = parseCount(pick(sel));
    if (v > 0) metrics[k] = v;
  }

  // ── 封面 → data URI（fetch → 缩到 1280 → jpeg）──
  // 先拿 og:image（各家都给，且是平台自己认可的封面），拿不到再退到 <video poster> / 页面最大图。
  async function coverDataUri() {
    const src =
      document.querySelector('meta[property="og:image"]')?.content ||
      document.querySelector('video[poster]')?.getAttribute('poster') ||
      biggestImage();
    if (!src) return null;
    try {
      const blob = await fetch(src, { credentials: 'omit' }).then((r) => (r.ok ? r.blob() : null));
      if (!blob || !/^image\//.test(blob.type)) return null;
      // createImageBitmap 走的是同源 blob，画到 canvas 不会污染，toDataURL 才拿得出来
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * scale));
      cv.height = Math.max(1, Math.round(bmp.height * scale));
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      bmp.close?.();
      return cv.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      return null; // 取不到封面就降级到纯文案档，不是错误
    }
  }

  function biggestImage() {
    let best = null;
    let area = 0;
    for (const img of document.images) {
      const a = img.naturalWidth * img.naturalHeight;
      if (a > area && a > 40_000 && img.currentSrc) {
        area = a;
        best = img.currentSrc;
      }
    }
    return best;
  }

  // ── 平台字幕轨 → 带时间戳的口播文字稿 ────────────────────────────
  //
  // 【为什么这块特别值钱】方舟视频理解只抽帧读画面、**收不到音轨**（真机实测），
  // 所以口播那一半本来是丢的。而平台自己的字幕轨是**精确文本 + 精确时间戳**，比任何 ASR 都准。
  // 拿到它，连没有视频文件的封面档都能分析口播结构。
  //
  // 【为什么只有插件能拿】服务端取不到：YouTube 的 timedtext 回 200 但 **0 字节**
  //（PO token 门禁），B站的字幕列表未登录恒空。浏览器里带着用户自己的登录态才有。
  // 读的仍然是用户这一页上本来就能看到的字幕，不绕任何权限。
  //
  // ⚠️ 内容脚本在**隔离世界**里，读不到页面的 ytInitialPlayerResponse / __INITIAL_STATE__
  //（已核实官方文档）。所以一律从 document 的 HTML 文本里正则抠，不去碰页面 JS 变量。

  const html = () => document.documentElement.innerHTML;

  async function transcript() {
    try {
      if (P === 'youtube') return await ytTranscript();
      if (P === 'bilibili') return await biliTranscript();
    } catch (e) {
      /* 取不到字幕不是错误，降级即可 */
    }
    return [];
  }

  async function ytTranscript() {
    // ① 首选：页面里列出的字幕轨，在页面上下文 fetch（带用户会话，服务端取不到的就是这一步）
    const m = /"captionTracks":(\[.*?\])/.exec(html());
    if (m) {
      let tracks = [];
      try {
        tracks = JSON.parse(m[1]);
      } catch (e) {
        tracks = [];
      }
      // 优先人工字幕（kind 非 asr），其次自动生成
      const pick = tracks.find((t) => t && t.baseUrl && t.kind !== 'asr') || tracks.find((t) => t && t.baseUrl);
      if (pick) {
        const r = await fetch(pick.baseUrl + '&fmt=json3', { credentials: 'include' }).catch(() => null);
        const j = r && r.ok ? await r.json().catch(() => null) : null;
        const out = (j && j.events ? j.events : [])
          .filter((e) => e && e.segs)
          .map((e) => ({ at: Math.round((e.tStartMs || 0) / 1000), text: e.segs.map((s) => s.utf8 || '').join('') }))
          .filter((l) => l.text.trim());
        if (out.length) return out;
      }
    }
    // ② 兜底：用户已经打开了「显示转写」面板时，那就是现成的 DOM 文本
    const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
    return Array.from(segs)
      .map((el) => {
        const t = (el.querySelector('.segment-timestamp')?.textContent || '').trim();
        const c = (el.querySelector('.segment-text')?.textContent || '').trim();
        const p = t.split(':').map(Number);
        const at = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : 0;
        return { at: isFinite(at) ? at : 0, text: c };
      })
      .filter((l) => l.text);
  }

  async function biliTranscript() {
    const bv = (location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1];
    const cid = (html().match(/"cid":(\d{4,})/) || [])[1];
    if (!bv || !cid) return [];
    // credentials:'include' 是关键——未登录时 subtitles 恒为空数组
    const r = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bv}&cid=${cid}`, { credentials: 'include' }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    const list = ((j && j.data && j.data.subtitle) || {}).subtitles || [];
    if (!list.length) return [];
    // 优先中文轨
    const t = list.find((s) => /zh|中文/i.test(s.lan || s.lan_doc || '')) || list[0];
    let u = t.subtitle_url || '';
    if (u.startsWith('//')) u = 'https:' + u; // B站给的是协议相对地址
    if (!u) return [];
    const r2 = await fetch(u).catch(() => null);
    const j2 = r2 && r2.ok ? await r2.json().catch(() => null) : null;
    return ((j2 && j2.body) || [])
      .map((b) => ({ at: Math.round(b.from || 0), text: String(b.content || '').trim() }))
      .filter((l) => l.text);
  }

  const title = pick(rule.title).slice(0, 300);
  const text = pick(rule.desc).slice(0, 20_000);
  const author = pick(rule.author).slice(0, 80);

  return {
    platform: P,
    url: location.href,
    title,
    text,
    author,
    metrics,
    coverDataUri: await coverDataUri(),
    transcript: await transcript(),
  };
})();
