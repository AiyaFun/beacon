// 烽火台采集助手 · 内容脚本公共层。
// 职责：① 响应「采集本页」与智能降级解析；② 访问即采；③ 提供通用 DOM 提取服务。

function beaconParseCount(text) {
  if (text == null) return undefined;
  const t = String(text).replace(/[,\s]/g, '');
  const m = t.match(/([\d.]+)\s*(万|亿|w|W|k|K|m|M|b|B)?/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2];
  if (unit === '亿') return Math.round(n * 1e8);
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 1e4);
  if (unit === 'k' || unit === 'K') return Math.round(n * 1e3);
  if (unit === 'm' || unit === 'M') return Math.round(n * 1e6);
  if (unit === 'b' || unit === 'B') return Math.round(n * 1e9);
  return Math.round(n);
}
globalThis.__beaconParseCount = beaconParseCount;

// ── 单次回传的作品条数上限 ──
// **必须 ≤ 服务端 ingestPayloadSchema / ownPostIngestSchema 的 `posts.max(50)`**：
// 超一条不是「多的被截掉」，而是 zod 把**整批打回**，一条都不入库。
// 各站点解析器一律用它，别各写各的数字——此前 x.js 写 20、其余写 30，谁也没到 50，
// 于是翻页翻出来的作品会在解析器那一层被白白丢掉。
// 想要一次采更多，得先把服务端上限提上去**并且**给回传加分批，两件事一起做（见 README）。
const BEACON_POST_CAP = 50;
globalThis.__beaconPostCap = BEACON_POST_CAP;

