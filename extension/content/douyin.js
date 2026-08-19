// 抖音用户主页解析（www.douyin.com/user/<sec_user_id>）。
// ⚠️ 抖音改版频繁——优先用相对稳定的 data-e2e 埋点属性，逐层回退，失效时少拿字段不报错。
// 这是抖音在未接商业数据源时唯一的合规指标来源（用户亲眼可见的公开页数据）。
//
// ⚠️ 这个文件一度是**死代码**：manifest 里它和 douyin-video.js 同属一条 content_scripts 规则，
// 后者曾直接覆盖 __beaconParse，于是主页上跑的其实是作品页解析器（返回 null → 走兜底 →
// 只产出一条假作品）。已在 douyin-video.js 改成接力，回归测试见 tests/ingest/parser-chain.test.ts。

// 作品卡片所在的栅格。**有明确容器就只在容器里找**：退回到全页 `li` 会把
// 「你可能感兴趣」「相关推荐」这类模块里的作品也当成本账号的作品采进来
//（同 content/x.js「非本竞对的转推跳过」是同一类问题：采到的东西必须真属于这个号）。
const DY_GRID_SCOPES = [
  '[data-e2e="user-post-list"]',
  '[data-e2e="scroll-list"]',
  '[data-e2e="user-detail"] [data-e2e="scroll-list"]',
];
const DY_NOT_OWN = ['[data-e2e="user-recommend"]', '[data-e2e="recommend-list"]', '[data-e2e="related-video-card"]'];

const DY_ITEM_LINK = 'a[href*="/video/"]';

// 「容器被当成行」防线：挑出来的元素里若还包着**多条**作品链接，说明选到的是外层壳而不是单个卡片。
// 不修的话一整屏作品只会入库第一条（取 querySelector 的第一个链接），现象和「采不全」一模一样。
// 逐层往下钻，最多 4 层，避免遇到怪结构时空转。
function dySplitShells(cards) {
  let out = cards;
  for (let i = 0; i < 4; i++) {
    if (!out.some((el) => el.querySelectorAll(DY_ITEM_LINK).length > 1)) break;
    out = out.flatMap((el) =>
      el.querySelectorAll(DY_ITEM_LINK).length > 1
        ? [...el.children].filter((c) => c.querySelector(DY_ITEM_LINK))
        : [el],
    );
  }
  return out;
}

function dyCards() {
  for (const scope of DY_GRID_SCOPES) {
    const root = document.querySelector(scope);
    if (!root) continue;
    let cards = [...root.querySelectorAll('li, [data-e2e="user-post-item"]')];
    // 栅格不一定用 <li>（抖音这块改过好几版）：容器在但认不出行时，
    // 退到「直接子元素里带作品链接的那些」，再交给 dySplitShells 拆壳。
    if (!cards.length) cards = [...root.children].filter((el) => el.querySelector(DY_ITEM_LINK));
    if (cards.length) return dySplitShells(cards);
  }
  // 兜底：全页找带作品链接的 li，但排掉推荐模块
  const loose = [...document.querySelectorAll('li')].filter((li) => {
    if (!li.querySelector(DY_ITEM_LINK)) return false;
    for (const sel of DY_NOT_OWN) {
      try { if (li.closest(sel)) return false; } catch { /* 忽略不支持的选择器 */ }
    }
    return true;
  });
  return dySplitShells(loose);
}

// 卡片封面上那个数字。
//
// 老代码是 `li.querySelector('span')` —— 取卡片里**第一个** span，那可能是时长、置顶角标、
// 甚至一段说明文字；`__beaconParseCount` 见到「00:38」会解析出 0，于是入库一个假的 0。
// 这里改成：在卡片里找**长得像计数**的文本（纯数字，可带 万/亿/w/k 单位），跳过时长（含冒号）。
const DY_COUNT_TEXT = /^\s*[\d][\d.,]*\s*(?:万|亿|w|W|k|K|m|M)?\s*$/;
// 卡片上的角标/装饰文字，取标题时要排掉
const DY_BADGE_TEXT = /^(置顶|合集|短剧|广告|直播中|\d+集)$/;

