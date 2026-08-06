// 发布链接解析（PRD §6 F7-1 AC①：四平台发布链接解析成功率 ≥95%）。
// 把用户粘贴的发布链接解析成 { platform, platformItemId }。
//
// platformItemId 不是装饰字段——lib/jobs/handlers.ts 的 backfill_metrics 用
//   where: { platformItemId: { not: null } }
// 挑出待回流记录，再拿它去 byId.get(...) 匹配适配器拉回的作品列表。所以这里产出的 ID
// 必须与 lib/adapters/competitor-real.ts 各适配器 normalize 出的 platformItemId **同口径**：
//   douyin      → aweme_id（纯数字，TikHubAdapter: it.aweme_id）
//   xiaohongshu → note_id（24 位十六进制，TikHubAdapter: it.note_id）
//   bilibili    → bvid（BV + 10 位，BilibiliAdapter: v.bvid）
//   x           → tweet id（纯数字，TwitterApiAdapter: t.id）
//   youtube     → videoId（11 位，YouTubeAdapter: contentDetails.videoId）
//   tiktok      → aweme_id（纯数字，与抖音同族但**不同平台**，见 lib/constants.ts 的说明）
//   wechat      → 文章 URL 本身（NewRankAdapter 用 a.url 当 ID，见 parseWechat 的说明）
//   shipinhao   → 作品 export id（无官方适配器，唯一回流通道是插件读创作者后台，见 parseShipinhao）
//
// 两条铁律：
// 1. **纯函数、零网络**。短链（v.douyin.com / xhslink.com / t.co / 不含 BV 的 b23.tv）不发请求
//    去跟随跳转——那会让解析变成有副作用的 IO，且把用户的分享链接暴露给第三方。诚实降级：
//    告诉用户贴作品详情页的完整链接。
// 2. **认不出就返回失败，绝不猜**。猜错的 ID 会让回流去拉**别人的作品数据**，
//    比「没认出来」严重得多——后者用户能补救，前者用户看到的是一条以假乱真的脏数据。

import type { PlatformKey } from '@/lib/constants';

export type ParseFailReason =
  | 'empty' // 没填
  | 'no-url' // 不是链接
  | 'shortlink' // 认出平台了，但短链不解析跳转拿不到 ID
  | 'unknown-host' // 不是多平台的域名
  | 'no-item-id'; // 是该平台的链接，但这个页面里没有作品 ID（如个人主页）

export type ParsedPublish = {
  ok: true;
  platform: PlatformKey;
  platformItemId: string;
  /** 规范化后的作品详情页链接（去掉追踪参数），仅供展示/留档 */
  canonicalUrl: string;
};

export type ParseFailure = {
  ok: false;
  reason: ParseFailReason;
  /** 认出了平台但没认出作品 ID 时带上，UI 可据此预选平台 */
  platform?: PlatformKey;
  /** 面向用户的中文提示，直接可展示 */
  message: string;
};

export type ParseResult = ParsedPublish | ParseFailure;

// ── ID 形态（宽松到能容下历史 ID，严格到不会把用户名/栏目名当 ID）──
const DOUYIN_ID = /^\d{6,25}$/; // aweme_id，现役 19 位，早期作品更短
const TIKTOK_ID = /^\d{6,25}$/; // 同为字节的 item_id，形态与抖音一致；平台靠域名分，不靠 ID 形态分
const XHS_ID = /^[0-9a-f]{24}$/i; // note_id，MongoDB ObjectId 形态
const BILI_BV = /^BV[0-9A-Za-z]{10}$/; // bvid 定长
const BILI_AV = /^av\d+$/i;
// 推文 id。**不设下限**：现役是 19 位 snowflake，但 2006 年的早期推文是短的顺序整数
// （@jack 的第一条就是 /status/20）。这里的定位靠 path 上的 status/ 锚点，不靠长度，
// 加个下限只会误杀老推文——测试里那条 /status/20 就是这么被抓出来的。
const X_ID = /^\d{1,25}$/;
const YT_ID = /^[A-Za-z0-9_-]{11}$/; // videoId 定长 11
const WX_TOKEN = /^[A-Za-z0-9_-]{10,64}$/; // /s/<token> 的 token
// 视频号作品 id（export_id / objectId）：不透明的 base64url 串，长度随版本浮动，
// 只约束字符集与长度区间——收得太紧会误杀，收得太松会把栏目名当 ID。
const SPH_ID = /^[A-Za-z0-9_=-]{8,128}$/;

