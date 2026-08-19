// X (Twitter) 采集：用户主页（x.com/<用户名>）+ 推文详情页（x.com/<用户名>/status/<id>）。
// x.com React SPA，DOM 用相对稳的 data-testid；多重回退，失效时少采几项不报错。
// ⚠️ x.com 国内被墙——需你自己挂 VPN 且登录 X 浏览竞对主页时采（和 B站/抖音同一套访问即采）。
//
// 只收**本竞对自己**的推文：每条推文的 status 链接里带作者名，作者≠主页用户名的（转推/他人回复）跳过。
// 指标从推文操作栏 [role=group] 的 aria-label 里解析（形如 "N replies, N reposts, N likes, N views"）。
//
// 【X 没有「创作者后台」——自有数据就在你自己的主页上】
// 别的平台自有数据要去 creator.douyin.com / mp.weixin.qq.com 这类独立域名的后台读（self-backend.js），
// X 不存在这样一个域名：浏览量（views）在 X 上对所有人公开，你自己那条推的数字，
// 和竞对那条推的数字，在同一个 DOM 位置、同一个 aria-label 里。
// 所以这个解析器**一份产出喂两条通道**：加为竞对走 /api/ingest/competitor，
// 「这是我的作品」走 /api/ingest/self——区别只在用户点了哪个按钮。
// 正因为区别只在按钮上，下面的 isSelf 才重要：它是唯一能挡住「把竞对的推文当成自己作品回填」的信号。

const X_RESERVED = new Set([
  'home', 'search', 'explore', 'notifications', 'messages', 'i', 'settings',
  'compose', 'hashtag', 'about', 'tos', 'privacy', 'login', 'signup',
]);

// 各项指标。**先读按钮、再读 aria-label**，顺序不能反。
//
// ⚠️ 真机 2026-07-27：中文界面下 6 条推文一个指标都没读到，后端全部跳过（一条都没入库）。
// 原因是此前只从 [role=group] 的 aria-label 里按英文词抠数字（repl / like / view）——
// 那串是**会被翻译的**：中文 X 上写的是「回复」「转帖」「喜欢」「查看」，一个都匹配不上。
// 按钮上的 data-testid（reply / retweet / like）不翻译，数字就在按钮里，这才是稳的那一层。
// 大数字在中文界面是「1.2万」，__beaconParseCount 认得万/亿，不用另做处理。
//
// ⚠️ 真机 2026-08-10：按钮**可见文本是四舍五入的**（「217万」），而同一颗按钮的
// aria-label 里是精确值（"2174478 喜欢次数。喜欢"）。此前先读可见文本、aria 只当兜底，
// 于是点赞入库成 2,170,000 —— 差 4478 还在其次，要命的是这个数**不会动**：
// 涨到 2,179,999 之前显示都是「217万」，两次采集永远相等，增速/趋势那一套直接废掉。
// 所以顺序必须是 **aria 优先、可见文本兜底**（aria 缺失或读不出来时才退回去）。
function xCountFromButton(el, pc, words) {
  if (!el) return undefined;
  // ① aria-label 里的精确值（按钮自己的标签，比 [role=group] 那条整体标签更贴身）
  if (words) {
    const exact = xCountFromLabel(el.getAttribute('aria-label') || '', words, pc);
    if (exact != null) return exact;
  }
  // ② 数字在按钮内部的计数容器里；容器没了就退回按钮全文（里面除了数字没有别的可读文本）
  const text = el.querySelector('[data-testid="app-text-transition-container"]')?.textContent ?? el.textContent;
  return pc(text);
}

// aria-label 兜底：按钮层没读到时才用。两种语言的词都列上，
// 且数字在词前（"1202 views" / "1202 次查看"）与词后（"查看 1202"）都认。
const X_LABEL_WORDS = {
  comments: ['repl', '回复'],
  shares: ['repost', 'retweet', '转帖', '转推'],
  likes: ['like', '喜欢'],
  views: ['view', '查看', '浏览'],
  // 书签数：X 现在把它摆在操作栏里且**对所有人可见**（真机 2026-08-10 实测 8249）。
  // 语义上最接近「收藏」，映射到 collects。此前整项没采。
  // ⚠️ 'bookmark' 要放在 views 的 'view' 之后无所谓，但两者的词不重叠，不会互相误命中。
  collects: ['bookmark', '书签', '收藏'],
};
function xCountFromLabel(label, words, pc) {
  for (const w of words) {
    // 数字在前："1,202 次查看" / "1202 views"（中间可能夹量词 次/条/个/人）
    let m = label.match(new RegExp(`([\\d,.]+\\s*[kKmMbB万亿]?)\\s*(?:次|条|个|人)?\\s*${w}`, 'i'));
    // 数字在后："查看 1202" / "喜欢：12"
    if (!m) m = label.match(new RegExp(`${w}\\s*[:：]?\\s*([\\d,.]+\\s*[kKmMbB万亿]?)`, 'i'));
    if (m) {
      const n = pc(m[1]);
      if (n != null) return n;
    }
  }
  return undefined;
}