function dyCardCount(card, pc) {
  const explicit = card.querySelector('[data-e2e="video-play-count"], [data-e2e="user-post-item-count"]');
  if (explicit) {
    const n = pc(explicit.textContent);
    if (n != null) return n;
  }
  for (const el of card.querySelectorAll('span, strong, div')) {
    if (el.children.length) continue; // 只看叶子节点，避免把整块文字当计数
    const t = (el.textContent || '').trim();
    if (!t || t.includes(':') || t.includes('：')) continue; // 「00:38」是时长不是计数
    if (!DY_COUNT_TEXT.test(t)) continue;
    const n = pc(t);
    if (n != null) return n;
  }
  return undefined;
}

// 卡片标题（作品文案）。
//
// 实测校准 2026-07-29（真机截图，抖音网页版主页）：**文案在封面图下方**，是卡片里独立的一行
// （形如「小时候的离奇事件 全 #悬疑#…」，超长会带省略号）。老代码只读 `img[alt]` 与 `a[title]`，
// 那两处在这一版页面上通常是空的 —— 于是入库的作品全是空标题，数据页整列认不出是哪条，
// 还会被 lib/insight/health-check.ts 的标题查重当成「重复内容」误报。
//
// 取法：先试明确的埋点；拿不到就在卡片的**叶子文本**里挑最长的那条，并排掉
// 角标（置顶/合集）、点赞数、时长 —— 这三样是卡片里仅有的其它文本。
function dyCardTitle(card) {
  const explicit = card.querySelector('[data-e2e="user-post-item-desc"]')?.textContent?.trim();
  if (explicit) return explicit;
  let best = '';
  for (const el of card.querySelectorAll('span, div, p, a, h3')) {
    if (el.children.length) continue;
    const t = (el.textContent || '').trim();
    if (!t || t.length <= best.length) continue;
    if (DY_COUNT_TEXT.test(t) || DY_BADGE_TEXT.test(t)) continue;
    if (t.includes(':') || t.includes('：')) continue; // 时长
    best = t;
  }
  return best || card.querySelector('img')?.getAttribute('alt')?.trim() || card.querySelector('a[title]')?.getAttribute('title')?.trim() || '';
}

// 粉丝数。
//
// ⚠️ 抖音主页顶部是**三个挨着的数字**：「关注 178 · 粉丝 328.3万 · 获赞 3023.8万」
//（实测 2026-07-29 真机截图）。老代码拿 `[data-e2e="user-fans"]` 的 **parentElement 全文**
// 去 parseCount —— 那个 parent 很可能就是整条统计栏，而 parseCount 取的是**第一个**数字，
// 于是「关注数」被当成粉丝数写进库（178 vs 328 万，差三个数量级，基线与同行对比全废）。
// 一律先按「粉丝」这两个字截断，再从后面取数字：截不出来就不给，绝不拿旁边那个数字凑。
//
// ⚠️ 埋点名 2026-08-07 真机重新核对（www.douyin.com/user/<sec_uid>）：现在叫
// **`user-info-fans`**，`user-fans` 已经不存在了（同批还有 `user-info-follow` /
// `user-info-like`；`user-name` 也没了，昵称是靠下面的 h1 兜底才拿到的）。
// 埋点认不出时这个函数**并不会报错**——它会悄悄退到「全页扫含『粉丝』的短文本」，
// 于是失效是隐形的：直到有人对着页面核数字才发现。所以两个名字都留着。
// 统计栏所在的账号信息容器。**兜底扫描必须先限定在它里面**：登录态下页面别处
// （右上角头像的个人面板、侧边「我的」入口）同样写着「粉丝 N」，而那是**你自己的**粉丝数。
// 按文档序取第一个命中，就会把自己的粉丝数写进竞对档案——和「关注数当粉丝数」同一类错，
// 而且更难发现（数字本身完全正常）。容器认不出来才退回全页，宁可退化不要空手。
const DY_PROFILE_SCOPES = ['[data-e2e="user-info"]', '[data-e2e="user-detail"]'];

