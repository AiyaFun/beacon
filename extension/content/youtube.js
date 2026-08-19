// YouTube 采集：频道页（youtube.com/@handle 或 /channel/<id> 的 /videos）+ 视频详情页（/watch?v=<id>）。
// 一个脚本按 URL 分流。实测校准 2026-07（真实 DOM）。⚠️ YouTube 国内被墙——需你挂 VPN 浏览
// （频道页公开、不用登录，比 X 省事）。选择器随改版可能失效，多重回退，失效时少采几项不报错。
//
// handle 与 parseCompetitorUrl 对齐：@handle（如 @MrBeast）或频道ID（UC…）。建议按 @handle 添加竞对，
// 因为频道页 URL 就是 /@handle，采到的 handle 才对得上（用频道ID添加、但页面是 @handle 时会对不上）。

// 从内联 <script> 的**文本**里抠精确计数（页面正文印的是「18亿次观看」这种四舍五入值）。
//
// 读的是 document.scripts 的 textContent，属于 DOM 访问，内容脚本在隔离世界里照样能读；
// 不是去碰 window.ytInitialPlayerResponse 那个页面变量（那个读不到，见 sidebar 那边的同类教训）。
// 抠不出来就返回空对象，由调用方退回页面展示值——宁可粗一点，不能整项丢。
function ytExactCounts() {
  try {
    const src = [...document.scripts].map((s) => s.textContent || '').join('');
    const pick = (re) => { const m = src.match(re); return m ? Number(m[1]) : null; };
    const num = (v) => (v != null && Number.isFinite(v) && v >= 0 ? v : null);
    return {
      views: num(pick(/"viewCount"\s*:\s*"(\d+)"/)),
      likes: num(pick(/"likeCount"\s*:\s*"(\d+)"/)),
    };
  } catch {
    return { views: null, likes: null }; // 脚本读取出问题不该把整条解析带崩
  }
}

