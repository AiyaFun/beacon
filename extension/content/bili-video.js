// B站视频详情页解析（www.bilibili.com/video/BV*）——采集单条作品的完整指标。
// 你点开竞对某条视频时（app 里作品标题可跳转到这里），插件顺手把这条的完整互动数据采下来。
//
// 实测校准 2026-07（真实页面 DOM）：工具栏
//   播放 .view.item(或 .view-text) · 弹幕 .dm.item(或 .dm-text)
//   点赞 .video-like-info · 投币 .video-coin-info · 收藏 .video-fav-info · 分享 .video-share-info-text
// 评论数在 <bili-comments> 组件的 shadow DOM 且懒加载，常取不到 → 省略（指标合并式入库：
// 缺项不覆盖已有值、不报错；用户点开视频本身已把播放/点赞/投币/收藏/分享一次采全）。

// ⚠️ **必须接力，不能直接覆盖 __beaconParse**——bilibili.js（空间页）与本文件在 manifest 里是
// 同一条 content_scripts 规则的第 2、3 个脚本，按序注入，本文件永远后跑。直接覆盖会让
// **空间页（space.bilibili.com/<mid>）的解析器整个变成死代码**，退回兜底解析后只得到一条假作品。
// 详见 douyin-video.js 顶部的完整说明；回归测试：tests/ingest/parser-chain.test.ts。
const __beaconPrevParse = typeof globalThis.__beaconParse === 'function' ? globalThis.__beaconParse : null;

globalThis.__beaconParse = function () {
  const bvm = location.pathname.match(/\/video\/(BV\w+)/);
  if (!bvm) return __beaconPrevParse ? __beaconPrevParse() : null;
  const bvid = bvm[1];
  const pc = globalThis.__beaconParseCount;

  // 作者 mid（用于把这条作品归属到对应竞对）
  const upLink = document.querySelector('a.up-name[href*="space.bilibili.com"], .up-info-container a[href*="space.bilibili.com"], a[href*="space.bilibili.com"]');
  const mid = upLink && (upLink.href.match(/space\.bilibili\.com\/(\d+)/) || [])[1];
  if (!mid) return null; // 拿不到作者 → 无法归属，放弃

  const title = (
    document.querySelector('h1.video-title, .video-title, h1[data-title]')?.getAttribute('data-title') ||
    document.querySelector('h1.video-title, .video-title, h1')?.textContent ||
    ''
  ).trim();
  const name = (upLink.textContent || '').trim() || undefined;

  const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
  const metrics = {};
  const set = (k, v) => { const n = pc(v); if (n != null && n >= 0) metrics[k] = n; };
  set('views', txt('.view.item') || txt('.view-text'));
  set('danmaku', txt('.dm.item') || txt('.dm-text'));
  set('likes', txt('.video-like-info'));
  set('coins', txt('.video-coin-info'));
  set('collects', txt('.video-fav-info'));
  set('shares', txt('.video-share-info-text'));
  // 评论数 best-effort：<bili-comments> shadow DOM，懒加载常为空，取不到就算了。
  //
  // ⚠️ 真机 2026-08-10：`bili-comments-header-renderer` 这个元素**已经不存在了**——
  // 现在 shadowRoot 第一层是 #spinner-container / #title / bili-comments-spinner / #continuations。
  // 只认那一条路径 = 评论数恒取不到（表现为「这项一直没有」，不报错，所以一直没被发现）。
  // 改成挨个试：直接 #count → #title 里的 #count → 旧的 header-renderer（还在的话）。
  // 多路径只会多拿到，不会拿错：命中的都是评论区自己的计数节点。
  try {
    const bc = document.querySelector('bili-comments');
    const sr = bc && bc.shadowRoot;
    let cnt = null;
    if (sr) {
      cnt = sr.querySelector('#count')
        || sr.querySelector('#title #count, #title .count')
        || (() => {
          const hdr = sr.querySelector('bili-comments-header-renderer');
          return hdr && hdr.shadowRoot ? hdr.shadowRoot.querySelector('.count, #count, .total') : null;
        })();
    }
    if (cnt) set('comments', cnt.textContent);
  } catch { /* shadow DOM 不可达则忽略 */ }

  return {
    platform: 'bilibili',
    handle: mid,
    profile: name ? { name } : undefined,
    posts: [{
      platformItemId: bvid,
      title: title.slice(0, 300),
      url: `https://www.bilibili.com/video/${bvid}`,
      ...(Object.keys(metrics).length ? { metrics } : {}),
    }],
  };
};