// **三个统计项一起读**，而不是只读粉丝那一个。多读两个不是为了入库（关注/获赞暂时不落库），
// 是为了让 common.js 的闸③（同位判串台）有东西可比：三项要是落在同一段文本的同一个下标上，
// 说明截断没生效，三项一起作废。只读一项就没有任何办法发现自己读错了。
const DY_STAT_SPECS = [
  { key: 'following', labels: ['关注'], e2e: '[data-e2e="user-info-follow"]' },
  { key: 'followers', labels: ['粉丝'], e2e: '[data-e2e="user-info-fans"], [data-e2e="user-fans"]' },
  { key: 'likes', labels: ['获赞'], e2e: '[data-e2e="user-info-like"]' },
];

function dyStats() {
  return globalThis.__beaconReadStats?.(DY_STAT_SPECS, DY_PROFILE_SCOPES) || { values: {}, via: {} };
}

globalThis.__beaconParse = function () {
  const m = location.pathname.match(/\/user\/([\w-]+)/);
  if (!m) return null;
  const handle = m[1];
  const parseCount = globalThis.__beaconParseCount;

  // ⚠️ `user-name` 2026-08-07 真机核对已经不存在了——昵称一直是靠 h1 兜底才拿到的。
  // 埋点留着不删（改回来就还能用），但别指望它。
  const name =
    document.querySelector('[data-e2e="user-name"]')?.textContent?.trim() ||
    document.querySelector('[data-e2e="user-info"] h1')?.textContent?.trim() ||
    document.querySelector('h1')?.textContent?.trim() ||
    undefined;

  const stats = dyStats();
  const followers = stats.values.followers;

  // 作品：作品栅格里的 /video/<数字id> 锚点。
  //
  // 卡片封面左下角那个数字是 **点赞数**（图标是 ♡，不是 ▷）——实测校准 2026-07-29（真机截图，
  // 抖音网页版主页：「♡ 9.7万」「♡ 6746」）。所以记成 likes 是对的，别顺手改成 views：
  // 记错方向不是少采一项，是把点赞写进播放字段，点赞率/互动率与算法教练的结论会整片歪掉
  //（lib/algorithm/coach.ts 全部按比率下判断）。
  // ⚠️ 抖音主页拿不到播放量（页面上根本不显示），播放量只能从创作者后台或详情页方向补。
  const CARD_COUNT_KEY = 'likes';
  const seen = new Set();
  const posts = [];
  for (const card of dyCards()) {
    const a = card.querySelector('a[href*="/video/"]');
    if (!a) continue;
    const idm = (a.getAttribute('href') || a.href || '').match(/video\/(\d+)/);
    if (!idm || seen.has(idm[1])) continue;
    seen.add(idm[1]);
    const title = dyCardTitle(card);
    const count = dyCardCount(card, parseCount);
    posts.push({
      platformItemId: idm[1],
      // 空标题会让数据页整列认不出是哪条，还会被标题查重当成「重复内容」误报
      title: title.slice(0, 300) || `[作品] #${idm[1].slice(-4)}`,
      url: `https://www.douyin.com/video/${idm[1]}`,
      ...(count != null ? { metrics: { [CARD_COUNT_KEY]: count } } : {}),
    });
    if (posts.length >= (globalThis.__beaconPostCap || 30)) break; // 上限见 common.js BEACON_POST_CAP
  }

  // 本人主页才有「编辑资料」；别人的主页是「关注」（判定见 common.js beaconLooksLikeSelf）
  const isSelf = globalThis.beaconLooksLikeSelf?.(['编辑资料', '编辑个人资料'], '[data-e2e="user-info"], #douyin-right-container');

  return {
    platform: 'douyin',
    handle,
    // followersVia = 这个数是**怎么**读到的（埋点命中 / 文本兜底 / 没读到）。
    // 它随回传上行，服务端据此在埋点集体失效时告警——没有它，"靠文本兜底自修复"
    // 成功与否没有任何人知道，只能等用户对着页面核数字（这次就是这么拖了十几天）。
    profile: { name, followers, followersVia: stats.via.followers || 'none' },
    posts,
    ...(isSelf ? { isSelf: true } : {}),
  };
};
