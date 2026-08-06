// TikTok 采集：用户主页（tiktok.com/@<unique_id>）+ 作品详情页（/@<unique_id>/video/<id>）。
// ⚠️ TikTok 国内被墙——需你自己挂 VPN 浏览（主页公开、不用登录，比 X 省事）。
//
// 【handle 口径】不带 @，与 lib/competitor-url.ts 一致（TikTok 只有 unique_id 这一种身份形态，
// 不像 YouTube 还有频道ID）。带 @ 存进去会让同一个号被建成两个竞对，且「访问即采」按
// platform+handle 比对，从此再也匹配不上已订阅的那个（YouTube 踩过，见 content/youtube.js）。
//
// 【TikTok 没有「竞对/自己」之分的页面】
// 和 X 同一个道理：播放/点赞/评论/分享在 TikTok 上对所有人公开，你自己那条的数字
// 和竞对那条的数字在同一个 DOM 位置。所以这一份产出喂两条通道——加为竞对走
// /api/ingest/competitor，「这是我的作品」走 /api/ingest/self，区别只在用户点了哪个按钮。
// 正因如此下面的 isSelf 才要紧：它是唯一能挡住「把竞对的作品当成自己作品回填」的信号。
//
// 【两层取数：先 JSON 后 DOM】
// TikTok 的 SSR HTML 里带一段 <script type="application/json"> 的水合数据，里面就是这一页的
// 公开数字（和页面上显示的是同一份，只是没被格式化成「1.2M」）。它比 DOM 稳得多：
// class 是构建期哈希，data-e2e 也随改版变，而这段 JSON 的字段名多年没动。
// 但它**只反映首屏 SSR 的那一页**——TikTok 是 SPA，站内点几下之后它就过期了。
// 所以一律先校验「这段 JSON 说的是不是当前地址这条内容」，对不上就当没有，退回 DOM。
// ⚠️ 只读 <script> 标签的 textContent（那是 DOM 文本，内容脚本读得到）；
// 页面里的 React/Vue 运行时状态在隔离世界里是读不到的，别再往那个方向写死代码。

const TT_SELF_LABELS = [
  '编辑资料', '编辑个人资料', '推广', // 中文界面
  'Edit profile', 'Edit Profile', 'Promote', 'Analytics', // 英文界面
];

// 水合 JSON。解析失败/太大一律当没有——采不到几项指标是小事，抛异常会让整页解析垮掉。
const TT_JSON_CAP = 4_000_000;
function ttUniversalData() {
  for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
    const el = document.getElementById(id);
    const raw = el && el.textContent;
    if (!raw || raw.length > TT_JSON_CAP) continue;
    try {
      const json = JSON.parse(raw);
      // 新版把有效载荷埋在 __DEFAULT_SCOPE__ 下，老版（SIGI_STATE）就是顶层
      return json?.__DEFAULT_SCOPE__ ?? json;
    } catch { /* 换下一个 */ }
  }
  return null;
}

// 从水合数据里找「当前这条作品」。**必须按 id 核对**：SPA 里这段 JSON 可能还是上一页的，
// 不核对就会把 A 作品的播放量写进 B 作品的记录——那不是采得不准，是脏数据。
function ttItemFromData(data, id) {
  if (!data || !id) return null;
  const candidates = [
    data?.['webapp.video-detail']?.itemInfo?.itemStruct,
    data?.ItemModule?.[id],
  ];
  for (const it of candidates) {
    if (it && String(it.id ?? '') === String(id)) return it;
  }
  return null;
}

// 作品身份 → 账号身份：主页水合数据的两种形态（新版 webapp.user-detail / 老版 UserModule）。
// UserModule 里 users/stats 都是按 unique_id 做键的 map，得先找到键才拿得到值。
function ttUserInfo(data, handle) {
  const detail = data?.['webapp.user-detail']?.userInfo;
  if (detail?.user || detail?.stats) return { user: detail.user, stats: detail.stats ?? detail.statsV2 };
  const um = data?.UserModule;
  if (um?.users) {
    const key = Object.keys(um.users).find((k) => k.toLowerCase() === handle.toLowerCase()) ?? Object.keys(um.users)[0];
    if (key) return { user: um.users[key], stats: um.stats?.[key] };
  }
  return null;
}