function xMetricsFromGroup(group, pc) {
  const metrics = {};
  if (!group) return metrics;

  // ① 按钮层（不随语言变）
  // 每项都把自己的词表传进去 —— 按钮 aria-label 里是精确值，可见文本是「217万」这种缩写
  const W = X_LABEL_WORDS;
  const found = {
    comments: xCountFromButton(group.querySelector('[data-testid="reply"]'), pc, W.comments),
    shares: xCountFromButton(group.querySelector('[data-testid="retweet"], [data-testid="unretweet"]'), pc, W.shares),
    likes: xCountFromButton(group.querySelector('[data-testid="like"], [data-testid="unlike"]'), pc, W.likes),
    collects: xCountFromButton(group.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]'), pc, W.collects),
    // 浏览量没有自己的 testid，它是那条指向 /analytics 的链接。
    // ⚠️ 真机 2026-08-10：推文详情页上这条链接**已经不存在**，页脚只有 回复/转帖/喜欢/书签。
    // 取不到就是取不到，让它保持 undefined —— 下游 hasViews() 会判成「不知道」而不是「零浏览」。
    views: xCountFromButton(group.querySelector('a[href*="/analytics"]'), pc, W.views),
  };

  // ② aria-label 兜底：只补按钮层没给出的那几项
  const label = group.getAttribute('aria-label') || '';
  if (label) {
    for (const key of Object.keys(X_LABEL_WORDS)) {
      if (found[key] == null) found[key] = xCountFromLabel(label, X_LABEL_WORDS[key], pc);
    }
  }

  for (const key of Object.keys(found)) {
    if (found[key] != null) metrics[key] = found[key];
  }
  return metrics;
}

// 「这一页是我自己的号吗？」
// X 只对**作者本人**露出两个入口：主页上的「编辑资料」，自己推文操作栏里的「查看帖子数据」
// （链接形如 /<handle>/status/<id>/analytics）。别人的主页/推文上这两样都没有。
//
// ⚠️ 只认阳性信号，认不出时返回 undefined（「不确定」），**绝不返回 false**。
// X 改版会让 data-testid 失效，那时正确的退路是「让用户自己确认一次」，
// 而不是一口咬定「这不是你的号」——后者会把一个能用的功能变成永远打不开的门。
function xLooksLikeSelfProfile() {
  // 「你可能感兴趣的人」模块里全是别人的关注按钮，只在主列里找，别被右栏带偏
  const col = document.querySelector('[data-testid="primaryColumn"]') || document;
  return !!col.querySelector('[data-testid="editProfileButton"], a[href="/settings/profile"]');
}
function xTweetLooksLikeSelf(art) {
  return !!art.querySelector('a[href$="/analytics"], [data-testid="analyticsButton"]');
}

