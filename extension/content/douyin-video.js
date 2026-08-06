// 抖音视频详情页解析（www.douyin.com/video/<id>）——采集单条作品的完整互动指标。
// ⚠️ 抖音改版频繁、且详情页 DOM 未当场实测校准：优先用相对稳定的 data-e2e 埋点，逐层回退，
//    取不到就少采几项（合并式入库，不覆盖已有、不报错）。真实失效时按此文件调选择器即可。

// ⚠️ **必须接力，不能直接覆盖 __beaconParse**。
// manifest 里 douyin.js（主页）与本文件（作品页）是**同一条 content_scripts 规则**的第 2、3 个脚本，
// 两个 URL 形态共用一份注入列表；数组按序执行，所以本文件永远后跑。
// 老代码在这里直接 `globalThis.__beaconParse = …`，于是**在 /user/ 主页上主页解析器整个变成死代码**：
// 覆盖后的解析器一看路径不是 /video/ 就返回 null → common.js 退回 beaconFallbackParse →
// 得到「1 条以 sec_user_id 为作品 ID、没有任何指标、作者名写着『小红书/社交创作者』的假作品」，
// 后端因为一个指标都没有直接跳过 —— 用户看到的现象就是「抖音主页采不全 / 采到 0 条」。
// B站空间页、小红书主页有一模一样的结构，同样修法（bili-video.js / xhs-note.js）。
// 回归测试：tests/ingest/parser-chain.test.ts。
const __beaconPrevParse = typeof globalThis.__beaconParse === 'function' ? globalThis.__beaconParse : null;

// 「这条 /user/ 链接是**本条作品的作者**吗？」
//
// 老代码是 `document.querySelector('a[href*="/user/"]')` —— 取全页第一条。作品页上这一条
// 很可能来自**评论区的评论者**或**右侧推荐位的其他作者**：抖音的评论区就在同一个文档里，
// 且往往比作者信息更早出现在 DOM 顺序里。那样采到的这条作品会被挂到**别人**名下，
// 是「张冠李戴」而不是「少采一项」——同 lib/adapters/competitor-real.ts idOrNull 的铁律。
// 所以：先在作者/详情容器里找；找不到再退回全页，但把评论区与推荐位里的链接排掉。
const DY_AUTHOR_SCOPES = [
  '[data-e2e="video-detail"]',
  '[data-e2e="video-author"]',
  '[data-e2e="user-info"]',
  '[data-e2e="video-player-info"]',
  '.video-info-detail',
  '#sliderVideo',
];
const DY_NOT_AUTHOR = [
  '[data-e2e="comment-list"]',
  '[data-e2e="video-comment"]',
  '[data-e2e="comment-item"]',
  '[data-e2e="recommend-list"]',
  '[data-e2e="related-video-card"]',
  '[data-e2e="feed-comment"]',
];
function dyInExcluded(el) {
  for (const sel of DY_NOT_AUTHOR) {
    try { if (el.closest(sel)) return true; } catch { /* 选择器不被支持则忽略 */ }
  }
  return false;
}
function dyAuthorLink() {
  for (const scope of DY_AUTHOR_SCOPES) {
    const root = document.querySelector(scope);
    const a = root && root.querySelector('a[href*="/user/"]');
    if (a && !dyInExcluded(a)) return a;
  }
  for (const a of document.querySelectorAll('a[href*="/user/"]')) {
    if (!dyInExcluded(a)) return a;
  }
  return null;
}

// 发布时间。**只认绝对日期**（2026-07-29 / 2026年7月29日）：
// 「3天前」这类相对时间算得出来，但算出来的是个到不了小时的近似值，而 publishedAt 恰恰
// 被「发布时段分析」按小时分组用 —— 与其塞一个精度假装够用的值，不如不给（不给时
// lib/ingest/own-post.ts 有自己的处理）。绝不拿「今天」凑数：那会把发布时间写成回填当天。
const DY_DATE = /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/;
function dyPublishedAt(scopeEl) {
  const text = (scopeEl || document.body)?.textContent || '';
  const m = text.match(DY_DATE);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : undefined;
}

globalThis.__beaconParse = function () {
  const m = location.pathname.match(/\/video\/(\d+)/);
  if (!m) return __beaconPrevParse ? __beaconPrevParse() : null;
  const id = m[1];
  const pc = globalThis.__beaconParseCount;

  // 作者 sec_uid（归属竞对）
  const authorLink = dyAuthorLink();
  const handle = authorLink && (authorLink.href.match(/\/user\/([\w-]+)/) || [])[1];
  if (!handle) return null;

  // 作者昵称。缺了它，服务端建档时 `name: profile?.name || handle` 会拿 **sec_user_id**
  // 当账号名——那是一串 55 位的不透明字符串，竞对清单里根本认不出是谁
  //（YouTube 真机 2026-07-28 踩过同一个坑，那边至少还是个 @handle）。
  const nick = (
    authorLink.getAttribute('title')
    || document.querySelector('[data-e2e="video-author-nickname"], [data-e2e="user-name"]')?.textContent
    || authorLink.textContent
    || ''
  ).trim().replace(/^@/, '');

  const title = (
    document.querySelector('[data-e2e="video-desc"]')?.textContent ||
    document.querySelector('h1, .title')?.textContent ||
    ''
  ).trim();

  const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
  const metrics = {};
  const set = (k, v) => { const n = pc(v); if (n != null && n >= 0) metrics[k] = n; };
  set('likes', txt('[data-e2e="video-player-digg-count"]') || txt('[data-e2e="like-count"]'));
  set('comments', txt('[data-e2e="video-player-comment"]') || txt('[data-e2e="comment-count"]') || txt('[data-e2e="comment-icon"] + *'));
  set('collects', txt('[data-e2e="video-player-collect-count"]') || txt('[data-e2e="collect-count"]'));
  set('shares', txt('[data-e2e="video-player-share-count"]') || txt('[data-e2e="share-count"]'));

  // 发布时间在作者信息区（评论区里也全是日期，所以必须限定范围再找）
  const publishedAt = dyPublishedAt(
    document.querySelector('[data-e2e="video-desc"]')?.parentElement
    || document.querySelector(DY_AUTHOR_SCOPES.join(',')),
  );

  return {
    platform: 'douyin',
    handle,
    ...(nick ? { profile: { name: nick.slice(0, 100) } } : {}),
    posts: [{
      platformItemId: id,
      // 标题是这条作品在烽火台里的身份：空标题会让数据页整列认不出是哪条，
      // 还会被 lib/insight/health-check.ts 的标题查重当成「重复内容」误报（同 content/x.js 的教训）。
      title: title.slice(0, 300) || `[作品] #${id.slice(-4)}`,
      url: `https://www.douyin.com/video/${id}`,
      ...(publishedAt ? { publishedAt } : {}),
      ...(Object.keys(metrics).length ? { metrics } : {}),
    }],
  };
};