// ── 「这一页是我自己的号吗？」──
//
// 每个平台的**我的主页与竞对主页都是同一种页面**（同域名、同 DOM、同结构），页面本身分不出是谁的。
// 唯一稳定的差别是：本人主页会露出只有自己看得见的入口（「编辑资料」「自定义频道」…），
// 别人的主页则是「关注 / 订阅 / 发私信」。
//
// ⚠️ 两条铁律：
//   ① **只认阳性信号**。找到就返回 true，找不到返回 undefined（「不确定」），
//      **绝不返回 false**——平台改版会让文案变，那时正确的退路是让用户自己确认一次，
//      而不是一口咬定「这不是你的号」，把一个能用的功能变成永远打不开的门。
//   ② 按**文本**匹配而不是 class：这些站点的 class 是构建期生成的哈希，改版必失效，
//      而「编辑资料」这几个字多年没变过。
//
// 认错的代价不对称：漏认（该 true 却 undefined）= 用户多点一次确认；
// 误认（不是本人却 true）= 竞对的几十条内容被写成你自己的发布记录，且没有一键撤销。
// 所以宁可漏认。
function beaconLooksLikeSelf(labels, scopeSelector) {
  try {
    const scope = (scopeSelector && document.querySelector(scopeSelector)) || document;
    const nodes = scope.querySelectorAll(
      'button, a, span[class*="edit"], div[class*="edit"], yt-button-shape, tp-yt-paper-button',
    );
    let i = 0;
    for (const el of nodes) {
      if (++i > 300) break; // 兜底：别在超大 DOM 上空转
      const t = (el.textContent || '').trim();
      // 限长：避免把「…点击编辑资料…」这种长句子里的子串当成按钮命中
      if (t && t.length <= 12 && labels.includes(t)) return true;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
globalThis.beaconLooksLikeSelf = beaconLooksLikeSelf;

// ── 智能兜底解析器 (保证任何支持平台的页面都不会返回 "解析失败") ──
function beaconFallbackParse() {
  const host = location.hostname;
  let platform = 'bilibili';
  if (host.includes('douyin.com')) platform = 'douyin';
  else if (host.includes('xiaohongshu.com')) platform = 'xiaohongshu';
  else if (host.includes('youtube.com')) platform = 'youtube';
  else if (host.includes('tiktok.com')) platform = 'tiktok';
  else if (host.includes('x.com') || host.includes('twitter.com')) platform = 'x';

  const href = location.href;
  let handle = '';

  if (platform === 'bilibili') {
    const m = href.match(/space\.bilibili\.com\/(\d+)/) || href.match(/video\/(BV\w+)/);
    if (m) handle = m[1];
  } else if (platform === 'douyin') {
    const m = href.match(/user\/([^/?]+)/) || href.match(/video\/(\d+)/);
    if (m) handle = m[1];
  } else if (platform === 'xiaohongshu') {
    const m = href.match(/profile\/([a-zA-Z0-9_]+)/) || href.match(/(?:explore|item|discovery\/item)\/([a-zA-Z0-9_]+)/);
    if (m) handle = m[1];
  } else if (platform === 'youtube') {
    // ⚠️ 两条都踩过（真机 2026-07-28「采 YouTube 没采到对应频道的账号」）：
    // ① handle 必须**带 @**，与 lib/competitor-url.ts / content/youtube.js 一致。
    //    去掉 @ 会让同一个频道被建成两个竞对（'MrBeast' 和 '@MrBeast'），
    //    而「访问即采」按 platform+handle 比对，从此再也匹配不上已订阅的那个。
    // ② **视频 ID 绝不能当频道 handle**。老代码在 /watch 页拿 v= 当 handle，
    //    于是竞对库里会冒出一个以视频 ID 命名的"频道"——那不是采得不准，是凭空造账号。
    // ③ handle 可能是中文（URL 里是百分号编码），要解成原文——否则与库里存的原文对不上，
    //    拼主页地址时还会被二次编码成 404（真机 2026-07-28 的 @傑少JAY）。
    const decYt = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    const at = href.match(/youtube\.com\/(@[^/?#]+)/);
    const ch = href.match(/youtube\.com\/channel\/([\w-]+)/);
    handle = at ? decYt(at[1]) : ch ? ch[1] : '';
  } else if (platform === 'tiktok') {
    // 与 content/tiktok.js / lib/competitor-url.ts 同口径：**只认 /@<unique_id>，且不带 @ 存**。
    // 功能页（/foryou /explore /live /tag/… /tiktokstudio）一律不带 @，靠这一条就全排掉了；
    // 认不出**绝不往下走**——下面那行兜底会把路径片段当 handle，在共享的竞对库里
    // 造出名为 'explore'、'foryou' 的假账号（YouTube 上就是这么造出过假频道的）。
    const m = href.match(/tiktok\.com\/@([^/?#]+)/);
    if (!m) return null;
    try { handle = decodeURIComponent(m[1]); } catch { handle = m[1]; }
  } else if (platform === 'x') {
    const m = href.match(/(?:x|twitter)\.com\/([^/?]+)/);
    if (m && !['home', 'explore', 'notifications', 'messages'].includes(m[1])) handle = m[1];
  }

  // YouTube 的频道身份只能来自 /@handle 或 /channel/<id>。拿不到就**不猜**：
  // 下面那行兜底会把路径片段当 handle（在 /watch、/results、/feed 上分别造出
  // 名为 'watch'、'results'、'feed' 的"竞对账号"）。宁可如实报「没解析出账号」，
  // 也不要在工作区共享的竞对库里凭空建一个不存在的频道。
  if (platform === 'youtube' && !handle) return null;

  if (!handle) {
    handle = location.pathname.replace(/^\//, '').replace(/\//g, '_') || 'page_item';
  }

  const name =
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('meta[name="author"]')?.content ||
    document.querySelector('.nickname, #h-name, h1, title')?.textContent?.trim() ||
    '小红书/社交创作者';

  const posts = [];
  const pageTitle = (document.querySelector('meta[property="og:title"]')?.content || document.title || '').trim();

  let itemId = handle;
  if (href.includes('BV')) {
    const m = href.match(/(BV\w+)/);
    if (m) itemId = m[1];
  } else if (href.match(/\/(video|explore|item|status)\/(\w+)/)) {
    const m = href.match(/\/(video|explore|item|status)\/(\w+)/);
    if (m) itemId = m[2];
  }

  posts.push({
    platformItemId: itemId,
    title: pageTitle.slice(0, 300),
    url: href,
    metrics: {},
  });

  return {
    platform,
    handle,
    profile: { name: name.slice(0, 100) },
    posts,
  };
}
globalThis.beaconFallbackParse = beaconFallbackParse;

// ── 当前页面正文（只喂给 AI 助手）──
// AI 助手此前拿到的「上下文」只有标题 + 几个数字，于是「爆款要点拆解」拆的其实是**一个标题**：
// 用户满屏正文摆在眼前，助手却在猜内容。这里把可见正文取一段带上去。
//
// 三条约束：
//   ① 只在用户**主动点**「拆解 / 衍生选题 / 发送」时才取、才发（不随页面加载上传任何东西）；
//   ② 有硬上限——整页文字动辄几万字，超上下文不说，真正相关的那段还会被淹掉；
//   ③ 跳过我们自己注入的侧栏（`#beacon-ai-root`），否则助手会把自己上一轮的回答当成页面内容。
const PAGE_TEXT_CAP = 4000;
function beaconPageText(cap = PAGE_TEXT_CAP) {
  try {
    const root = document.getElementById('beacon-ai-root');
    const mine = (el) => !!(root && el && root.contains(el));
    const parts = [];
    const push = (el) => {
      if (!el || mine(el)) return;
      const t = (el.innerText || el.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (t) parts.push(t);
    };
    // 信息流站点（X/微博这类）：正文散在多条 article 里，取 main.innerText 会把整条时间线
    // 连同侧栏推荐一起卷进来。有 article 就按条取前几条，没有才退回主区域。
    //
    // ⚠️ 先把**我们自己注入的**那些排掉再判断走哪个分支：侧栏本身可能含 article，
    // 若只在 push 里挡，"页面只有侧栏里那一个 article" 的情况会走进这条分支、被挡光，
    // 最后返回空串——正文明明就在 main 里。
    const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"], article')).filter((a) => !mine(a));
    if (arts.length) for (const a of arts.slice(0, 8)) push(a);
    else push(document.querySelector('main, [role="main"]') || document.body);
    return parts.join('\n---\n').trim().slice(0, cap);
  } catch {
    return '';
  }
}
globalThis.beaconPageText = beaconPageText;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 页面正文：popup / SidePanel 是扩展页面，够不到页面 DOM，只能向内容脚本要
  if (msg?.type === 'beacon-page-text') {
    sendResponse({ ok: true, text: beaconPageText(msg.cap) });
    return undefined;
  }
  // 自有后台自检：解析失败时告诉用户断在哪一步（选择器？列名？），
  // 而不是只给一句「回填 0 条」让人无从下手。见 self-backend.js __beaconSelfDiagnose。
  if (msg?.type === 'beacon-diagnose') {
    try {
      sendResponse(
        typeof globalThis.__beaconSelfDiagnose === 'function'
          ? globalThis.__beaconSelfDiagnose()
          : { ok: false, reason: '当前页面不是受支持的创作者后台' },
      );
    } catch (e) {
      sendResponse({ ok: false, reason: `自检异常: ${e?.message || e}` });
    }
    return undefined;
  }
  if (msg?.type !== 'beacon-collect') return undefined;
  // 翻页采集要滚动 + 等懒加载，是**异步**的 —— 必须 `return true` 把消息通道留着，
  // 否则 sendResponse 根本发不出去，界面上就是按钮永远停在「采集中…」
  //（同 sw.js 顶部记的那个「按钮永远停在回填中」的老毛病，一模一样的成因）。
  //
  // 什么时候翻页：用户显式点了采集（deep），或这一页本来就在后台标签页里
  //（批量采集打开的那种，document.hidden）。用户正看着的页面不滚。
  const deep = msg.deep === true || document.hidden === true;
  beaconRunCollect(deep).then(sendResponse).catch((e) => sendResponse({ ok: false, error: `解析异常: ${e?.message || e}` }));
  return true;
});

async function beaconRunCollect(deep) {
  try {
    let payload = null;
    if (typeof globalThis.__beaconParse === 'function') {
      try {
        // 创作者后台**不翻页**：那儿是分页按钮而不是滚动加载，且 self-backend.js 的解析
        // 一次要扫整张表，反复跑只是白烧 CPU。这条路是全插件最脆的一段，不动它。
        payload = deep && !globalThis.__beaconSelfOnly
          ? await beaconCollectDeep(globalThis.__beaconParse)
          : globalThis.__beaconParse();
      } catch (e) {
        console.warn('[Beacon] 站点特定解析失败，启动智能兜底:', e);
      }
    }

    // 自有创作者后台**绝不走兜底解析**：beaconFallbackParse 是给竞对公开页写的，
    // 认不出域名时默认 platform='bilibili'——在 mp.weixin.qq.com / channels.weixin.qq.com /
    // member.bilibili.com 上会把公众号/视频号的数据报成 B站，再按路径瞎凑一个 platformItemId。
    // 后台页解析失败的正常原因是表格还没渲染完，正确做法是让用户刷新重试，不是猜一个平台。
    if (globalThis.__beaconSelfOnly) {
      // 作品级（posts）与账号级（dailyStats/audience）各自独立：只有其中一块也算有收获。
      // 用户可能正停在「粉丝分析」页而不是「作品数据」页——那时 posts 为空但画像抓得到。
      const gotPosts = payload && payload.posts && payload.posts.length > 0;
      const gotAccount = payload && (payload.dailyStats || payload.audience);
      if (!gotPosts && !gotAccount) {
        return { ok: false, error: '没读到数据——请确认已打开「数据中心 · 作品数据」或「粉丝/受众分析」页并等内容加载完，再试一次' };
      }
      return { ok: true, payload };
    }

    if (!payload || !payload.handle || !payload.posts || payload.posts.length === 0) {
      payload = beaconFallbackParse();
    }

    if (!payload || !payload.handle) {
      return { ok: false, error: '未能解析出有效的账号/作品信息，请刷新页面后重试' };
    }
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: `解析异常: ${e?.message || e}` };
  }
}

// ── 访问即采 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 翻页采集（滚动加载更多作品）────────────────────────────────────────────
//
// 这些站点的作品栅格都是**懒加载**的：首屏通常只渲染 18–20 张卡片，剩下的要往下滚才去请求。
// 于是「采集本页」一直只采到首屏那点东西——一个 478 条作品的抖音号也只采到 20 条，
// 用户看到的现象就是「采不全」。
//
// 做法：解析 → 把**最后一条**作品的链接滚进视野 → 等一会儿再解析，直到够 50 条、
// 或连着两轮不再增长、或超出时间预算。
// 用 `scrollIntoView` 而不是 `window.scrollTo`：前者会带动元素**所在的那个滚动容器**，
// 不用去猜这一版页面到底是整页滚还是某个内层 div 在滚（各平台不一样，还会改版）。
//
// 三条约束：
//   ① **不主动滚用户正在看的页面**。只有用户显式点了采集（deep），或页面本来就在后台标签页里
//      （批量采集打开的那种，`document.hidden`）才滚——在用户眼皮底下把页面拽到底很粗暴。
//   ② 采完把滚动位置**还回去**，用户切回来时还在原地。
//   ③ 有硬预算（轮数 + 墙钟），页面怎么表现都会停：宁可少采几条，不能挂在那儿空转
//      （同 sw.js fetchWithTimeout 的道理——「让失败可见」比「万一能成」重要）。
const DEEP_MAX_ROUNDS = 12;
const DEEP_BUDGET_MS = 30000;
const DEEP_ROUND_MS = 900;
const DEEP_IDLE_ROUNDS = 2; // 连着这么多轮没长 = 到底了，或者加载不动了

// 用**作品 ID 反查它在页面上的链接**当滚动锚点：各平台卡片结构天差地别，
// 但作品链接里一定带着这个 ID，这是唯一跨平台通用的定位方式。
function beaconScrollAnchor(payload) {
  const posts = payload && payload.posts;
  const last = posts && posts.length ? posts[posts.length - 1] : null;
  const id = last && last.platformItemId;
  if (!id) return null;
  try {
    return document.querySelector(`a[href*="${CSS.escape(String(id))}"]`);
  } catch {
    return null;
  }
}

async function beaconCollectDeep(parse) {
  const scroller = document.scrollingElement || document.documentElement;
  const startY = scroller ? scroller.scrollTop : 0;
  const deadline = Date.now() + DEEP_BUDGET_MS;
  let payload = null;
  try {
    payload = parse();
  } catch {
    return null;
  }
  let idle = 0;
  for (let round = 0; round < DEEP_MAX_ROUNDS; round++) {
    const count = (payload && payload.posts && payload.posts.length) || 0;
    if (count >= BEACON_POST_CAP || Date.now() > deadline) break;
    const anchor = beaconScrollAnchor(payload);
    try {
      if (anchor) anchor.scrollIntoView({ block: 'end' });
      else if (scroller) scroller.scrollTop = scroller.scrollHeight;
      // 有些站点的懒加载挂在 window 上而不是内层容器，两边都推一把
      window.scrollBy(0, window.innerHeight);
    } catch { /* 页面不给滚就算了，下一轮照样重新解析 */ }
    await sleep(DEEP_ROUND_MS);
    let next = null;
    try {
      next = parse();
    } catch { /* 解析在中途抛错不影响已经采到的那些 */ }
    const nextCount = (next && next.posts && next.posts.length) || 0;
    // **只在不倒退时替换**：懒加载常把已渲染的卡片回收掉（虚拟列表），
    // 那一瞬间解析出来的条数会变少，拿它覆盖会把前面采到的全丢了。
    if (next && nextCount >= count) payload = next;
    idle = nextCount > count ? 0 : idle + 1;
    if (idle >= DEEP_IDLE_ROUNDS) break;
  }
  try {
    if (scroller) scroller.scrollTop = startY;
  } catch { /* ignore */ }
  return payload;
}
globalThis.__beaconCollectDeep = beaconCollectDeep;

function beaconToast(text, ok) {
  try {
    const id = 'beacon-toast';
    document.getElementById(id)?.remove();
    const el = document.createElement('div');
    el.id = id;
    el.textContent = text;
    el.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'max-width:280px', 'padding:10px 14px', 'border-radius:10px',
      'font:13px/1.5 -apple-system,"PingFang SC",sans-serif', 'color:#fff',
      `background:${ok ? '#16a34a' : '#dc2626'}`, 'box-shadow:0 4px 16px rgba(0,0,0,.25)',
      'opacity:0', 'transition:opacity .2s',
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = '1'));
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4200);
  } catch { /* ignore */ }
}

async function beaconAutoCollect() {
  try {
    const { autoCollect } = await chrome.storage.sync.get('autoCollect');
    if (autoCollect === false) return;
    // 自有数据站点（视频号/公众号/抖音/小红书/B站 创作者后台）永不参与「访问即采」：那是你自己的后台数据，
    // 只能由用户在插件里显式点「这是我的作品 · 回填数据看板」走 /api/ingest/self，
    // 绝不走竞对通道。判定放在首个 await 之后——站点脚本（self-backend.js）在 common.js
    // 之后同步执行，到这里标记必定已置上。
    if (globalThis.__beaconSelfOnly) return;
    const parse = globalThis.__beaconParse || beaconFallbackParse;

    let competitors = [];
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'beacon-get-competitors' });
      competitors = resp?.competitors || [];
    } catch {
      return;
    }
    if (!competitors.length) return;

    let payload = null;
    for (let i = 0; i < 15; i++) {
      payload = parse();
      if (payload && payload.handle && payload.posts && payload.posts.length > 0) break;
      await sleep(600);
    }
    if (!payload || !payload.handle) return;

    const subscribed = competitors.some(
      (c) => c.platform === payload.platform && String(c.handle) === String(payload.handle),
    );
    if (!subscribed) return;
    if (!payload.posts || payload.posts.length === 0) return;

    // 确认是已订阅的竞对之后，再翻几页把首屏之外的作品带上（首屏通常只有 18–20 条）。
    // **只在后台标签页里翻**——批量采集打开的那种页面用户看不见，滚它没有代价；
    // 用户正看着的页面一律不滚（见 beaconCollectDeep 顶部第 ① 条）。
    // 放在订阅判定之后：不订阅的号本来就不回传，没必要为它滚一遍页面。
    if (document.hidden) {
      const deeper = await beaconCollectDeep(parse);
      if (deeper && deeper.posts && deeper.posts.length > payload.posts.length) payload = deeper;
    }

    const r = await chrome.runtime.sendMessage({ type: 'beacon-ingest', payload });
    try {
      chrome.runtime.sendMessage({ type: 'beacon-collected', platform: payload.platform, handle: payload.handle, ok: !!r?.ok });
    } catch { /* ignore */ }
    if (r?.ok) beaconToast(`✓ 已自动采集「${r.competitor}」${r.withMetrics ?? r.posts} 条作品`, true);
    else if (r?.error) beaconToast(`采集未成功：${r.error}`, false);
  } catch { /* ignore */ }
}

beaconAutoCollect();
