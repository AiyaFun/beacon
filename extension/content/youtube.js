// YouTube 采集：频道页（youtube.com/@handle 或 /channel/<id> 的 /videos）+ 视频详情页（/watch?v=<id>）。
// 一个脚本按 URL 分流。实测校准 2026-07（真实 DOM）。⚠️ YouTube 国内被墙——需你挂 VPN 浏览
// （频道页公开、不用登录，比 X 省事）。选择器随改版可能失效，多重回退，失效时少采几项不报错。
//
// handle 与 parseCompetitorUrl 对齐：@handle（如 @MrBeast）或频道ID（UC…）。建议按 @handle 添加竞对，
// 因为频道页 URL 就是 /@handle，采到的 handle 才对得上（用频道ID添加、但页面是 @handle 时会对不上）。

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
    // 播放量 best-effort：watch-metadata 里含"次观看/views"的叶子节点（排除播放器覆盖层 ytp-*）
    const vEl = [...document.querySelectorAll('ytd-watch-metadata span, ytd-watch-info-text span, #info span')].find(
      (e) => e.children.length === 0 && /次观看|views/i.test(e.textContent || '') && !String(e.className).includes('ytp'),
    );
    if (vEl) { const v = pc(vEl.textContent); if (v != null) metrics.views = v; }

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
  let followers;
  const subEl = [...document.querySelectorAll('span, yt-formatted-string')].find(
    (e) => /subscriber|订阅/i.test(e.textContent || '') && (e.textContent || '').length < 30,
  );
  if (subEl) { const f = pc(subEl.textContent); if (f != null && f > 0) followers = f; }

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
    profile: name || followers != null ? { name, followers } : undefined,
    posts,
    ...(isSelf ? { isSelf: true } : {}),
  };
};
