// B站 UP 主空间页解析（space.bilibili.com/<mid>）。
// ⚠️ 选择器随平台改版可能失效——全部走多重回退 + 通用锚点扫描，失效时优雅拿到更少字段而不是报错。
// B站作品指标主要靠服务端公开接口通道采，这里的重点是 handle(mid)/粉丝数/作品清单兜底。

globalThis.__beaconParse = function () {
  const m = location.pathname.match(/^\/(\d+)/);
  if (!m) return null;
  const handle = m[1];
  const parseCount = globalThis.__beaconParseCount;

  // 昵称：老版 #h-name / 新版 .nickname
  const name =
    document.querySelector('#h-name')?.textContent?.trim() ||
    document.querySelector('.nickname')?.textContent?.trim() ||
    undefined;

  // 粉丝数：找文案含「粉丝」的统计项，取其中的数字（老版 .n-fs 有 title，新版是相邻文本）
  let followers;
  for (const el of document.querySelectorAll('a, div, p, span')) {
    const t = el.textContent ?? '';
    if (t.length < 20 && t.includes('粉丝')) {
      const n = parseCount(el.getAttribute('title') ?? t.replace('粉丝', ''));
      if (n != null && n > 0) {
        followers = n;
        break;
      }
    }
  }

  // 作品：按视频卡片 .bili-video-card 遍历（实测校准 2026-07，space.bilibili.com 新版 DOM）。
  // ⚠️ 不能按 a[href*=/video/BV] 锚点扫：新版每张卡有两个 BV 锚点——封面锚点(.bili-cover-card，
  //    textContent 是"播放量+弹幕+时长"拼接) 和标题锚点。按锚点取会把播放量当成标题。
  //    卡片里的 .bili-video-card__title 才是干净标题（带 title 属性）。
  // 回退：新版类名不存在时（老版页面）退回锚点扫描，标题优先取 title 属性。
  const seen = new Set();
  const posts = [];
  const cards = document.querySelectorAll('.bili-video-card');
  if (cards.length > 0) {
    for (const card of cards) {
      const a = card.querySelector('a[href*="/video/BV"]');
      if (!a) continue;
      const idm = a.href.match(/video\/(BV\w+)/);
      if (!idm || seen.has(idm[1])) continue;
      const tEl = card.querySelector('.bili-video-card__title');
      const title = (tEl?.getAttribute('title') || tEl?.textContent || '').trim();
      if (!title) continue;
      seen.add(idm[1]);
      // 播放量：.bili-cover-card__stat 第一项（不含":"的那个，":"是时长）
      let views;
      for (const st of card.querySelectorAll('.bili-cover-card__stat')) {
        const txt = (st.textContent || '').trim();
        if (txt && !txt.includes(':')) { views = parseCount(txt); break; }
      }
      posts.push({
        platformItemId: idm[1],
        title: title.slice(0, 300),
        url: `https://www.bilibili.com/video/${idm[1]}`,
        ...(views != null ? { metrics: { views } } : {}),
      });
      if (posts.length >= (globalThis.__beaconPostCap || 30)) break; // 上限见 common.js BEACON_POST_CAP
    }
  } else {
    // 老版兜底：锚点扫描，标题只认 title 属性（textContent 在新版会混入统计数字）
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const idm = a.href.match(/video\/(BV\w+)/);
      if (!idm || seen.has(idm[1])) continue;
      const title = (a.getAttribute('title') || '').trim();
      if (!title) continue;
      seen.add(idm[1]);
      posts.push({ platformItemId: idm[1], title: title.slice(0, 300), url: `https://www.bilibili.com/video/${idm[1]}` });
      if (posts.length >= (globalThis.__beaconPostCap || 30)) break; // 上限见 common.js BEACON_POST_CAP
    }
  }

  return {
    platform: 'bilibili',
    handle,
    profile: { name, followers },
    posts,
    // 本人空间才有「编辑资料」/「投稿管理」；别人的空间是「关注」（见 common.js beaconLooksLikeSelf）
    ...(globalThis.beaconLooksLikeSelf?.(['编辑资料', '投稿管理', '个人中心'], '.h-inner, #h-name, .space-header, #app')
      ? { isSelf: true } : {}),
  };
};