// 无正文推文（纯图 / 纯视频 / 投票）的标题。
//
// 【为什么不能都叫「(无正文)」】标题是这条作品在烽火台里的**身份**：
//   · 数据页一整列都是「(无正文)」，用户认不出哪条是哪条；
//   · 复盘与 AI 点评会引用标题，「《(无正文)》播放 1211」等于什么都没说；
//   · 最实际的是 lib/insight/health-check.ts 按标题查重（≥4 字才参与判定），
//     「(无正文)」正好 5 字 —— 两条纯图推文就会被误报成「重复内容」。
//
// 所以退而求其次，给一个**能认出来、且互不相同**的标题：媒体类型 + 日期 + 推文 ID 尾号。
// 不带图片张数之类会随懒加载变化的信息 —— 标题要在多次采集之间稳定，否则每采一次就改一次名。
function xFallbackTitle(art, id, datetime) {
  let kind = '无正文';
  if (art.querySelector('[data-testid="tweetPhoto"]')) kind = '图片';
  else if (art.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')) kind = '视频';
  else if (art.querySelector('[data-testid="cardPoll"]')) kind = '投票';
  else if (art.querySelector('[data-testid="card.wrapper"]')) kind = '链接卡片';
  const day = /^\d{4}-\d{2}-\d{2}/.test(datetime || '') ? ` ${datetime.slice(5, 10)}` : '';
  return `[${kind}]${day} #${String(id).slice(-4)}`;
}

globalThis.__beaconParse = function () {
  const segs = location.pathname.split('/').filter(Boolean);
  const handle = segs[0];
  if (!handle || X_RESERVED.has(handle.toLowerCase())) return null;
  const pc = globalThis.__beaconParseCount;
  const isStatus = segs[1] === 'status' && /^\d+$/.test(segs[2] || '');

  // 主页头部：显示名 + 粉丝数（详情页没有，profile 留空）
  let name;
  let followers;
  let followersVia = 'none';
  if (!isStatus) {
    name =
      document.querySelector('[data-testid="UserName"] span span')?.textContent?.trim() ||
      document.querySelector('[data-testid="UserName"] span')?.textContent?.trim() ||
      undefined;
    // 锚点是**链接地址**（/<user>/followers），不是 class —— X 的 class 是构建期哈希，
    // 但这个路径是产品语义，比任何埋点都稳。所以 X 这条不受改版影响，via 记 'href'。
    //
    // ⚠️ `/followers` 与 `/verified_followers` 必须**分两趟**取，不能写成一个逗号 selector：
    // querySelectorAll 按**文档序**返回而不是按 selector 顺序，谁在 DOM 里排前面就是谁——
    // 而「认证粉丝数」比总粉丝数小一个量级（同 xhs.js 那个「容器优先其实没生效」的坑）。
    for (const sel of ['a[href$="/followers"]', 'a[href$="/verified_followers"]']) {
      for (const a of document.querySelectorAll(sel)) {
        const n = pc(a.textContent);
        if (n != null && n > 0) { followers = n; followersVia = 'href'; break; }
      }
      if (followers != null) break;
    }
    // 链接都不在了（改版/未登录）才退到文本锚点。X 是数字在前的版式（「1,234 Followers」），
    // 中英文都列：界面语言跟着账号走（真机 2026-07-27 就因为只列英文，6 条指标全没读到）。
    if (followers == null) {
      const s = globalThis.__beaconReadStats?.(
        [
          { key: 'following', labels: ['Following', '正在关注', '关注中'] },
          { key: 'followers', labels: ['Followers', '关注者', '粉丝'] },
        ],
        ['[data-testid="primaryColumn"]', 'main'],
      ) || { values: {}, via: {} };
      followers = s.values.followers;
      followersVia = s.via.followers || 'none';
    }
  }

  // 推文：遍历所有 article，取本竞对自己的
  const seen = new Set();
  const posts = [];
  let selfTweets = 0;
  for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
    const link = art.querySelector('a[href*="/status/"]');
    const m = link && link.href.match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
    if (!m) continue;
    const author = m[1];
    const id = m[2];
    if (author.toLowerCase() !== handle.toLowerCase()) continue; // 非本竞对（转推/回复）跳过
    if (seen.has(id)) continue;
    seen.add(id);
    const text = (art.querySelector('[data-testid="tweetText"]')?.textContent || '').trim();
    // ⚠️ 选 [role=group] 时**不能再要求带 aria-label**：指标现在主要从按钮上读，
    // 而操作栏并不总有 aria-label（X 改版、或本来就没标）。要求它 = 把按钮那一层整个跳过，
    // 退回到「一个指标都读不到」的老毛病上。取不到操作栏就退回整条推文。
    const metrics = xMetricsFromGroup(art.querySelector('[role="group"]') || art, pc);
    // 发表时间：推文头部的 <time datetime="2026-07-27T…">。不带它的话，自有通道会把
    // 每条记录的 publishedAt 填成「回填当天」——发布时段分析按小时分组，全是回填那一刻的时辰，
    // 趋势图的「发布后第 N 天」也跟着全错（见 lib/ingest/own-post.ts 的 fillDate）。
    const dt = art.querySelector('time[datetime]')?.getAttribute('datetime');
    if (xTweetLooksLikeSelf(art)) selfTweets += 1;
    posts.push({
      platformItemId: id,
      title: text.slice(0, 300) || xFallbackTitle(art, id, dt),
      url: `https://x.com/${handle}/status/${id}`,
      ...(dt ? { publishedAt: dt } : {}),
      ...(Object.keys(metrics).length ? { metrics } : {}),
    });
    if (posts.length >= (globalThis.__beaconPostCap || 30)) break; // 上限见 common.js BEACON_POST_CAP
  }

  // 只在**认出来**时才带这个字段（认不出就不带，而不是带 false）。
  // popup / SidePanel 拿它决定「这是我的作品」是直接回填、还是先要用户再点一次确认。
  const isSelf = xLooksLikeSelfProfile() || selfTweets > 0 ? true : undefined;

  return {
    platform: 'x',
    handle,
    profile: !isStatus && (name || followers != null) ? { name, followers, followersVia } : undefined,
    posts,
    ...(isSelf ? { isSelf } : {}),
  };
};
