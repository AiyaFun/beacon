// 小红书笔记详情页解析（www.xiaohongshu.com/explore/<id> 或 /discovery/item/<id>）——
// 采集单条笔记的完整互动指标（点赞/收藏/评论）。
//
// 2026-08-08 真机校准（explore modal 形态，用户真实 Chrome）。两个都是**串台**教训：
//   ① 指标必须限定在 `.engage-bar`（底部操作栏）内取。modal 打开时背景瀑布流还在 DOM 里，
//      全局 `.like-wrapper .count` 第一个命中的是**背景卡片**的赞数（实测取到 4，真值 159）；
//      裸 `.interactions` 也不行——评论区每条评论的互动栏同名（实测取到评论的 26 赞）。
//   ② 作者链接必须限定在 note-detail 容器内。全页 73 条 /user/profile/ 链接的第一条是
//      **左侧栏「我」= 用户自己的主页** → handle 会解析成用户自己的 ID，
//      竞对笔记直接挂到用户自己名下。作用域内找不到就放弃（返回 null 不采），绝不全局兜底。
// 校准值核对：159 赞 / 34 藏 / 122 评，与页面显示逐项一致。

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

  // 作者 user_id（归属竞对）。只认 note-detail 容器内的链接——全局第一条是侧栏「我」
  //（用户自己），拿它当作者是把竞对笔记记到用户自己名下（见文件头 2026-08-08 校准注释）。
  const detailRoot = document.querySelector('.note-detail-mask, [class*="note-detail"], #noteContainer');
  const authorLink = detailRoot && detailRoot.querySelector('a[href*="/user/profile/"]');
  const handle = authorLink && (authorLink.href.match(/\/user\/profile\/([0-9a-zA-Z]+)/) || [])[1];
  if (!handle) return null;

  const title = (
    document.querySelector('#detail-title')?.textContent ||
    document.querySelector('.note-content .title, .title')?.textContent ||
    ''
  ).trim();

  // 指标只在底部操作栏（.engage-bar）内取；bar 找不到就一项都不采（合并式入库缺项无害），
  // 绝不退回全局选择器——那正是采到背景卡片/评论区数字的串台通道。
  const bar = (detailRoot && detailRoot.querySelector('.engage-bar')) || document.querySelector('.engage-bar');
  const txt = (sel) => { const e = bar && bar.querySelector(sel); return e ? e.textContent.trim() : null; };
  const metrics = {};
  const set = (k, v) => { const n = pc(v); if (n != null && n >= 0) metrics[k] = n; };
  set('likes', txt('.like-wrapper .count'));
  set('collects', txt('.collect-wrapper .count'));
  set('comments', txt('.chat-wrapper .count'));

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