function ttStats(it) {
  // stats 与 statsV2 是同一批数字的两种形态（后者是字符串）。合并而不是二选一：
  // 改版时可能只剩其中一个，也可能各缺几项。
  const s = { ...(it?.statsV2 ?? {}), ...(it?.stats ?? {}) };
  const n = (v) => {
    const x = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(x) && x >= 0 ? Math.round(x) : undefined;
  };
  const out = {};
  const map = { views: s.playCount, likes: s.diggCount, comments: s.commentCount, shares: s.shareCount, collects: s.collectCount };
  for (const k of Object.keys(map)) {
    const v = n(map[k]);
    if (v != null) out[k] = v;
  }
  return out;
}

// 单个 data-e2e 计数。TikTok 页面上就是「1.2M」「12.3万」这种缩写，__beaconParseCount 认得。
function ttCount(sel, pc) {
  const el = document.querySelector(sel);
  return el ? pc(el.textContent) : undefined;
}

// 无文案作品的标题。理由同 content/x.js 的 xFallbackTitle：标题是这条作品在烽火台里的身份，
// 一整列「(无文案)」既认不出是哪条，还会被 lib/insight/health-check.ts 的标题查重误判成重复内容。
// 用「作品 + ID 尾号」，在多次采集之间稳定（不带会随懒加载变化的信息）。
function ttFallbackTitle(id) {
  return `[作品] #${String(id).slice(-4)}`;
}