globalThis.__beaconParse = function () {
  const pc = globalThis.__beaconParseCount;
  const isWatch = location.pathname === '/watch' && /[?&]v=/.test(location.search);

  // ── 视频详情页：采单条的点赞（频道页看不到）+ 播放量 ──
  if (isWatch) {
    const vid = new URLSearchParams(location.search).get('v');
    if (!vid) return null;
    const owner = document.querySelector(
      'ytd-video-owner-renderer a[href^="/@"], #owner a[href^="/@"], ytd-channel-name a[href^="/@"],'
      + ' #upload-info a[href^="/@"], ytd-video-owner-renderer a[href*="/channel/"], #owner a[href*="/channel/"]',
    );
    const oh = owner ? owner.getAttribute('href') || '' : '';
    // 频道 handle 可能是中文（href 里是百分号编码），要解成原文——与频道页同一口径
    const dec1 = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    let handle;
    if (oh.startsWith('/@')) handle = dec1(oh.slice(1));
    else { const cm = oh.match(/\/channel\/([\w-]+)/); if (cm) handle = cm[1]; }
    // 认不出频道就如实失败。绝不能让它落到 common.js 的兜底解析上——
    // 那边会把**视频 ID** 当成 handle，在竞对库里造出一个以视频 ID 命名的假频道。
    if (!handle) return null;

    // 频道显示名。缺了它，服务端建档时 `name: profile?.name || handle`
    // 会拿 handle 当名字，于是竞对清单里显示的是 @xxx 而不是频道名
    //（真机 2026-07-28「采 YouTube 没采到对应 youtuber 的账号」就是这个现象）。
    const ownerName = (
      document.querySelector(
        'ytd-video-owner-renderer #channel-name #text, ytd-video-owner-renderer ytd-channel-name a,'
        + ' #owner #channel-name a, #upload-info #channel-name #text',
      )?.textContent || ''
    ).trim();

    const title = (
      document.querySelector('h1.ytd-watch-metadata, ytd-watch-metadata h1, #title h1')?.textContent || ''
    ).trim();
    const metrics = {};
    // 点赞：like 按钮的 aria-label 里带完整数字（如"…1,522,682 人一起顶…"）
    const likeBtn = document.querySelector(
      'like-button-view-model button, #segmented-like-button button, button[aria-label*="顶"], button[aria-label*="like" i]',
    );
    if (likeBtn) {
      const aria = likeBtn.getAttribute('aria-label') || '';
      const nums = (aria.match(/[\d,.]+/g) || []).map((s) => pc(s)).filter((n) => n != null && n > 0);
      const likes = nums.length ? Math.max(...nums) : pc(likeBtn.textContent);
      if (likes != null) metrics.likes = likes;
    }
    // 播放量。**先从内联脚本里取精确值，取不到才退回页面上那个数**。
    //
    // ⚠️ 真机 2026-08-10（dQw4w9WgXcQ）：页面正文印的是「18亿次观看」，
    // 按它入库就是 1,800,000,000，而真值是 1,802,557,814。差 255 万还在其次，
    // 要命的是这个数**不会动** —— 涨到 19亿之前每次采集都是同一个 1,800,000,000，
    // 增速/趋势整套失效。小号更狠：「1.2万次观看」的真值在 12000~12999 之间，天生 8% 误差。
    //
    // ytInitialPlayerResponse 里的 "viewCount":"1802557814" 是精确的，且就在 <script> 标签的
    // **文本**里 —— 内容脚本读 document.scripts 是读 DOM，不碰页面 JS 变量，
    // 因此不受隔离世界限制（对比 B站：它的精确值只在 window.__INITIAL_STATE__ 这个页面变量里，
    // 内联脚本正则不出来，那边就只能拿展示值，见 bili-video.js 的说明）。
    const exact = ytExactCounts();
    if (exact.views != null) metrics.views = exact.views;
    else {
      const vEl = [...document.querySelectorAll('ytd-watch-metadata span, ytd-watch-info-text span, #info span')].find(
        (e) => e.children.length === 0 && /次观看|views/i.test(e.textContent || '') && !String(e.className).includes('ytp'),
      );
      if (vEl) { const v = pc(vEl.textContent); if (v != null) metrics.views = v; }
    }
    // 点赞：aria-label 本来就是精确的，脚本值只在 aria 读不到时补位
    if (metrics.likes == null && exact.likes != null) metrics.likes = exact.likes;

    // 评论数 best-effort：YouTube 的评论区是懒加载的，用户没滚到就没有这个节点
    // （2026-08-11 真机：自动化环境里始终停在「评论」二字、加载不出计数，无法确认上限）。
    // 与 B站 同一条纪律：取到算赚到，取不到就不写这一项 —— 绝不写 0 冒充「零评论」。
    try {
      const cEl = document.querySelector('ytd-comments-header-renderer #count, #comments #count');
      const c = cEl ? pc(cEl.textContent) : null;
      if (c != null && c >= 0) metrics.comments = c;
    } catch { /* 读不到就算了，不影响其余指标 */ }

    return {
      platform: 'youtube',
      handle,
      ...(ownerName ? { profile: { name: ownerName.slice(0, 100) } } : {}),
      posts: [{
        platformItemId: vid,
        title: title.slice(0, 300) || '(无标题)',
        url: `https://www.youtube.com/watch?v=${vid}`,
        ...(Object.keys(metrics).length ? { metrics } : {}),
      }],
    };
  }

  // ── 频道页：名字 + 订阅数 + 视频列表(带播放量) ──
  // ⚠️ pathname 是**编码后**的：`youtube.com/@傑少JAY` → `/@%E5%82%91%E5%B0%91JAY`。
  // 必须解码成原文，才和 lib/competitor-url.ts 存进库的 handle 对得上
  //（真机 2026-07-28：中文频道 handle 因此双重编码，主页地址打开是 404，什么都采不到）。
  // 解不开就原样用：handle 里可能真的带 %，decodeURIComponent 遇非法序列会抛。
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const segs = location.pathname.split('/').filter(Boolean);
  let handle;
  if ((segs[0] || '').startsWith('@')) handle = dec(segs[0]);
  else if (segs[0] === 'channel' && segs[1]) handle = dec(segs[1]);
  else if ((segs[0] === 'user' || segs[0] === 'c') && segs[1]) handle = dec(segs[1]);
  else return null;

  const name =
    document.querySelector('yt-dynamic-text-view-model h1, .dynamic-text-view-model-wiz__h1, ytd-channel-name #text, #channel-name #text')?.textContent?.trim() ||
    document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    document.title.replace(/\s*-\s*YouTube.*$/i, '').trim() ||
    undefined;
  // 订阅数。走 common.js 的共用内核。
  //
  // YouTube 是**数字在前**的版式（「1.2万位订阅者」/「1.2M subscribers」），内核两端都试。
  // 频道头部常把三样拼在一行——「@handle · 1.2M subscribers · 500 videos」，
  // 老代码对整段取 `pc()`（第一个数字），这一行里第一个数字是什么全看平台怎么排。
  // ⚠️ 中英文都要列：界面语言跟着账号走，只列英文在中文界面下一个都匹配不上
  //（X 真机 2026-07-27 因此 6 条指标全没读到，同一个教训）。长的排前面——
  // 'subscriber' 是 'subscribers' 的子串，'订阅' 是 '订阅者' 的子串，顺序反了会截错位置。
  const ytStats = globalThis.__beaconReadStats?.(
    [
      { key: 'followers', labels: ['位订阅者', '订阅者', 'subscribers', 'subscriber', '订阅'] },
      { key: 'videos', labels: ['个视频', 'videos', 'video'] },
    ],
    ['#page-header', 'ytd-channel-header-renderer', 'yt-page-header-renderer', '#channel-header', 'ytd-browse'],
  ) || { values: {}, via: {} };
  const followers = ytStats.values.followers;

  const seen = new Set();
  const posts = [];
  for (const it of document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer')) {
    const links = [...it.querySelectorAll('a[href*="/watch?v="]')];
    if (!links.length) continue;
    const idm = links[0].href.match(/[?&]v=([\w-]{6,})/);
    if (!idm || seen.has(idm[1])) continue;
    const id = idm[1];
    seen.add(id);
    // 标题：取非"时长"文本、最长的那个 watch 链接文本
    let title = '';
    for (const a of links) {
      const t = (a.textContent || '').trim();
      if (t && !/^[\d:：]+$/.test(t) && t.length > title.length) title = t;
    }
    if (!title) title = (it.querySelector('#video-title, h3')?.textContent || '').trim();
    // 播放量：项内文本里的"N次观看/N views"
    let views;
    const vm = (it.textContent || '').match(/([\d.,]+\s*[万亿kKmMbB]?)\s*(?:次观看|views)/i);
    if (vm) views = pc(vm[1]);
    posts.push({
      platformItemId: id,
      title: title.slice(0, 300),
      url: `https://www.youtube.com/watch?v=${id}`,
      ...(views != null ? { metrics: { views } } : {}),
    });
    if (posts.length >= (globalThis.__beaconPostCap || 30)) break; // 上限见 common.js BEACON_POST_CAP
  }

  // 本人频道才有「自定义频道 / 管理视频」；别人的频道是「订阅」（见 common.js beaconLooksLikeSelf）。
  // 中英文都列：YouTube 的界面语言跟着账号走，中文界面下英文标签一个都匹配不上
  //（同 X 的教训：aria-label 是会被翻译的，2026-07-27 因此 6 条指标全没读到）。
  const isSelf = globalThis.beaconLooksLikeSelf?.(
    ['自定义频道', '管理视频', 'Customize channel', 'Manage videos'],
    'ytd-browse, #page-header, #channel-header',
  );

  return {
    platform: 'youtube',
    handle,
    profile: name || followers != null ? { name, followers, followersVia: ytStats.via.followers || 'none' } : undefined,
    posts,
    ...(isSelf ? { isSelf: true } : {}),
  };
};
