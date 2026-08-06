// 小红书笔记详情页解析（www.xiaohongshu.com/explore/<id> 或 /discovery/item/<id>）——
// 采集单条笔记的完整互动指标（点赞/收藏/评论）。
// ⚠️ 详情页 DOM 未当场实测校准：用已知的 engage-bar 类名 + 多重回退，取不到就少采几项
//    （合并式入库，不覆盖已有、不报错）。真实失效时按此文件调选择器。

// ⚠️ **必须接力，不能直接覆盖 __beaconParse**——xhs.js（主页）与本文件在 manifest 里是
// 同一条 content_scripts 规则的第 2、3 个脚本，按序注入，本文件永远后跑。直接覆盖会让
// **主页（/user/profile/<id>）的解析器整个变成死代码**，退回兜底解析后只得到一条假作品。
// 详见 douyin-video.js 顶部的完整说明；回归测试：tests/ingest/parser-chain.test.ts。
const __beaconPrevParse = typeof globalThis.__beaconParse === 'function' ? globalThis.__beaconParse : null;

globalThis.__beaconParse = function () {
  const m = location.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/);
  if (!m) return __beaconPrevParse ? __beaconPrevParse() : null;
  const id = m[1];
  const pc = globalThis.__beaconParseCount;

  // 作者 user_id（归属竞对）
  const authorLink = document.querySelector('a[href*="/user/profile/"]');
  const handle = authorLink && (authorLink.href.match(/\/user\/profile\/([0-9a-zA-Z]+)/) || [])[1];
  if (!handle) return null;

  const title = (
    document.querySelector('#detail-title')?.textContent ||
    document.querySelector('.note-content .title, .title')?.textContent ||
    ''
  ).trim();

  const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
  const metrics = {};
  const set = (k, v) => { const n = pc(v); if (n != null && n >= 0) metrics[k] = n; };
  set('likes', txt('.like-wrapper .count') || txt('.like-active .count') || txt('[class*="like"] .count'));
  set('collects', txt('.collect-wrapper .count') || txt('[class*="collect"] .count'));
  set('comments', txt('.chat-wrapper .count') || txt('.comment-wrapper .count') || txt('[class*="comment"] .count'));

  // 详情页本身的 URL 已含 xsec_token（打得开），保留 token + source；缺 token 的裸链接打不开。
  let url = `https://www.xiaohongshu.com/explore/${id}`;
  try {
    const q = new URL(location.href).searchParams;
    const tok = q.get('xsec_token');
    if (tok) {
      const src = q.get('xsec_source') || 'pc_user';
      url += `?xsec_token=${encodeURIComponent(tok)}&xsec_source=${encodeURIComponent(src)}`;
    }
  } catch { /* 用裸链接兜底 */ }

  return {
    platform: 'xiaohongshu',
    handle,
    posts: [{
      platformItemId: id,
      title: title.slice(0, 300),
      url,
      ...(Object.keys(metrics).length ? { metrics } : {}),
    }],
  };
};
