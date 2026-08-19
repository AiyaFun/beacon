// 小红书用户主页解析（www.xiaohongshu.com/user/profile/<user_id>）。
// ⚠️ 选择器随改版可能失效，多重回退。小红书与抖音同理：未接商业数据源时，
// 用户亲眼可见的公开页回传是唯一合规指标来源。

// 小红书笔记链接**必须带 xsec_token** 才能打开——裸 /explore/<id> 会显示「当前内容无法查看」。
// 从卡片锚点里保留这个 token（token 有时效，采集当下有效；过期后需重采刷新）。B站/抖音链接无需 token。
function xhsNoteUrl(href, id) {
  let url = `https://www.xiaohongshu.com/explore/${id}`;
  try {
    const q = new URL(href, location.origin).searchParams;
    const tok = q.get('xsec_token');
    if (tok) {
      const src = q.get('xsec_source') || 'pc_user'; // 保留原始来源上下文（pc_user/pc_feed…）
      url += `?xsec_token=${encodeURIComponent(tok)}&xsec_source=${encodeURIComponent(src)}`;
    }
  } catch {
    /* 解析失败就用裸链接 */
  }
  return url;
}

globalThis.__beaconParse = function () {
  const m = location.pathname.match(/\/user\/profile\/([0-9a-zA-Z]+)/);
  if (!m) return null;
  const handle = m[1];
  const parseCount = globalThis.__beaconParseCount;

  const name =
    document.querySelector('.user-name')?.textContent?.trim() ||
    document.querySelector('.name-detail')?.textContent?.trim() ||
    undefined;

  // 粉丝数：互动统计区「关注 / 粉丝 / 获赞与收藏」。走 common.js 的共用内核。
  //
  // ⚠️ 老代码有两个坑，都是「采错」而不是「少采」：
  //   ① `parseCount(t.replace('粉丝',''))` —— **replace 不是截断**。三项挨着时
  //      「关注 12 粉丝 3.4万」被抠成「关注 12  3.4万」，parseCount 取第一个数字 →
  //      **关注数当粉丝数**（抖音 07-29 修过同一个坑，这里一直活着）。
  //   ② selector 写成 `.user-interactions div, …, div, span` 看着是「容器优先」，
  //      但 querySelectorAll **按文档序返回**、不按 selector 顺序——容器根本没起到优先作用，
  //      页面顶部登录态里自己的「粉丝 N」照样能排在前面。容器约束要靠内核的 scopes 参数。
  const xhsStats = globalThis.__beaconReadStats?.(
    [
      { key: 'following', labels: ['关注'] },
      { key: 'followers', labels: ['粉丝'] },
      { key: 'likes', labels: ['获赞与收藏', '获赞'] },
    ],
    ['.user-interactions', '.user-info', '.user-page', '#userPageContainer'],
  ) || { values: {}, via: {} };
  const followers = xhsStats.values.followers;

  // 笔记：note-item 卡片 → /explore/<id> 锚点 + 标题 + 点赞数
  const seen = new Set();
  const posts = [];
  const cards = document.querySelectorAll('section.note-item, .note-item, section');
  for (const card of cards) {
    const a = card.querySelector('a[href*="/explore/"]') ?? card.querySelector('a[href*="/discovery/item/"]');
    if (!a) continue;
    const idm = a.href.match(/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/);
    if (!idm || seen.has(idm[1])) continue;
    seen.add(idm[1]);
    const title = (card.querySelector('.title')?.textContent || card.querySelector('a .title span')?.textContent || '').trim();
    const likes = parseCount(card.querySelector('.count')?.textContent);
    posts.push({
      platformItemId: idm[1],
      title: title.slice(0, 300),
      url: xhsNoteUrl(a.href, idm[1]),
      ...(likes != null ? { metrics: { likes } } : {}),
    });
    if (posts.length >= (globalThis.__beaconPostCap || 30)) break; // 上限见 common.js BEACON_POST_CAP
  }

  // 只在**认出来**时才带这个字段（认不出就不带，而不是带 false）。
  // popup / SidePanel / 页内侧栏 拿它决定「这是我的作品」是直接回填、还是先要用户再点一次确认。
  // 本人主页才有「编辑资料」；别人的主页是「关注 / 发私信」（判定见 common.js beaconLooksLikeSelf）
  const isSelf = globalThis.beaconLooksLikeSelf?.(['编辑资料', '编辑个人资料'], '.user-info, .user-page, #userPageContainer');

  return {
    platform: 'xiaohongshu',
    handle,
    profile: { name, followers, followersVia: xhsStats.via.followers || 'none' },
    posts,
    ...(isSelf ? { isSelf: true } : {}),
  };
};