function ok(platform: PlatformKey, platformItemId: string, canonicalUrl: string): ParsedPublish {
  return { ok: true, platform, platformItemId, canonicalUrl };
}
function fail(reason: ParseFailReason, message: string, platform?: PlatformKey): ParseFailure {
  return { ok: false, reason, platform, message };
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>，,。；;、】）)]+/i;

// 从「7.86 复制打开抖音，看看【xxx】 https://... 复制此链接」这类分享口令里抠出链接。
// 也接受用户从地址栏直接拷的无协议裸链（www.douyin.com/video/123）。
function extractUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text) return null;
  const m = text.match(URL_IN_TEXT);
  let candidate = m ? m[0] : text.split(/\s+/)[0];
  if (!/^https?:\/\//i.test(candidate)) {
    // 必须长得像 host/path，否则「随便一句话」会被 new URL('https://'+它) 意外接受
    if (!/^[\w.-]+\.[a-z]{2,}([/?#]|$)/i.test(candidate)) return null;
    candidate = 'https://' + candidate;
  }
  try {
    const u = new URL(candidate);
    // 只认 http(s)：javascript: / data: 之类不该走到这
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

function normHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}

function pathSegs(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

// 短链域名 → 平台。ID 藏在跳转目标里，不发网络请求就是拿不到，只能诚实降级。
// 注意 youtu.be 不在此列：它的 ID 就明写在 path 里，不需要跟随跳转。
const SHORTLINK_HOSTS: Record<string, PlatformKey> = {
  'v.douyin.com': 'douyin',
  'xhslink.com': 'xiaohongshu',
  'b23.tv': 'bilibili', // b23.tv/BV1xx… 能直接解析，opaque 短码不能
  't.co': 'x',
  'vm.tiktok.com': 'tiktok',
  'vt.tiktok.com': 'tiktok',
};

function hostPlatform(host: string): PlatformKey | null {
  const short = SHORTLINK_HOSTS[host];
  if (short) return short;
  if (host === 'douyin.com' || host.endsWith('.douyin.com')) return 'douyin';
  if (host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com')) return 'douyin';
  if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com')) return 'xiaohongshu';
  if (host === 'xhscdn.com' || host.endsWith('.xhscdn.com')) return 'xiaohongshu';
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  if (host === 'mp.weixin.qq.com') return 'wechat';
  // 视频号：创作者后台与网页版分享链都在 channels.weixin.qq.com。
  // 必须放在 wechat 之后单独判：同为 *.weixin.qq.com，但两个平台的 ID 口径完全不同。
  if (host === 'channels.weixin.qq.com') return 'shipinhao';
  if (host === 'x.com' || host.endsWith('.x.com')) return 'x';
  if (host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'youtu.be') return 'youtube';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  return null;
}

// ── 抖音：/video/<id>、/note/<id>（图文）、iesdouyin /share/video/<id>、
//    个人页与发现页的作品浮层（?modal_id=）、播放器嵌入码（?vid=）──
function parseDouyin(u: URL): ParseResult {
  const segs = pathSegs(u);
  const i = segs.findIndex((s) => s === 'video' || s === 'note' || s === 'slides');
  let id = i >= 0 ? segs[i + 1] : undefined;
  if (!id) id = u.searchParams.get('modal_id') ?? undefined;
  if (!id) id = u.searchParams.get('vid') ?? undefined;
  if (id && DOUYIN_ID.test(id)) return ok('douyin', id, `https://www.douyin.com/video/${id}`);
  return fail('no-item-id', '这是抖音的链接，但没认出作品 ID。请贴作品详情页的完整链接（形如 https://www.douyin.com/video/7123456789012345678）。', 'douyin');
}

// ── 小红书：/explore/<id>、/discovery/item/<id>、/user/profile/<uid>/<noteId> ──
// 注意 /user/profile/ 下 uid 与 noteId 同为 24 位十六进制，必须靠**位置**区分，不能靠形态。
function parseXiaohongshu(u: URL): ParseResult {
  const segs = pathSegs(u);
  let id: string | undefined;
  if (segs[0] === 'explore' && segs[1]) id = segs[1];
  else if (segs[0] === 'discovery' && segs[1] === 'item' && segs[2]) id = segs[2];
  else if (segs[0] === 'user' && segs[1] === 'profile' && segs[3]) id = segs[3];
  if (id && XHS_ID.test(id)) {
    // canonical 刻意不带 xsec_token：那是登录态访问票据，不是作品身份的一部分，
    // 也不该跟着发布记录留档。回流靠 note_id 匹配，不靠这个链接能不能打开。
    return ok('xiaohongshu', id, `https://www.xiaohongshu.com/explore/${id}`);
  }
  return fail('no-item-id', '这是小红书的链接，但没认出笔记 ID。请贴笔记详情页的完整链接（形如 https://www.xiaohongshu.com/explore/65a1b2c3000000001e03a1b2）。', 'xiaohongshu');
}

// ── B站：/video/BV…、?bvid=BV…、b23.tv/BV… ──
function parseBilibili(u: URL): ParseResult {
  const segs = pathSegs(u);
  const i = segs.indexOf('video');
  let id = i >= 0 ? segs[i + 1] : undefined;
  if (!id) id = u.searchParams.get('bvid') ?? undefined;
  if (!id && segs.length === 1) id = segs[0]; // b23.tv/BV1xx411c7mD
  if (id && BILI_BV.test(id)) return ok('bilibili', id, `https://www.bilibili.com/video/${id}`);
  if (id && BILI_AV.test(id)) {
    // av→BV 是可逆算法，但它依赖一张 base58 码表 + 异或常量。这里**不实现**：
    // 码表记错一位会算出一个「合法但属于别人」的 BV，回流就会去拉别人的数据——
    // 正是「猜错比认不出更糟」。让用户贴 BV 链接，一秒的事。
    return fail('no-item-id', '这是 av 号链接，暂不支持。请打开作品页，贴地址栏里的 BV 号链接（形如 https://www.bilibili.com/video/BV1xx411c7mD）。', 'bilibili');
  }
  return fail('no-item-id', '这是 B站 的链接，但没认出稿件 ID。请贴视频详情页的完整链接（形如 https://www.bilibili.com/video/BV1xx411c7mD）。', 'bilibili');
}

// ── 公众号：mp.weixin.qq.com/s/<token> 或 /s?__biz=..&mid=..&idx=..&sn=.. ──
// 公众号文章没有平台级数字 ID，URL 本身就是身份；NewRankAdapter 也是拿 a.url 当
// platformItemId 的，故这里存规范化后的 URL，与适配器保持同口径。
// ⚠️ 已知风险：能否匹配上取决于新榜返回的 url 与此处规范化结果**逐字符相同**，
// 无真实 key 无法验证。见返回说明中的「未覆盖形态」。
function parseWechat(u: URL): ParseResult {
  const segs = pathSegs(u);
  if (segs[0] === 's') {
    if (segs[1] && WX_TOKEN.test(segs[1])) {
      const canonical = `https://mp.weixin.qq.com/s/${segs[1]}`;
      return ok('wechat', canonical, canonical);
    }
    const biz = u.searchParams.get('__biz');
    const mid = u.searchParams.get('mid');
    const idx = u.searchParams.get('idx');
    const sn = u.searchParams.get('sn');
    // 四件套齐了才是一篇确定的文章；缺任何一个都定位不到，不猜。
    // chksm / scene / srcid 等是分享追踪参数，规范化时丢弃。
    if (biz && mid && idx && sn) {
      const canonical = `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=${idx}&sn=${sn}`;
      return ok('wechat', canonical, canonical);
    }
  }
  return fail('no-item-id', '这是公众号的链接，但没认出文章 ID。请贴文章正文页的完整链接（形如 https://mp.weixin.qq.com/s/AbCdEf...）。', 'wechat');
}

// ── 视频号：channels.weixin.qq.com ──
//   网页版分享链   /web/pages/feed?eid=<export_id>
//   创作者后台     /platform/post/detail?objectId=<id>&objectNonceId=<nonce>
//
// 口径：取 URL 上的作品 id 原值（eid / exportId / export_id / objectId / object_id），
// 插件（extension/content/self-backend.js）从创作者后台读到的同名字段原样回传，两边同口径。
//
// ⚠️ 已知限制，如实写在这里而不是假装没有：eid 与 objectId 是微信的**两套**标识，
// 同一条作品在分享链上给 eid、在后台给 objectId 时两者对不上。此时的后果是
// lib/ingest/own-post.ts 走「未命中 → 新建一条记录」，即同一作品可能出现两条——
// 是重复，不是张冠李戴（绝不会把 A 的数据挂到 B 上）。
// 之所以不选「猜一个映射把两者归一」：那正是本文件开头第 2 条铁律禁止的事。
//
// 视频号没有官方数据适配器（无开放 API），platformItemId 在这里唯一的用途就是
// 与插件回传对齐，不参与 backfill_metrics 的自动回流。
function parseShipinhao(u: URL): ParseResult {
  const id =
    u.searchParams.get('eid') ??
    u.searchParams.get('exportId') ??
    u.searchParams.get('export_id') ??
    u.searchParams.get('objectId') ??
    u.searchParams.get('object_id') ??
    undefined;
  if (id && SPH_ID.test(id)) {
    return ok('shipinhao', id, `https://channels.weixin.qq.com/web/pages/feed?eid=${id}`);
  }
  return fail(
    'no-item-id',
    '这是视频号的链接，但没认出作品 ID。请在视频号网页版打开这条作品后复制地址栏链接（形如 https://channels.weixin.qq.com/web/pages/feed?eid=...），个人主页链接里没有作品 ID。',
    'shipinhao',
  );
}

// ── X：/<user>/status/<id>、/i/web/status/<id>、/<user>/statuses/<id> ──
function parseX(u: URL): ParseResult {
  const segs = pathSegs(u);
  const i = segs.findIndex((s) => s === 'status' || s === 'statuses');
  const id = i >= 0 ? segs[i + 1] : undefined;
  if (id && X_ID.test(id)) return ok('x', id, `https://x.com/i/web/status/${id}`);
  return fail('no-item-id', '这是 X 的链接，但没认出推文 ID。请贴单条推文的完整链接（形如 https://x.com/someone/status/1712345678901234567）。', 'x');
}

// ── YouTube：/watch?v=、youtu.be/<id>、/shorts/<id>、/live/<id>、/embed/<id> ──
function parseYoutube(u: URL): ParseResult {
  const host = normHost(u.hostname);
  const segs = pathSegs(u);
  let id: string | undefined;
  if (host === 'youtu.be') {
    // youtu.be 是短链，但 ID 明写在 path 里，无需跟随跳转
    id = segs[0];
  } else {
    id = u.searchParams.get('v') ?? undefined;
    if (!id) {
      const i = segs.findIndex((s) => s === 'shorts' || s === 'live' || s === 'embed' || s === 'v');
      if (i >= 0) id = segs[i + 1];
    }
  }
  if (id && YT_ID.test(id)) return ok('youtube', id, `https://www.youtube.com/watch?v=${id}`);
  return fail('no-item-id', '这是 YouTube 的链接，但没认出视频 ID。请贴视频页的完整链接（形如 https://www.youtube.com/watch?v=dQw4w9WgXcQ）。', 'youtube');
}

// ── TikTok：/@<user>/video/<id>、/@<user>/photo/<id>（图文）、/embed/v2/<id>、/v/<id>.html（旧版）──
//
// 【为什么 canonicalUrl 有两种形态】
// TikTok 的作品详情页地址**必须带作者用户名**（/@user/video/<id>），而用户名不是作品身份的一部分——
// 换句话说：只有 ID 是拼不出详情页的。链接里带了作者就用详情页；没带（旧版 /v/、嵌入 /embed/）
// 就退到 TikTok 自己的嵌入播放页 /embed/v2/<id>。后者不好看，但它有一个决定性的好处：
// **只由 ID 决定**，所以它一定指向这条作品，绝不会指向别人的作品——正是文件头第 2 条铁律要的东西。
// publicItemUrl（只拿得到 ID）也走这一形态，两者因此仍互为逆运算。
function parseTiktok(u: URL): ParseResult {
  const segs = pathSegs(u);
  const author = (segs[0] || '').startsWith('@') ? segs[0].slice(1) : '';
  let id: string | undefined;
  const i = segs.findIndex((s) => s === 'video' || s === 'photo' || s === 'v');
  if (i >= 0 && segs[i + 1]) id = segs[i + 1].replace(/\.html$/i, ''); // 旧版 m.tiktok.com/v/<id>.html
  if (!id) {
    const e = segs.indexOf('embed');
    if (e >= 0) id = segs.find((s, k) => k > e && TIKTOK_ID.test(s)); // /embed/<id> 与 /embed/v2/<id>
  }
  if (id && TIKTOK_ID.test(id)) {
    return ok('tiktok', id, author ? `https://www.tiktok.com/@${author}/video/${id}` : `https://www.tiktok.com/embed/v2/${id}`);
  }
  return fail('no-item-id', '这是 TikTok 的链接，但没认出作品 ID。请贴作品详情页的完整链接（形如 https://www.tiktok.com/@someone/video/7123456789012345678），个人主页链接里没有作品 ID。', 'tiktok');
}

const PARSERS: Record<PlatformKey, (u: URL) => ParseResult> = {
  douyin: parseDouyin,
  xiaohongshu: parseXiaohongshu,
  bilibili: parseBilibili,
  wechat: parseWechat,
  shipinhao: parseShipinhao,
  x: parseX,
  youtube: parseYoutube,
  tiktok: parseTiktok,
};

const SHORTLINK_MSG: Record<PlatformKey, string> = {
  douyin: '这是抖音的分享短链，解析不出作品 ID（我们不会替你跟随跳转）。请在抖音里打开作品，用「复制链接」拿到 https://www.douyin.com/video/... 的完整链接再贴过来。',
  xiaohongshu: '这是小红书的分享短链，解析不出笔记 ID。请在小红书网页版打开笔记，贴 https://www.xiaohongshu.com/explore/... 的完整链接。',
  bilibili: '这是 B站 的分享短链，解析不出稿件 ID。请打开视频页，贴 https://www.bilibili.com/video/BV... 的完整链接。',
  x: '这是 t.co 短链，解析不出推文 ID。请打开推文，贴 https://x.com/.../status/... 的完整链接。',
  wechat: '这是短链，解析不出文章 ID。请贴 https://mp.weixin.qq.com/s/... 的完整链接。',
  // 视频号没有已知短链域名（不在 SHORTLINK_HOSTS 里），这条实际走不到，留着是为了让
  // Record<PlatformKey, …> 保持穷尽——漏一个平台就是编译期报错，而不是线上 undefined。
  shipinhao: '这是短链，解析不出作品 ID。请贴 https://channels.weixin.qq.com/web/pages/feed?eid=... 的完整链接。',
  youtube: '这是短链，解析不出视频 ID。请贴 https://www.youtube.com/watch?v=... 的完整链接。',
  tiktok: '这是 TikTok 的分享短链（vm./vt.tiktok.com），解析不出作品 ID（我们不会替你跟随跳转）。请在浏览器里打开这条作品，贴地址栏里 https://www.tiktok.com/@.../video/... 的完整链接。',
};

/**
 * 解析发布链接。**纯函数，不发任何网络请求。**
 * 认不出时返回 ok:false + 可直接展示给用户的中文 message，绝不返回猜出来的 ID。
 */
export function parsePublishUrl(raw: string): ParseResult {
  if (!raw || !raw.trim()) return fail('empty', '请粘贴发布链接。');
  const u = extractUrl(raw);
  if (!u) return fail('no-url', '没认出这是个链接，请贴作品详情页的完整链接（以 http:// 或 https:// 开头）。');

  const host = normHost(u.hostname);
  const platform = hostPlatform(host);
  if (!platform) {
    return fail('unknown-host', `没认出「${u.hostname}」这个站点。目前支持抖音 / 小红书 / B站 / 公众号 / 视频号 / X / YouTube / TikTok 的作品详情页链接。`);
  }

  const r = PARSERS[platform](u);
  if (r.ok) return r;
  // 短链域名上没抠出 ID → 是「短链不跟随跳转」而不是「链接有问题」，换个更准的说法
  if (SHORTLINK_HOSTS[host]) return fail('shortlink', SHORTLINK_MSG[platform], platform);
  return r;
}

/**
 * platformItemId → 作品详情页链接（parsePublishUrl 的**逆运算**，与各 parser 的 canonicalUrl 逐字符同形）。
 *
 * 为什么要有它：PublishRecord 里根本没有 url 列，`ingestOwnPostData` 收到插件回传的 `url`
 * 也是直接丢掉的——于是「回填进来的作品」在 /data 上永远只有一个标题，点不开、核对不了。
 * 与其加一列（还得为存量记录补数据），不如从 platformItemId 现算：
 * 每个平台的 ID 与详情页 URL 本来就是一一对应的，现算的好处是**存量记录立刻就有链接**。
 *
 * 铁律与本文件其它地方一致：**形态过不了校验就返回 null，绝不拼一个链接出来**——
 * 一个点开是 404 或指向别人作品的链接，比没有链接更糟。
 */
export function publicItemUrl(platform: string, platformItemId: string | null | undefined): string | null {
  const id = (platformItemId ?? '').trim();
  if (!id) return null;
  switch (platform) {
    case 'douyin':
      return DOUYIN_ID.test(id) ? `https://www.douyin.com/video/${id}` : null;
    case 'xiaohongshu':
      return XHS_ID.test(id) ? `https://www.xiaohongshu.com/explore/${id}` : null;
    case 'bilibili':
      return BILI_BV.test(id) ? `https://www.bilibili.com/video/${id}` : null;
    case 'x':
      return X_ID.test(id) ? `https://x.com/i/web/status/${id}` : null;
    case 'youtube':
      return YT_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
    // TikTok 详情页地址必须带作者用户名，而这里只有 ID——退到只由 ID 决定的嵌入播放页
    // （见 parseTiktok 的说明）。它一定是这条作品，不会指向别人的作品。
    case 'tiktok':
      return TIKTOK_ID.test(id) ? `https://www.tiktok.com/embed/v2/${id}` : null;
    case 'shipinhao':
      return SPH_ID.test(id) ? `https://channels.weixin.qq.com/web/pages/feed?eid=${id}` : null;
    // 公众号没有平台级数字 ID，规范化后的 URL 本身**就是** ID（见 parseWechat）。
    // 但不能原样信任：这个值可能是历史上手填进来的任意字符串，
    // 必须回过一遍 parsePublishUrl 确认它确实是一条公众号文章链接。
    case 'wechat': {
      const r = parsePublishUrl(id);
      return r.ok && r.platform === 'wechat' ? r.canonicalUrl : null;
    }
    default:
      return null;
  }
}

/**
 * 发布登记专用薄封装：解析 URL，并校验与用户所选平台是否一致。
 * 平台不一致时**不返回 ID**——把抖音的 aweme_id 挂到一条小红书记录上，
 * 回流会拿它去小红书的作品列表里匹配，匹配不上还算好的，匹配上了就是脏数据。
 */
export function resolvePlatformItemId(
  raw: string,
  selectedPlatform: string,
): { platformItemId: string | null; warning?: string } {
  const r = parsePublishUrl(raw);
  if (!r.ok) {
    return { platformItemId: null, warning: `${r.message}（已登记，但这条记录的数据自动回流将不可用，需手动回填）` };
  }
  if (r.platform !== selectedPlatform) {
    return {
      platformItemId: null,
      warning: `链接解析出的平台是「${r.platform}」，与所选平台「${selectedPlatform}」不一致，已忽略该链接（已登记，但这条记录的数据自动回流将不可用）。请确认平台选择或链接是否贴错。`,
    };
  }
  return { platformItemId: r.platformItemId };
}
