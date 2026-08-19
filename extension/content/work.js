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
      // 2026-08-08 真机校准过的新埋点放最前，旧 `*-count` 保留作回退（口径与 douyin-video.js:115-118 同步）。
      // ⚠️ 08-13 发现这里此前只有旧的一套：douyin-video.js 当天就改了，这份没跟上，
      //    于是「拆解这条作品」通道一直在按旧埋点取数——取不到就是空，不报错。
      metrics: {
        likes: '[data-e2e="video-player-digg"], [data-e2e="video-player-digg-count"], [data-e2e="like-count"]',
        comments: '[data-e2e="feed-comment-icon"], [data-e2e="video-player-comment"], [data-e2e="video-player-comment-count"], [data-e2e="comment-count"]',
        collects: '[data-e2e="video-player-collect"], [data-e2e="video-player-collect-count"], [data-e2e="collect-count"]',
        shares: '[data-e2e="video-player-share"], [data-e2e="video-player-share-count"], [data-e2e="share-count"]',
      },
    },
    xiaohongshu: {
      title: '#detail-title, .title',
      desc: '.note-content, #detail-desc, .desc .note-text',
      author: '.author-wrapper .name, .username',
      cover: 'meta[property="og:image"]',
      metrics: { likes: '.like-wrapper .count', collects: '.collect-wrapper .count', comments: '.chat-wrapper .count' },
      // 作用域与 xhs-note.js:27,40 一致——见上面 scopeRoot 的说明，这两条是 08-08 真机的结论。
      metricsScope: '.engage-bar',
      authorScope: '.note-detail-mask, [class*="note-detail"], #noteContainer',
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
      // 昵称（显示名）优先，`browse-username` 取的是 unique_id（@handle），只当兜底。
      // 口径与 tiktok.js:143-146 一致——那里记着「缺了昵称，服务端建档会拿 handle 当名字，
      // 竞对清单里显示的就是 @xxx 而不是账号名（YouTube 07-28 踩过同一个坑）」。
      author: '[data-e2e="browse-nickname"], [data-e2e="video-author-nickname"], [data-e2e="browse-username"]',
      cover: 'meta[property="og:image"]',
      // 口径与 tiktok.js:127-130 的 DOM 兜底同步。
      // ⚠️ 分享数的 data-e2e 是 `undefined-count`，**不是笔误**——TikTok 线上就是这个名字
      //    （tiktok.js:123 有当场记录）。这里此前写的 `browse-share-count` 线上根本不存在，
      //    也就是说拆解 TikTok 作品从来没取到过分享数，而且不报错。收藏数此前整个漏了。
      metrics: {
        likes: '[data-e2e="browse-like-count"], [data-e2e="like-count"]',
        comments: '[data-e2e="browse-comment-count"], [data-e2e="comment-count"]',
        shares: '[data-e2e="undefined-count"], [data-e2e="share-count"]',
        collects: '[data-e2e="browse-collect-count"], [data-e2e="collect-count"]',
      },
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

  // ⚠️ **必须能限定作用域**。这是 08-08 那轮真机校准最核心的一条结论，而这个文件此前整个漏了：
  //
  // 小红书 explore modal 打开时，背景瀑布流仍然留在 DOM 里。全局
  // `document.querySelector('.like-wrapper .count')` 第一个命中的是**背景卡片**的赞数
  // ——xhs-note.js 文件头记的实测值是「取到 4，真值 159」。作者链接更糟：全页 73 条
  // `/user/profile/` 链接的第一条是左侧栏「我」，取到的是**用户自己**。
  //
  // 这类错误不会报错、数字本身也完全正常，而 lib/video/analyze.ts:187 会把它们拼成
  // 「页面上的公开数据：…」直接喂给模型——**拆解报告会引用另一条笔记的数据下结论**。
  // 采不到只是少一块信息；采到隔壁那条的数，是拿错数据当证据。
  const scopeRoot = (sel) => {
    if (!sel) return document;
    for (const s of sel.split(',')) {
      const el = document.querySelector(s.trim());
      if (el) return el;
    }
    return null; // 声明了作用域却找不到 → 宁可什么都不取，绝不退回全局
  };

  const pick = (sel, root = document) => {
    if (!sel || !root) return '';
    for (const s of sel.split(',')) {
      const el = root.querySelector(s.trim());
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

  const ownMetrics = {};
  const metricsRoot = scopeRoot(rule.metricsScope);
  for (const [k, sel] of Object.entries(rule.metrics || {})) {
    const v = parseCount(pick(sel, metricsRoot));
    if (v > 0) ownMetrics[k] = v;
  }

  // ── 优先用常驻解析器（__beaconParse）的结果 ──
  //
  // 上面那张 RULES 表是这个仓库里**第三套**选择器：竞对采集的主页解析器一套、详情页解析器一套，
  // 它自己一套。而每一轮真机校准发生在详情页那一层，这套从来没跟上过——2026-08-13 一次抓到三条：
  // 抖音新埋点没跟、TikTok 分享数写的选择器线上根本不存在、YouTube/X 干脆一个指标都不取
  // （`metrics: {}`，于是拆解报告里没有任何量级信息，模型只能凭标题和封面猜「这条为什么爆」）。
  //
  // 与其再抄一套（抄完下一轮照样漂），不如直接用已经校准好的那套：这六个平台的作品页上
  // `globalThis.__beaconParse` 都是常驻的（manifest 声明式注入），comments.js:525 早就在这么用。
  // work.js 走 executeScript 注入，与它们同处一个隔离世界，读得到。
  //
  // 两条边界：
  // ① **必须确认是同一条作品**。详情页解析器只返回一条，但列表页会返回一整页——
  //    拿错一条的数比没有数糟得多（那正是小红书背景卡片那个坑的形状）。所以按 URL 里的
  //    作品 ID 比对；比不上就整个放弃，不猜。用 URL 判定而不是 DOM：这里只需要认「是不是同一条」，
  //    不取任何数值，而 URL 形态比选择器稳得多。
  // ② **只让它赢指标，不让它赢标题/作者**。指标是漂移伤得最狠、也最需要校准的地方；
  //    而标题/作者本地取得到就用本地的——详情页解析器在标题为空时会给
  //    `[作品] #xxxx` 这类占位（见 douyin-video.js:135），让它盖掉一个真标题是倒退。
  const ITEM_ID_IN_URL = {
    bilibili: /\/video\/(BV[0-9A-Za-z]+|av\d+)/i,
    douyin: /\/video\/(\d+)/,
    xiaohongshu: /\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/,
    youtube: /[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/,
    tiktok: /\/video\/(\d+)/,
    x: /\/status\/(\d+)/,
  };

  function currentItemId() {
    const re = ITEM_ID_IN_URL[P];
    if (!re) return '';
    const m = re.exec(location.href);
    return m ? String(m[1] || m[2] || '') : '';
  }

  function residentParse() {
    try {
      return typeof globalThis.__beaconParse === 'function' ? globalThis.__beaconParse() : null;
    } catch {
      return null; // 常驻解析器自己抛了不该拖垮拆解，退回本地那套
    }
  }

  function residentHit() {
    const p = residentParse();
    const posts = p && Array.isArray(p.posts) ? p.posts : [];
    if (!posts.length) return null;
    const id = currentItemId();
    const post = id
      ? posts.find((x) => String(x.platformItemId) === id)
      : (posts.length === 1 ? posts[0] : null); // 认不出 ID 时，只有「就这一条」才敢用
    return post ? { post, profile: p.profile || null } : null;
  }

  const resident = residentHit();
  // 逐键合并：常驻解析器有的键它说了算，它没有的键用本地这套补上
  const metrics = { ...ownMetrics, ...((resident && resident.post.metrics) || {}) };

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

  // 这三个上限与 app/api/ingest/analyze/route.ts 的 zod 一一对应。
  // ⚠️ transcript 此前漏了这一刀：60 分钟的播客能解析出 2500+ 条，超过服务端 .max(2000)
  //    就是整趟拆解 400（不是降级成无字幕档）。服务端 08-13 已改成先截断再校验、
  //    旧插件当场就好；这里再截一次是为了别把用不上的几百 KB 发上去。
  // 标题/作者：本地取到就用本地的，取不到才退给常驻解析器（理由见上面 ② ）。
  // 抖音作者此前只有两层且第二层 `user-name` 已在 08-07 真机核对里确认消失——
  // 这条回退正好补上那个缺口，而不必再往 RULES 里塞第三层选择器。
  const title = (pick(rule.title) || (resident && resident.post.title) || '').slice(0, 300);
  const text = pick(rule.desc).slice(0, 20_000);
  const author = (
    pick(rule.author, scopeRoot(rule.authorScope))
    || (resident && resident.profile && resident.profile.name)
    || ''
  ).slice(0, 80);
  const TRANSCRIPT_CAP = 2000;

  return {
    platform: P,
    url: location.href,
    title,
    text,
    author,
    metrics,
    coverDataUri: await coverDataUri(),
    transcript: (await transcript()).slice(0, TRANSCRIPT_CAP),
  };
})();