globalThis.__beaconParse = function () {
  const pc = globalThis.__beaconParseCount;
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const segs = location.pathname.split('/').filter(Boolean).map(dec);

  // 身份只能来自 /@<unique_id>。**不做保留字名单**：TikTok 的功能页（/foryou /explore /live
  // /tag/xxx /music/xxx /tiktokstudio…）一律不带 @，靠这一个形态就全排掉了；名单式排除
  // 每加一个新功能路径就漏一次，漏掉的那次会在共享的竞对库里建出一个假账号。
  // 认不出就如实返回 null——common.js 的兜底解析对 tiktok 同样只认 @ 开头（见那边的注释）。
  const first = segs[0] || '';
  if (!first.startsWith('@')) return null;
  const handle = first.slice(1);
  if (!handle) return null;

  const data = ttUniversalData();
  const vi = segs.findIndex((s) => s === 'video' || s === 'photo');
  const vid = vi >= 0 ? (segs[vi + 1] || '').replace(/\.html$/i, '') : '';

  // ── 作品详情页：单条的点赞/评论/分享/收藏（播放量详情页不显示，只在主页九宫格上）──
  if (vid && /^\d{6,25}$/.test(vid)) {
    const it = ttItemFromData(data, vid);
    let metrics = ttStats(it);
    // JSON 没给（SPA 里已过期）→ 退回 DOM。data-e2e 里 undefined-count 是分享数——
    // 不是笔误，TikTok 线上就是这个名字，改回 share-count 反而读不到。
    if (!Object.keys(metrics).length) {
      const fromDom = {
        likes: ttCount('[data-e2e="browse-like-count"], [data-e2e="like-count"]', pc),
        comments: ttCount('[data-e2e="browse-comment-count"], [data-e2e="comment-count"]', pc),
        shares: ttCount('[data-e2e="undefined-count"], [data-e2e="share-count"]', pc),
        collects: ttCount('[data-e2e="browse-collect-count"], [data-e2e="collect-count"], [data-e2e="undefined-count"] ~ strong', pc),
      };
      metrics = {};
      for (const k of Object.keys(fromDom)) if (fromDom[k] != null) metrics[k] = fromDom[k];
    }

    const desc = (
      it?.desc
      || document.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]')?.textContent
      || ''
    ).trim();
    // 昵称（显示名）而不是 unique_id：缺了它服务端建档会拿 handle 当名字，
    // 竞对清单里显示的就是 @xxx 而不是账号名（YouTube 真机 2026-07-28 踩过同一个坑）。
    const nick = (
      it?.author?.nickname
      || document.querySelector('[data-e2e="browse-nickname"], [data-e2e="video-author-nickname"]')?.textContent
      || ''
    ).trim();
    const created = Number(it?.createTime);

    return {
      platform: 'tiktok',
      handle,
      ...(nick ? { profile: { name: nick.slice(0, 100) } } : {}),
      posts: [{
        platformItemId: vid,
        title: desc.slice(0, 300) || ttFallbackTitle(vid),
        url: `https://www.tiktok.com/@${handle}/video/${vid}`,
        ...(Number.isFinite(created) && created > 0 ? { publishedAt: new Date(created * 1000).toISOString() } : {}),
        ...(Object.keys(metrics).length ? { metrics } : {}),
      }],
      // 详情页上「查看数据」（Analytics）只有作者本人看得到
      ...(globalThis.beaconLooksLikeSelf?.(TT_SELF_LABELS, '#main-content-video_detail, [data-e2e="browse-video"]') ? { isSelf: true } : {}),
    };
  }

  // ── 用户主页：昵称 + 粉丝数 + 作品九宫格（带播放量）──
  const userInfo = ttUserInfo(data, handle);
  const uStats = userInfo?.stats ?? null;

  const name =
    (userInfo?.user?.nickname || '').trim() ||
    document.querySelector('[data-e2e="user-subtitle"]')?.textContent?.trim() ||
    // og:title 形如「昵称 (@unique_id) | TikTok」，把括号后的部分切掉
    document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.split('(')[0]?.trim() ||
    undefined;

  let followers = Number(uStats?.followerCount);
  if (!Number.isFinite(followers) || followers <= 0) followers = pc(document.querySelector('[data-e2e="followers-count"]')?.textContent);
  if (!Number.isFinite(followers) || followers <= 0) followers = undefined;

  const seen = new Set();
  const posts = [];
  for (const it of document.querySelectorAll('[data-e2e="user-post-item"], [data-e2e="user-liked-item"]')) {
    const a = it.querySelector('a[href*="/video/"], a[href*="/photo/"]');
    if (!a) continue;
    const m = (a.getAttribute('href') || a.href || '').match(/\/(?:video|photo)\/(\d{6,25})/);
    if (!m || seen.has(m[1])) continue;
    const id = m[1];
    seen.add(id);
    // 九宫格上唯一的数字就是播放量（覆盖在封面左下角）
    const views = pc(it.querySelector('[data-e2e="video-views"]')?.textContent);
    // 文案在 img 的 alt 里也有一份（懒加载时 DOM 文本可能还没出来）
    const desc = (
      it.querySelector('[data-e2e="user-post-item-desc"]')?.textContent
      || it.querySelector('img[alt]')?.getAttribute('alt')
      || ''
    ).trim();
    // JSON 里有这条就顺手把完整指标与发布时间补上（比封面上的一个播放量全得多）。
    // ⚠️ 拿不到不补：不带 publishedAt 时自有通道会把发布时间填成「回填当天」，
    // 发布时段分析会全落在回填那一刻——但**编一个时间**比没有时间更糟，所以只在有值时给。
    const full = ttItemFromData(data, id);
    const metrics = { ...ttStats(full), ...(views != null ? { views } : {}) };
    const created = Number(full?.createTime);
    posts.push({
      platformItemId: id,
      title: (full?.desc || desc).slice(0, 300) || ttFallbackTitle(id),
      url: `https://www.tiktok.com/@${handle}/video/${id}`,
      ...(Number.isFinite(created) && created > 0 ? { publishedAt: new Date(created * 1000).toISOString() } : {}),
      ...(Object.keys(metrics).length ? { metrics } : {}),
    });
    if (posts.length >= (globalThis.__beaconPostCap || 30)) break; // 上限见 common.js BEACON_POST_CAP
  }

  // 本人主页才有「编辑资料 / 推广」；别人的主页是「关注 / 发消息」。
  // 中英文都列：TikTok 的界面语言跟着账号与地区走，只列英文在中文界面下一个都匹配不上
  //（X 真机 2026-07-27 因此 6 条指标全没读到，同一个教训）。
  // 只认阳性信号，认不出返回 undefined（不确定），绝不返回 false——见 common.js beaconLooksLikeSelf。
  const isSelf = globalThis.beaconLooksLikeSelf?.(TT_SELF_LABELS, '[data-e2e="user-page"], #main-content-others_homepage, main');

  return {
    platform: 'tiktok',
    handle,
    profile: name || followers != null ? { name, followers } : undefined,
    posts,
    ...(isSelf ? { isSelf: true } : {}),
  };
};
