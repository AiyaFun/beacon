// 自有创作者后台采集（通用引擎）——把**你自己**已发布作品的表现数据回填到烽火台数据看板。
//
// 覆盖：微信视频号 / 微信公众号 / 抖音 / 小红书 / B站 的创作者后台「数据中心 · 作品数据」页。
//
// ⚠️ 合规边界（设计约束，改动前先读完；与 store/privacy.md 的披露逐条对应）：
//   ① 仅本人登录态：只在创作者后台域名下运行，读的就是你自己账号后台**已经渲染出来**的数字。
//      插件不持有、不读取、不上传任何平台的 Cookie 或登录凭证，也不代替你登录。
//   ② 只读：只做 DOM 读取。不发布、不修改、不删除、不点击、不调用任何平台接口。
//   ③ 仅自有数据：只解析「我的作品/我的内容」列表。这些后台按设计只显示登录者自己的数据，
//      本文件也不解析任何他人主页/作品页——manifest 里没有那些 match，是技术上做不到而不只是承诺不做。
//   ④ 不参与「访问即采」：置 __beaconSelfOnly，common.js 的自动采集直接跳过这些站点。
//      触发方式只有两种：默认是你在插件弹窗里点「📥 这是我的作品 · 回填数据看板」；
//      另一种是**默认关闭、需你在设置页显式开启**的「每天自动回填」——那时 service worker
//      会在后台标签页打开你自己的后台页，并按 tabId 认定它——只有那个标签页里的执行端才动作。
//      你平时自己浏览后台时，SW 会答「不是自动标签页」，那段代码一行都不跑（见文件末尾）。
//   ⑤ 只走 /api/ingest/self（自有作品通道），绝不走 /api/ingest/competitor（竞对通道）。
//
// ⚠️ DOM 未当场实测校准：这些后台都要真实登录态，开发环境打不开。因此一律「多重回退 +
//   取不到就少采几项」，与 douyin-video.js / xhs-note.js 同一套做法；后端合并式入库
//   （lib/ingest/own-post.ts applyMetrics）保证缺项不覆盖已有值、不报错。
//   真实失效时只需调本文件的选择器/别名，不动后端。
//
// 为什么值得做：公开作品页拿不到**完播率/完读率**，而它是 lib/algorithm/coach.ts 里
// 抖音/公众号/B站/视频号的第一信号——这正是「个性化诊断永远说样本不足」的根因。
// 创作者后台是唯一能合规拿到它的地方。

globalThis.__beaconSelfOnly = true;

// ── 中文列名 → 指标键 ────────────────────────────────────────────────
// 顺序即优先级：先精确相等，再按长度降序做包含匹配。
// 「阅读量」与「阅读人数」必须区分开（后者是 UV，不是阅读次数），靠精确匹配优先解决。
const METRIC_ALIASES = [
  // 末位的裸「阅读」是给**没有表头**的卡片式列表用的（公众号发表记录页就是这样，
  // 整页一个 <th> 都没有，条目文本形如「标题 阅读 1234 在看 12」）。
  // 排在最后：同时存在「阅读次数/阅读量」时，长别名按长度降序先中，裸「阅读」轮不到。
  // 代价是只有「阅读人数」一列时会把 UV 当成 views——比一个数都读不到强，且后端是合并入库。
  ['views', ['播放量', '阅读量', '观看量', '播放次数', '阅读次数', '观看次数', '播放数', '观看数', '播放', '观看', '阅读']],
  // 「在看」排在「点赞」之后：公众号两个按钮同时存在时，点赞才是这一列的正解
  // （长度相同则按本表顺序，Array.sort 稳定）。「在看率」由率型互斥挡住，不会串台。
  ['likes', ['点赞量', '点赞数', '点赞', '在看人数', '在看次数', '在看', '喜欢', '赞']],
  ['comments', ['评论量', '评论数', '留言数', '评论', '留言']],
  ['shares', ['转发量', '分享量', '转发数', '分享数', '转发', '分享']],
  ['collects', ['收藏量', '收藏数', '收藏']],
  ['danmaku', ['弹幕量', '弹幕数', '弹幕']],
  ['coins', ['投币量', '投币数', '投币', '硬币']],
  // 曝光量单独成键，**不并进 views**：它是「被展示了多少次」，并进播放会凭空拔高分母、
  // 压低所有互动率。单独存着才算得出 CTR（播放/曝光），那是 YouTube 的第一信号之一。
  // 公众号的「送达人数」就是这个位置的量：阅读次数/送达人数 = 打开率，
  // 与抖音的 播放/曝光 是同一件事，coach 那边算的也是同一个信号。
  ['impressions', ['曝光量', '展现量', '曝光次数', '展示量', '推荐量', '曝光', '送达人数', '送达']],
];
// 率型：单独处理，不能当计数取整（0.42 取整成 0 就等于丢数据）
const RATE_ALIASES = ['完播率', '播放完成率', '阅读完成率', '完读率', '完成率'];

// 计数别名的**否决词**：命中的列名/文本片段一律不算这个指标。
// 「阅读原文人数」是点了原文链接的人数，不是阅读量——而裸别名「阅读」正是它的子串，
// 与「点赞率 vs 点赞」是同一类串台，必须显式否决，否则加了裸「阅读」就等于给 views 埋雷。
// 「赞赏」是打赏功能，不是点赞——而裸别名「赞」正是它的子串（间隔只有一个「赏」字，
// 落在 [^\d]{0,4} 的窗口里）。公众号文章底部普遍有赞赏区，不否决的话
// 赞赏笔数会被当成点赞数存进去，而且数值小、看着像真的，极难发现。
const METRIC_DENY = { views: /原文/, likes: /赏/ };

// 流量来源分布：小红书「搜索流量占比」这类结论的唯一数据来源（公开页永远看不出来）。
// 后台通常渲染成「来源名 + 占比%」的列表/饼图图例，故按整块文本扫描而不是靠表头对齐。
const SOURCE_NAMES = ['推荐', '搜索', '关注', '主页', '首页', '话题', '同城', '朋友', '分享', '订阅', '其他'];
const SOURCE_BLOCK_HINT = ['流量来源', '来源分布', '播放来源', '阅读来源', '观看来源', '流量结构'];

function beaconReadSources(root) {
  // 先找「流量来源」这块容器；找不到就不猜——在整页乱扫会把无关的百分数当成来源占比
  let block = null;
  for (const el of root.querySelectorAll('div, section, table, ul')) {
    const t = beaconNorm(el.textContent).slice(0, 60);
    if (SOURCE_BLOCK_HINT.some((h) => t.includes(h))) { block = el; break; }
  }
  if (!block) return undefined;
  const text = beaconNorm(block.textContent);
  const out = {};
  for (const name of SOURCE_NAMES) {
    const m = text.match(new RegExp(name + '[^\\d]{0,6}([\\d.]+)%'));
    if (!m) continue;
    const rate = beaconReadRate(m[1] + '%');
    if (rate !== undefined) out[name] = rate;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function beaconNorm(s) {
  return String(s || '').replace(/\s+/g, '').trim();
}

// 标题专用的规范化：**只把连续空白压成一个空格**，不像 beaconNorm 那样把空白全删掉。
// 中文标题无所谓，英文/中英混排的标题被删空格后会连成一串不可读的字（"AI Coding Guide"→"AICodingGuide"），
// 而标题是要原样展示给用户、还要跟他手写的记录对得上的。
function beaconNormText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// 「看起来像标题，其实是页面噪音」的形态。只列真机上**确实抓到过**的，不做泛化判断——
// 泛化会误伤用户真实的短标题。
//   · 已通知N人 / 通知范围 / 查看历史版本：群发的通知状态块（真机 2026-07-25 的 9 条脏记录）
//   · 纯数字、纯「阅读 1234」这类：抓到的是指标单元格而不是标题
const TITLE_NOISE = /已通知\s*\d+\s*人|失败\s*\d+\s*人|通知范围|已开启通知|查看历史版本|^[\d,.\s%万亿]+$|^(阅读|在看|点赞|分享|评论|留言|送达|推荐)[\s\d]/;

// 标题取值顺序：产出这条 ID 的链接文字 → 明说自己是标题的元素 → 首列。
// 每一步都要过噪音过滤，过不了就往下走，全都过不了就不给标题
// （后端对空标题有专门的处理：留空比留一句状态文案强得多）。
// 标题上会粘着平台自己的角标。真机 2026-07-27 采到的标题末尾就带着「原创」——
// 那是公众号的原创声明角标，它在 DOM 里就挨着标题，textContent 一取就带出来。
// 存进库里会让「同一篇文章」跟用户手动登记的标题对不上，也让标题看着像脏数据。
// 只削**末尾**的这几个角标，不做泛化清洗。
// ⚠️ 不能连开头一起削：真机证据里角标是在标题之后的，而「原创内容到底该怎么做」
// 这类以「原创」开头的真标题完全可能存在——削开头就把人家的标题咬掉两个字了。
// 没有证据的那一半不做，与本文件其它地方「认不出就跳过，绝不猜」是同一条原则。
const TITLE_BADGES = /(?:\s*(?:原创|首发|置顶|精选))+$/;

function beaconStripBadges(t) {
  return t.replace(TITLE_BADGES, '').trim();
}

function beaconPickTitle(row, anchor) {
  const cands = [];
  if (anchor) cands.push({ text: anchor.textContent, fromAnchor: true });
  for (const el of row.querySelectorAll('[class*="title"], [class*="Title"]')) cands.push({ text: el.textContent, fromAnchor: false });
  const fallback = row.querySelector('[class*="name"], [class*="desc"], td:first-child');
  if (fallback) cands.push({ text: fallback.textContent, fromAnchor: false });
  for (const c of cands) {
    const t = beaconStripBadges(beaconNormText(c.text));
    if (!t || TITLE_NOISE.test(t)) continue;
    return { text: t.slice(0, 300), fromAnchor: c.fromAnchor };
  }
  return { text: '', fromAnchor: false };
}

// ── 发表时间 ────────────────────────────────────────────────────────
// 不传 publishedAt 的后果不是「少一个字段」：后端会填成**回填当天**
// （own-post.ts `post.publishedAt ?? new Date()`），于是每条自动建的记录发布时间都是今天——
// /data 的「发布时段分析」按小时分组、趋势图算「发布后第 N 天」，全都跟着错。
// 后台页上白纸黑字写着真实发表时间，读它就是了。
//
// 匹配必须**严于**其它字段：这里是在整行文本里找日期，而同一行还挤着「1.2万」「7/10」这类数字。
// 所以只认带明确日期标记的形态（年/月/日、四位年份、或 MM-DD 后面紧跟 HH:mm），
// 一律不认裸的「a.b」「a/b」——「1.2万」会被读成 1 月 2 日。
function beaconPad(n) {
  return String(n).padStart(2, '0');
}

function beaconMakeDate(y, mo, d, hh, mm) {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined;
  const iso = `${y}-${beaconPad(mo)}-${beaconPad(d)}` + (hh != null ? `T${beaconPad(hh)}:${beaconPad(mm)}:00` : 'T00:00:00');
  const t = new Date(iso);
  if (isNaN(t.getTime())) return undefined;
  // 未来的「发表时间」一定是误读（作品不可能还没发就有数据）。宁可不给。
  if (t.getTime() > Date.now() + 36 * 3600 * 1000) return undefined;
  return iso;
}

function beaconReadDate(text) {
  const t = beaconNorm(text); // 空白已删干净，下面的正则据此写
  let m;
  // 2026年7月20日 20:30 / 2026-07-20 20:30 / 2026/07/20
  m = t.match(/(20\d{2})[年\-/](\d{1,2})[月\-/](\d{1,2})日?(?:(\d{1,2}):(\d{2}))?/);
  if (m) return beaconMakeDate(+m[1], +m[2], +m[3], m[4] == null ? null : +m[4], m[5] == null ? 0 : +m[5]);
  // 7月20日 20:30（省略年份 = 今年；若算出来在未来则退回去年）
  m = t.match(/(\d{1,2})月(\d{1,2})日(?:(\d{1,2}):(\d{2}))?/);
  if (m) {
    const now = new Date();
    const hh = m[3] == null ? null : +m[3];
    const mm = m[4] == null ? 0 : +m[4];
    return (
      beaconMakeDate(now.getFullYear(), +m[1], +m[2], hh, mm) ??
      beaconMakeDate(now.getFullYear() - 1, +m[1], +m[2], hh, mm)
    );
  }
  // 07-20 20:30 —— 只在**后面紧跟时间**时才认，否则「7-20」这种区间写法会被当成日期
  m = t.match(/(?:^|[^\d])(\d{1,2})[-/](\d{1,2})(\d{1,2}):(\d{2})/);
  if (m) {
    const now = new Date();
    return (
      beaconMakeDate(now.getFullYear(), +m[1], +m[2], +m[3], +m[4]) ??
      beaconMakeDate(now.getFullYear() - 1, +m[1], +m[2], +m[3], +m[4])
    );
  }
  // 今天/昨天/前天 20:30
  m = t.match(/(今天|昨天|前天)(?:(\d{1,2}):(\d{2}))?/);
  if (m) {
    const off = m[1] === '今天' ? 0 : m[1] === '昨天' ? 1 : 2;
    const d = new Date();
    d.setDate(d.getDate() - off);
    return beaconMakeDate(d.getFullYear(), d.getMonth() + 1, d.getDate(), m[2] == null ? null : +m[2], m[3] == null ? 0 : +m[3]);
  }
  return undefined;
}

// 行里没有日期就往上找几层。多图文群发的发表时间写在**群发这一层**（外壳）上，
// 而外壳因为跨了多篇文章已被 beaconDropContainers 摘掉——同一次群发里各篇共用一个时间，
// 从祖先取到的正是对的那个。往上最多 4 层、且文本别太长（再往上就是整页了，那上面的日期与本行无关）。
function beaconReadDateFor(row) {
  let el = row;
  for (let i = 0; i <= 4 && el; i++) {
    const text = String(el.textContent || '');
    if (i > 0 && text.length > 2000) break;
    const d = beaconReadDate(text);
    if (d) return d;
    el = el.parentElement;
  }
  return undefined;
}

// 从「42.3%」「0.423」里读出 0-1 的比率。后端还会再兜一层（readRate），这里先归一。
function beaconReadRate(text) {
  const t = beaconNorm(text);
  const m = t.match(/([\d.]+)\s*%?/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const rate = t.includes('%') || n > 1 ? n / 100 : n;
  return rate > 1 ? undefined : Math.round(rate * 10000) / 10000;
}

// 表头 → 列下标。精确相等优先，其次长别名包含。
// 率型标签（含「率」「占比」「%」）绝不能拿来当计数指标。
// 这不是假想：公众号「近期发表」同一行就同时有 点赞率 / 在看率 / 留言率，而第二轮是**子串**匹配——
// 「点赞率」.includes(「点赞」) 为真，于是 4.76% 被当成点赞数存成 4；「播放完成率」同理污染播放量。
// 计数与率型必须互斥匹配：计数匹配时跳过率型表头，率型匹配时才放行。
function beaconIsRateLabel(s) {
  return /率|占比|百分比|%/.test(String(s == null ? '' : s));
}

function beaconHeaderIndex(headers, aliases, opts) {
  const allowRate = !!(opts && opts.allowRate);
  const deny = opts && opts.deny;
  const usable = (h) => (allowRate || !beaconIsRateLabel(h)) && !(deny && deny.test(h));
  for (const a of aliases) {
    const i = headers.findIndex((h) => usable(h) && h === a);
    if (i >= 0) return i;
  }
  for (const a of [...aliases].sort((x, y) => y.length - x.length)) {
    const i = headers.findIndex((h) => usable(h) && h.includes(a));
    if (i >= 0) return i;
  }
  return -1;
}

// ── 排布方向：标签在前，还是数字在前？ ────────────────────────────────
// 统计卡片常见的排布是**数字在上、标签在下**，拼成文本就是
// 「2阅读人数1点赞人数0分享人数1推荐人数」——数字在标签**前面**。
// 按「标签+紧随数字」去读，每个指标读到的都是**下一个**指标的值，整排错位一格。
//
// 真机 2026-07-27 公众号后台就是这样，而且错位后的数字**个个都像真的**、
// 能过所有形态校验，只有拿页面自己给的比率去对才看得出来：
//   行原文「2阅读人数1点赞人数…点赞率50.00%」→ 真值 阅读2/点赞1（1÷2=50% ✓）
//   我们却采成 阅读1/点赞0（对不上任何比率）
// 这是本文件里最难自查的一类错：不是漏采，是采回来一整套自洽的假数字。
//
// 方向不能靠猜，要从文本自己看出来。判据是**每个标签的数字贴在哪一侧**：
// 数字在前时「2阅读人数」左边贴得紧（间隔 0）、右边隔着「人数」（间隔 2）；
// 标签在前时「阅读1234」正好反过来。逐个标签各投一票，贴得更紧的那一侧胜出，
// 两侧一样紧就弃权（`1234在看12` 这种两边都贴着数字的，本来就无从判断）。
//
// ⚠️ 不能用「看文本两端」那种判法（我第一版就是，被真机打回来了）：
//    真机的标签串尾巴接着的是别的字段——「…0留言条数0划线人数…」——
//    最后一个标签右边照样是数字，两端法直接判反。逐个投票只看每个标签自己的左右邻，
//    不受串尾接了什么影响。
//
// 两个必要的排除：
//   ① 率型（点赞率/在看率/留言率）不投票：同一页上率型可以与计数方向相反，真机就是这样
//      （计数「2阅读人数」数字在前，率型「点赞率50.00%」标签在前）。
//   ② 同一处只让**最长**的别名投票：否则「净增人数」会被短别名「净增」再投一票，
//      而「净增」右边隔着「人数」、左边贴着上一个数字 —— 凭空多出一张反方向的票。
const DETECT_LABELS = (() => {
  const out = [];
  // 只用长度 ≥2 的别名：裸「赞」「看」这类单字会在正文里到处擦边命中
  for (const [, aliases] of METRIC_ALIASES) for (const a of aliases) if (a.length >= 2) out.push(a);
  return out;
})();

// 标签左边最近的数字离它多远（>4 视为没有）
function beaconGapBefore(text, i) {
  const m = text.slice(Math.max(0, i - 5), i).match(/[\d.,]+[万亿wWkK]?([^\d]*)$/);
  return m ? m[1].length : Infinity;
}
// 标签右边最近的数字离它多远
function beaconGapAfter(text, end) {
  const m = text.slice(end, end + 5).match(/^([^\d]*)\d/);
  return m ? m[1].length : Infinity;
}

function beaconNumberFirst(text, labels) {
  const list = (labels || DETECT_LABELS).slice().sort((a, b) => b.length - a.length);
  const taken = [];
  let before = 0;
  let after = 0;
  for (const l of list) {
    let i = text.indexOf(l);
    while (i >= 0) {
      const end = i + l.length;
      const overlapped = taken.some(([s, e]) => i < e && end > s);
      // 标签后面紧跟「率/占比/%」= 这是个率型字段，不参与计数方向的投票
      if (!overlapped && !/^(率|占比|百分比|%)/.test(text.slice(end, end + 3))) {
        taken.push([i, end]);
        const gb = beaconGapBefore(text, i);
        const ga = beaconGapAfter(text, end);
        if (gb < ga) before++;
        else if (ga < gb) after++;
      }
      i = text.indexOf(l, i + 1);
    }
  }
  return before > after;
}

// 按指定方向在文本里读「标签 ↔ 数字」，返回第一个通过全部守卫的取值。
// 守卫在两个方向上是对称的：命中率型字段（间隔或紧邻处出现 率/占比/%）、
// 命中否决词（如「阅读原文」）一律弃用，继续往后找而不是就此放弃——
// 「1点赞人数…点赞率50%」里，第一处是计数、第二处是率型，不继续找就会漏掉计数。
function beaconAdjacentValue(text, alias, numberFirst, deny) {
  const NUM = '([\\d.,]+[万亿wWkK]?)';
  const GAP = '([^\\d]{0,4})';
  const re = numberFirst
    ? new RegExp(NUM + GAP + alias + '([^\\d]{0,2})', 'g')
    : new RegExp(alias + GAP + NUM + '(%?)', 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    // 两个方向的捕获组顺序是镜像的：
    //   数字在前 (NUM)(GAP)标签(TAIL)  → m1=数字 m2=间隔 m3=标签后紧邻
    //   标签在前 标签(GAP)(NUM)(TAIL)  → m1=间隔 m2=数字 m3=数字后紧邻(%)
    const value = numberFirst ? m[1] : m[2];
    const gap = numberFirst ? m[2] : m[1];
    const tail = m[3];
    if (beaconIsRateLabel(gap) || beaconIsRateLabel(tail)) continue;
    if (deny && (deny.test(gap) || deny.test(tail))) continue;
    return value;
  }
  return undefined;
}

// 从一行里取指标：① 表头对齐取单元格；② 回退到整行文本的邻接匹配（方向自动判定）。
function beaconRowMetrics(row, globalHeaders) {
  const pc = globalThis.__beaconParseCount;
  const headers = beaconHeadersFor(row, globalHeaders);
  const cells = [...row.querySelectorAll('td, [class*="cell"], [class*="col"]')];
  const metrics = {};
  const text = beaconNorm(row.textContent);
  const numberFirst = beaconNumberFirst(text);

  for (const [key, aliases] of METRIC_ALIASES) {
    let val;
    const deny = METRIC_DENY[key];
    if (headers.length) {
      const i = beaconHeaderIndex(headers, aliases, { deny });
      if (i >= 0 && cells[i]) val = cells[i].textContent;
    }
    if (val == null) {
      for (const a of aliases) {
        const v = beaconAdjacentValue(text, a, numberFirst, deny);
        if (v != null) { val = v; break; }
      }
    }
    // 纵深防御：即便表头对齐拿到的单元格，只要值本身是百分数就不是计数，宁可不采
    if (beaconIsRateLabel(val)) val = null;
    const n = pc(val);
    if (n != null && n >= 0) metrics[key] = n;
  }

  // 率型
  let rateText;
  if (headers.length) {
    const i = beaconHeaderIndex(headers, RATE_ALIASES, { allowRate: true });
    if (i >= 0 && cells[i]) rateText = cells[i].textContent;
  }
  if (rateText == null) {
    for (const a of RATE_ALIASES) {
      const m = text.match(new RegExp(a + '[^\\d]{0,4}([\\d.]+%?)'));
      if (m) { rateText = m[1]; break; }
    }
  }
  const rate = beaconReadRate(rateText);
  if (rate !== undefined) metrics.completion = rate;

  // 来源分布只在**行内**找（有的后台每行可展开）。
  // ⚠️ 整页那份是「该账号近 N 天的总体来源」，此前它会被原样按到**每一篇**头上——
  // 一张列表页上 10 篇文章拿到一模一样的来源占比，那不是「不精确」，那就是错的数据。
  // 页级兜底移到了 __beaconParse：只有整页就解析出 1 条作品时才用（单篇详情页，那时它是对的）。
  const sources = beaconReadSources(row);
  if (sources) metrics.sources = sources;

  return metrics;
}

// 页级来源分布（整页只有一条作品时才由 __beaconParse 取用）
function beaconPageSources() {
  for (const d of beaconDocs()) {
    const s = beaconReadSources(d);
    if (s) return s;
  }
  return undefined;
}

// ── 各后台的 ID 口径 ────────────────────────────────────────────────
// **必须与 lib/publish/parse-url.ts 逐平台同口径**：用户手动登记的发布记录靠它对齐，
// 对不上就会给同一条作品建出第二条记录。认不出就返回 null（跳过该行），绝不猜——
// 猜错的 ID 会把数据挂到别的作品上，比少采一行严重得多。

// 从一行里取作品 ID：遍历行内**所有**匹配链接，取第一个真能抠出 ID 的。
// 不能用 querySelector（只看第一个匹配）：一行里常常先出现作者主页/话题等噪音链接，
// 第一个匹配到的未必是作品链接，那样会 idOf→null 而整行被跳过。
// 认不出仍返回 null（跳过该行）——绝不猜，猜错会把数据挂到别人的作品上。
// 隐藏节点必须排除。真机 2026-07-25 的公众号后台首页：178 个「行」里挤着十来个**隐藏的**
// 「素材使用位置」弹窗，它们排在真正的列表前面，于是自检采样采到的全是 alt=二维码 / align=left
// 这类噪音，全页表头收上来也是 [使用位置×10]，真正的列表一个字节都没看到。
// 更要命的是这些表头会被拿去给真正的行做列对齐——那读到的就是别的表的列。
//
// jsdom 没有布局，getClientRects() 恒为空，直接用会把**所有**节点判成隐藏。
// 故先探一下这个环境有没有布局信息：body 都拿不到 rect 就说明没有，那就不做可见性过滤。
let beaconLayoutOk = null;
function beaconLayoutAvailable() {
  if (beaconLayoutOk === null) {
    try {
      beaconLayoutOk = !!(document.body && document.body.getClientRects && document.body.getClientRects().length > 0);
    } catch { beaconLayoutOk = false; }
  }
  return beaconLayoutOk;
}

function beaconIsHidden(el) {
  try {
    if (el.closest('[hidden], [style*="display:none"], [style*="display: none"]')) return true;
    if (!beaconLayoutAvailable()) return false;
    return el.getClientRects().length === 0;
  } catch {
    return false;
  }
}

// 插件自己注入的侧栏（sidebar.js，全部 beacon-* 前缀）也匹配 [class*="row"]——
// beacon-chat-input-row 就这么混进了行集合，还把 id=beacon-chat-input、
// placeholder=针对当前页面提问 报成「可能是 ID 的属性值」，白占证据名额。
// 自己的 UI 不是页面数据，先摘出去。
function beaconIsOwnUi(el) {
  try {
    return !!(el.closest && el.closest('#beacon-ai-root, #beacon-ai-drawer, #beacon-ai-trigger, [class^="beacon-"], [class*=" beacon-"]'));
  } catch {
    return false;
  }
}

// CSS 的 [class*="row"] 没有词边界：**arrow 里就含 "row"**（a-r-r-o-w），
// 真机上 weui 的 mass__status_text_arrow 就是这么被当成「行」的。
// 只能在这里补一刀：把 class 按非字母数字与驼峰切成词段，必须有一段正好是 row/item 才算。
function beaconClassSegments(el) {
  const cls = String((el.getAttribute && el.getAttribute('class')) || '');
  return cls
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function beaconLooksLikeRow(el) {
  if (el.tagName === 'TR') return true;
  if (el.getAttribute && el.getAttribute('role') === 'row') return true;
  const segs = beaconClassSegments(el);
  return segs.some((s) => s === 'row' || s === 'rows' || s === 'item' || s === 'items');
}

// 行选择器 + 四道过滤：导航区不是数据，隐藏节点不是，插件自己的 UI 不是，
// 靠 arrow 这类子串误配进来的也不是。
// class 的属性选择器**区分大小写**：[class*="item"] 认不出 listItem / tableRow 这类驼峰命名，
// 所以大小写两种写法都要列进来，再由 beaconLooksLikeRow 按词段收口。
const BASE_ROW_SEL = 'tr, [role="row"], [class*="row"], [class*="item"], [class*="Row"], [class*="Item"]';

function beaconDataRows(cfg) {
  const hints = cfg && cfg.rowHints;
  return beaconQueryAll(hints ? BASE_ROW_SEL + ', ' + hints : BASE_ROW_SEL).filter((e) => {
    if (beaconIsNavNode(e) || beaconIsHidden(e) || beaconIsOwnUi(e)) return false;
    if (beaconLooksLikeRow(e)) return true;
    try { return !!(hints && e.matches(hints)); } catch { return false; }
  });
}

// 兜底行识别：**完全不看类名**，按结构找行。
// 判据与 tools/backend-probe.js 同一套：同一个父节点下、标签+class 签名相同、
// 重复 ≥3 次、且行内文本含 ≥2 个数字（单元格通常只含 1 个，靠这一条把行和单元格分开）。
//
// 为什么必须有这一路：真机 2026-07-25，公众号发表记录页 /cgi-bin/appmsgpublish 的条目
// 类名里既没有 row 也没有 item（weui 的命名是 weui-desktop-mass-appmsg 这一族），
// 通用行选择器一个都认不出——自检报的 11 行里，10 行是插件自己的侧栏，
// 剩下 1 行是被「arrow 含 row」误配进来的箭头图标，真正的文章列表一条都没进来。
// 靠猜类名补选择器是赌运气，按结构找才是能一次到位的做法。
function beaconStructuralRows() {
  const groups = new Map();
  for (const d of beaconDocs()) {
    let all;
    try { all = d.querySelectorAll('*'); } catch { continue; }
    const n = Math.min(all.length, 8000); // 上限：超大页面上别把主线程钉死
    for (let i = 0; i < n; i++) {
      const el = all[i];
      const p = el.parentElement;
      if (!p) continue;
      const sig = beaconRowSig(el) + '⟨' + beaconRowSig(p) + '⟩';
      let g = groups.get(sig);
      if (!g) groups.set(sig, (g = []));
      g.push(el);
    }
  }
  const numCount = (el) => (String(el.textContent || '').match(/\d[\d.,]*\s*[%万亿]?/g) || []).length;
  const cands = [];
  for (const els of groups.values()) {
    if (els.length < 3) continue;
    const rich = els.filter(
      (e) => !beaconIsHidden(e) && !beaconIsNavNode(e) && !beaconIsOwnUi(e) && numCount(e) >= 2,
    );
    if (rich.length >= 3) cands.push(rich);
  }
  // 同样重复的前提下优先取「文本更长」的那层——那才是行，短的多半是单元格
  cands.sort((a, b) => b.length - a.length ||
    String(b[0].textContent || '').length - String(a[0].textContent || '').length);
  return cands.slice(0, 2).flat();
}

// ⚠️ 容器不是行：一次多图文群发的外壳、乃至整张列表容器，同样满足「类名里有 item/row」
// 或结构兜底的判据，于是也被当成一条数据行。它只抠得出**第一篇**的 ID，指标却是从整块文本里
// 邻接匹配出来的——后面几篇的阅读/在看/分享会被算到第一篇头上。
// 更糟的是 __beaconParse 的去重规则是「同一 ID 取指标最全的那一层」，而容器的文本里数字最多，
// 它几乎必然赢过真正的那张卡片。这就是「采到的数据不对」最直接的一条路径。
//
// 判据只用一条、且不含任何启发式：**一个候选行如果包含了另一个 ID 不同的候选行，它就是容器**。
// 同一篇作品的多个层级（状态块 / 卡片 / 外壳）ID 相同，一个都不会被误删——
// 那种情况仍由「取指标最全的那一层」裁决（那条规则是用来打败状态块的，得留着）。
function beaconDropContainers(rows, cfg) {
  const ided = [];
  for (const el of rows) {
    const id = beaconRowId(el, cfg);
    if (id) ided.push({ el, id });
  }
  if (ided.length < 2) return rows;
  const drop = new Set();
  for (const a of ided) {
    for (const b of ided) {
      if (a.el === b.el || a.id === b.id) continue;
      if (a.el.contains(b.el)) { drop.add(a.el); break; }
    }
  }
  return drop.size ? rows.filter((r) => !drop.has(r)) : rows;
}

// 类名认不出任何 ID 时才启动结构兜底：认得出就别多跑一遍全页扫描。
function beaconRowsFor(cfg) {
  const rows = beaconDataRows(cfg);
  if (rows.some((r) => beaconRowId(r, cfg))) return beaconDropContainers(rows, cfg);
  const extra = beaconStructuralRows().filter((e) => !rows.includes(e));
  return beaconDropContainers(rows.concat(extra), cfg);
}

function beaconVisibleHeaders() {
  return beaconQueryAll('th, thead [class*="cell"], [role="columnheader"]')
    .filter((e) => !beaconIsHidden(e))
    .map((e) => beaconNorm(e.textContent))
    .filter(Boolean);
}

// 表头必须按**这一行自己所在的那张表**取。全页收一份表头再拿去对齐每一行，
// 页面上只要有第二张表就必然错位（首页那 10 张隐藏弹窗表就是活例子）。
// 不在任何表里的卡片式列表没有「表头」这回事，交给行内文本邻接匹配那条路。
function beaconHeadersFor(row, fallback) {
  const t = row.closest && row.closest('table, [role="table"]');
  if (!t) return fallback;
  return [...t.querySelectorAll('th, thead [class*="cell"], [role="columnheader"]')]
    .filter((e) => !beaconIsHidden(e))
    .map((e) => beaconNorm(e.textContent))
    .filter(Boolean);
}

function beaconIsNavNode(node) {
  if (!node || !node.closest) return false;
  return !!node.closest('nav, aside, header, .weui-desktop-layout__extra, .weui-desktop-menu, [class*="menu"], [class*="nav"], [class*="sidebar"]');
}



// 一次采集内缓存：抠 ID 要遍历行内几百个节点的全部属性，而同一行现在会被问到三次
// （容器过滤一次、自检一次、正式解析一次）。178 行 × 3 遍全属性扫描是能把主线程钉住的。
// 与 beaconDocsCache 同一个生命周期：入口处一起清，绝不跨次采集复用。
let beaconIdCache = new WeakMap();

function beaconRowIdInfo(row, cfg) {
  const hit = beaconIdCache.get(row);
  if (hit) return hit;
  const info = beaconRowIdInfoUncached(row, cfg);
  beaconIdCache.set(row, info);
  return info;
}

// 返回 { id, via }：via 记录 ID 是从哪条路取到的，自检里按 via 分类计数——
// 「靠链接拿到的」和「靠 data-* 兜底拿到的」失效原因完全不同，混在一起报等于没报。
// anchor（产出这条 ID 的那个 <a>）也一并带出来：它的文字必然是这篇作品的标题，
// 比任何按类名猜标题的做法都准。
function beaconRowIdInfoUncached(row, cfg) {
  for (const a of row.querySelectorAll(cfg.linkSelector)) {
    const id = cfg.idOf(a.getAttribute('href'));
    if (id) return { id, via: 'link', anchor: a };
  }
  for (const el of [row, ...row.querySelectorAll('[data-href], [data-url], [data-link], [data-src]')]) {
    for (const attr of ['data-href', 'data-url', 'data-link', 'data-src']) {
      const id = cfg.idOf(el.getAttribute(attr));
      if (id) return { id, via: 'data-url' };
    }
  }
  // 最后一路：行内根本没有链接的后台，ID 可能在任意 data-* 上（见 beaconScanAttrs）。
  // 再往下没有第三条路了——框架状态在隔离世界里读不到，见 BACKENDS 上方那段说明。
  const byAttr = beaconScanAttrs(row, cfg);
  if (byAttr) return { id: byAttr, via: 'attr' };
  return { id: null, via: null };
}

function beaconRowId(row, cfg) {
  return beaconRowIdInfo(row, cfg).id;
}

const SPH_ID_KEYS = ['eid', 'exportId', 'export_id', 'objectId', 'object_id'];
const SPH_ID_RE = /^[A-Za-z0-9_=-]{8,128}$/;

function beaconUrlOf(href) {
  if (!href) return null;
  try {
    return new URL(href, location.origin);
  } catch {
    return null;
  }
}

// ── 同源 iframe ───────────────────────────────────────────────────────
// 公众号后台的部分数据模块渲染在 iframe 里，而 manifest 没开 all_frames
// （开了会让每个 frame 都抢答 sendResponse，回哪个 frame 的结果不确定）。
// 内容脚本能直接读**同源** iframe 的 document，故在主 frame 里横穿一层即可，
// 跨域 iframe 访问会抛异常——catch 掉当作没有，不是错误。
// 一次采集内缓存：beaconReadSources 是逐行调用的，178 行 × 每次重扫 iframe 白花时间。
// 入口（__beaconParse / __beaconSelfDiagnose）开头置空，保证不会跨次采集用到已卸载的文档。
let beaconDocsCache = null;
function beaconResetDocs() {
  beaconDocsCache = null;
  beaconIdCache = new WeakMap(); // 与文档缓存同生命周期：换了一页就不能再用上一页的 ID 结论
}

function beaconDocs() {
  if (beaconDocsCache) return beaconDocsCache;
  const docs = [document];
  for (let i = 0; i < docs.length && docs.length < 8; i++) {
    let frames = [];
    try { frames = [...docs[i].querySelectorAll('iframe, frame')]; } catch { frames = []; }
    for (const f of frames) {
      let d = null;
      try { d = f.contentDocument; } catch { d = null; }
      if (d && d.body && !docs.includes(d)) docs.push(d);
      if (docs.length >= 8) break;
    }
  }
  beaconDocsCache = docs;
  return docs;
}

function beaconQueryAll(sel) {
  const out = [];
  for (const d of beaconDocs()) {
    try { out.push(...d.querySelectorAll(sel)); } catch { /* 文档被卸载，跳过 */ }
  }
  return out;
}

// ── 无链接后台的 ID 兜底 ─────────────────────────────────────────────
// 现实里有一类后台整行连一个 <a> 都没有（点击靠 onclick/JS 路由），此时 linkSelector
// 再怎么补都是空的。ID 只可能在两个地方：任意 data-* 属性（antd 表格的 data-row-key 最常见），
// 或框架组件实例内部。这两条路都保留原铁律：**值必须过该平台的 idOf/bareIdOf 校验，
// 过不了就整行跳过，绝不猜**——猜错的 ID 会把数据挂到别的作品上，比少采一行严重得多。
//
// 属性名筛选只是第一道粗筛（真正的把关是形态校验）：
// 裸值（不像 URL 的值）必须来自**明说自己是 ID** 的属性，否则 13 位时间戳、点赞数
// 这类纯数字会被当成抖音作品 ID。
const ID_ATTR_HINT = /id|key|vid|aweme|note|bv|eid|export|object|feed|token|item/i;
// 反向排除：xhs 的笔记 ID 与用户 uid 同为 24 位十六进制，形态上分不开，只能靠属性名躲开。
const NOT_ID_ATTR = /user|author|uid|account|nick|avatar|owner|creator|group|categ|tag|type|index|idx|count|num|total|time|date|status|width|height|size|zindex/i;

function beaconIdFromValue(cfg, name, value) {
  const val = String(value == null ? '' : value).trim();
  if (!val || val === '#' || val.length > 512) return null;
  const attr = String(name || '').toLowerCase();
  if (attr === 'class' || attr === 'style' || attr === 'srcset') return null;
  // 像 URL/路径的值走 idOf——与 lib/publish/parse-url.ts 同口径
  if (/[/?]|^https?:/i.test(val)) {
    const id = cfg.idOf(val);
    if (id) return id;
  }
  if (!cfg.bareIdOf) return null;
  if (!ID_ATTR_HINT.test(attr) || NOT_ID_ATTR.test(attr)) return null;
  return cfg.bareIdOf(val, attr) || null;
}

// 行 + 行内前 N 个后代。不整体展开 NodeList：这类页面一「行」可能是个大容器，
// 178 行 × 每行几千个节点全展成数组，光建数组就够卡一下的。
function beaconRowNodes(row, limit) {
  const out = [row];
  const kids = row.querySelectorAll('*');
  const n = Math.min(kids.length, limit);
  for (let i = 0; i < n; i++) out.push(kids[i]);
  return out;
}

function beaconScanAttrs(row, cfg) {
  for (const el of beaconRowNodes(row, 400)) {
    const attrs = el.attributes;
    if (!attrs) continue;
    for (const a of attrs) {
      const id = beaconIdFromValue(cfg, a.name, a.value);
      if (id) return id;
    }
  }
  return null;
}

// ⚠️ 这里曾经有一条「读 React fiber / Vue 组件 props 抠 ID」的兜底（beaconFrameworkId），
// 已删除：内容脚本跑在 Chrome 的**隔离世界**，与页面共享 DOM 但不共享 JS——
// 页面脚本挂在元素上的 expando（__reactFiber$xxx / __vue__ / __vueParentComponent）
// 在这里一律读不到（已对 Chrome content-scripts 官方文档核实，2026-07-25）。
// 那条路在真机上永远返回 null，只是白跑一遍每一行，还会让自检报出「框架实例：无」，
// 在明明是 Vue 后台的页面上把人引向「继续补 DOM 选择器」这条错路。
//
// SPA 后台若真的 JS 跳转、DOM 里不留 href/data-*，只有两条真路：
//   ① 另加一个 "world": "MAIN" 的内容脚本读框架状态再 postMessage 回来
//      —— 会动到 store/privacy.md 与 README 的「只做 DOM 读取」表述，红线级改动，先问用户；
//   ② 改用不依赖平台 ID 的对齐方式（按标题匹配用户已登记的发布记录）。
// 现场诊断用 extension/tools/backend-probe.js（在 DevTools 控制台跑，控制台在 MAIN world
// 才看得见框架状态），它会把 [DOM]（插件可用）与 [框架]（插件读不到）分开标注。

// ── 公众号后台的 token：三类可达来源，按可靠性递降 ──────────────────────
const BACKENDS = {
  // ── 微信视频号 ──
  'channels.weixin.qq.com': {
    platform: 'shipinhao',
    pathPrefix: '/platform',
    linkSelector: 'a[href*="objectId"], a[href*="exportId"], a[href*="export_id"], a[href*="eid="]',
    idOf(href) {
      const u = beaconUrlOf(href);
      if (!u) return null;
      for (const k of SPH_ID_KEYS) {
        const v = u.searchParams.get(k);
        if (v && SPH_ID_RE.test(v)) return v;
      }
      return null;
    },
    // 视频号 ID 形态太宽（任何字母数字串都像），裸值只认**明说自己是 export/object ID** 的属性，
    // 且长度下限抬到 16——短串误判的代价是把数据挂到别的作品上。
    bareIdOf(v, attr) {
      if (!/eid|export|object|feed/.test(attr)) return null;
      return /^[A-Za-z0-9_=-]{16,128}$/.test(v) ? v : null;
    },
    urlOf: (id) => `https://channels.weixin.qq.com/web/pages/feed?eid=${id}`,
  },


  // ── 抖音创作者后台 ──
  'creator.douyin.com': {
    platform: 'douyin',
    pathPrefix: '/',
    linkSelector:
      'a[href*="/video/"], a[href*="/note/"], a[href*="/slides/"], a[href*="modal_id"], a[href*="vid="], a[href*="item_id"], a[href*="aweme_id"]',
    idOf(href) {
      const u = beaconUrlOf(href);
      if (!u) return null;
      // 与 parse-url.ts parseDouyin 同口径：video / note / slides 三种路径 + modal_id / vid。
      // 此前只认 /video/，图文(note)与图集(slides)在后台永远回填不了，用户只看到「回填 0 条」。
      const segs = u.pathname.split('/').filter(Boolean);
      const i = segs.findIndex((s) => s === 'video' || s === 'note' || s === 'slides');
      let id = i >= 0 ? segs[i + 1] : undefined;
      if (!id) id = u.searchParams.get('modal_id') || undefined;
      if (!id) id = u.searchParams.get('vid') || undefined;
      if (!id) {
        for (const k of ['item_id', 'aweme_id', 'itemId', 'awemeId']) {
          const v = u.searchParams.get(k);
          if (v) { id = v; break; }
        }
      }
      return id && /^\d{6,25}$/.test(id) ? id : null;
    },
    // 裸值比 URL 严：抖音作品 ID 是 19 位左右的雪花号，下限抬到 10 位，
    // 挡掉「点赞数 123456」这类误命中（属性名筛选已挡掉 13 位时间戳那一类）。
    bareIdOf: (v) => (/^\d{10,25}$/.test(v) ? v : null),
    urlOf: (id) => `https://www.douyin.com/video/${id}`,
  },

  // ── 小红书创作者后台 ──
  'creator.xiaohongshu.com': {
    platform: 'xiaohongshu',
    pathPrefix: '/',
    linkSelector:
      'a[href*="/explore/"], a[href*="/item/"], a[href*="/user/profile/"], a[href*="note_id"], a[href*="noteId"]',
    idOf(href) {
      const u = beaconUrlOf(href);
      if (!u) return null;
      // 与 parse-url.ts parseXiaohongshu 同口径。
      // ⚠️ /user/profile/<uid>/<noteId>：uid 与 noteId 同为 24 位十六进制，
      // 只能靠**位置**（第 4 段）区分，不能靠形态——否则会把作者 uid 当成笔记 ID。
      const segs = u.pathname.split('/').filter(Boolean);
      let id;
      if (segs[0] === 'explore' && segs[1]) id = segs[1];
      else if (segs[0] === 'discovery' && segs[1] === 'item' && segs[2]) id = segs[2];
      else if (segs[0] === 'item' && segs[1]) id = segs[1];
      else if (segs[0] === 'user' && segs[1] === 'profile' && segs[3]) id = segs[3];
      if (!id) {
        for (const k of ['note_id', 'noteId']) {
          const v = u.searchParams.get(k);
          if (v) { id = v; break; }
        }
      }
      return id && /^[0-9a-f]{24}$/i.test(id) ? id : null;
    },
    // 24 位十六进制既可能是笔记 ID 也可能是作者 uid，形态上分不开——
    // 靠 NOT_ID_ATTR 把 data-user-id / data-author-id 这类属性名先排除掉（见 beaconIdFromValue）。
    bareIdOf: (v) => (/^[0-9a-f]{24}$/i.test(v) ? v : null),
    urlOf: (id) => `https://www.xiaohongshu.com/explore/${id}`,
  },

  // ── B站创作中心 ──
  'member.bilibili.com': {
    platform: 'bilibili',
    pathPrefix: '/',
    linkSelector: 'a[href*="/video/BV"], a[href*="bvid"]',
    idOf(href) {
      const u = beaconUrlOf(href);
      if (!u) return null;
      const m = (u.pathname + u.search).match(/(BV[0-9A-Za-z]{10})/);
      return m ? m[1] : null;
    },
    // BV 号形态足够独特，值里任意位置出现都能认（封面 URL、data-bvid 皆可）
    bareIdOf(v) {
      const m = String(v).match(/(BV[0-9A-Za-z]{10})/);
      return m ? m[1] : null;
    },
    urlOf: (id) => `https://www.bilibili.com/video/${id}`,
  },
};

// ── 自检：把「这一页到底认出了什么」讲清楚 ──────────────────────────────
// 这些后台的 DOM 无法在开发环境校准（要真实登录态），失效表现又是「采到的字段变少」
// 而不是报错——用户看到「回填 0 条」根本无从判断是哪一步断了。
// 这个函数把中间状态吐出来：认出多少行、有链接的多少、抠出 ID 的多少、看到哪些表头。
// 用户把它截图发回来，就能定位到底是选择器不对还是列名对不上，不必读代码。
// 整条路由：SPA 后台把「当前在哪一页」写在 ?t= / #hash 里，只看 pathname 等于看不见。
function beaconRoute() {
  return location.pathname + (location.search || '') + (location.hash || '');
}

// 顶层 + 每个同源 iframe 的路由。公众号首页的「已发表」面板历来是个 iframe
// （src 形如 /cgi-bin/appmsgpublish?...），顶层地址写着 home，数据其实在子框架里。
// 只看顶层就会把「数据就在这一页上」判成「站错了页面」。
function beaconRoutes() {
  const out = [beaconRoute()];
  for (const d of beaconDocs().slice(1)) {
    try {
      const u = new URL(d.URL || d.location.href);
      out.push(u.pathname + (u.search || '') + (u.hash || ''));
    } catch { /* about:blank 之类，跳过 */ }
  }
  return out;
}

function beaconSafeUrl(href) {
  try {
    const u = new URL(href);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|ticket|secret|sign|key|uin|sid|pass|cookie/i.test(k)) u.searchParams.set(k, '***');
    }
    return u.pathname + (u.search || '') + (u.hash || '');
  } catch {
    return String(href || '').slice(0, 80);
  }
}

// 给用户看、也由用户粘贴回来的那一份路由：抹掉 token/ticket 这类等同于登录态的参数。
// 公众号后台每个页面地址都带 token=，直接打印等于让用户把会话凭证贴进聊天框。
function beaconSafeRoute() {
  try {
    const u = new URL(location.href);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|ticket|secret|sign|key|uin|sid|pass|cookie/i.test(k)) u.searchParams.set(k, '***');
    }
    return u.pathname + (u.search || '') + (u.hash || '');
  } catch {
    return location.pathname;
  }
}

// 这一页上到底有没有「可采的数据」——URL 认不出时的第一手证据。
// 判据与真正的采集口径同源：表头里有任何计数/率型指标，或账号块（粉丝/受众）读得到。
// 不另起一套启发式，否则「自检说有、采集说没有」会自相矛盾。
function beaconHasDataEvidence(known) {
  const headers = known || beaconVisibleHeaders();
  for (const [, aliases] of METRIC_ALIASES) {
    if (beaconHeaderIndex(headers, aliases) >= 0) return true;
  }
  if (beaconHeaderIndex(headers, RATE_ALIASES, { allowRate: true }) >= 0) return true;
  return !!beaconAccountBlock();
}

// 行的身份指纹：标签 + 前两个 class 片段。补选择器时这一行就够定位了。
function beaconRowSig(el) {
  const cls = String(el.getAttribute && el.getAttribute('class') || '')
    .trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return el.tagName + (cls ? '.' + cls : '');
}

// 这一页到底长什么样——**唯一**的现场证据。
// 旧版只采 href/data-href 等 6 个固定属性名，于是「页面确实没有链接」与
// 「ID 就躺在我没看的那个属性里（antd 的 data-row-key 最典型）」给出同一句话，
// 用户照着发回来我也补不出选择器，白跑一轮。现在改成：把行上**实际出现过的属性名**
// 全列出来，再挑可能是 ID 的属性给出真实取值。
function beaconEvidence(cfg, rows) {
  const attrNames = new Map();
  const idish = [];
  const plain = [];
  // 表头空、属性也空的时候，**文本**是仅剩的信号。按行指纹分组，报出每组的行数和一段文本——
  // 「这 13 行里到底有没有作品列表」这个问题，只有文本答得了；
  // 光看 alt=二维码 / class 名永远说不清。
  const bySig = new Map();
  for (const row of rows) {
    const sig = beaconRowSig(row);
    let g = bySig.get(sig);
    if (!g) bySig.set(sig, (g = { n: 0, text: '' }));
    g.n++;
    if (!g.text) {
      const t = beaconNorm(row.textContent);
      g.text = t.length > 46 ? t.slice(0, 46) + '…' : t;
    }
  }
  const sigs = [...bySig.entries()].slice(0, 6).map(([sig, g]) => `${sig}×${g.n}「${g.text || '空'}」`);

  // 采样必须横跨整个行集合，不能只取前 40 行：真机上开头几十行常常是弹窗/模板/空壳，
  // 只看开头会得到一份「全是噪音」的证据，而真正的列表在后半段一个字节都没被看到。
  const step = Math.max(1, Math.ceil(rows.length / 40));
  for (let i = 0; i < rows.length; i += step) {
    const row = rows[i];
    for (const el of beaconRowNodes(row, 120)) {
      if (!el.attributes) continue;
      for (const a of el.attributes) {
        const name = String(a.name || '').toLowerCase();
        if (name === 'class' || name === 'style') continue;
        attrNames.set(name, (attrNames.get(name) || 0) + 1);
        const val = String(a.value || '').trim();
        if (!val || val === '#') continue;
        // base64 内联图片、blob，以及**其它扩展**注入到页面里的资源（chrome-extension://…）
        // 绝不可能是作品 ID，但它们都满足 urlish 判定，会挤占仅有的 8 个 idish 名额。
        // 真机上就这么翻过车：三条「可能是 ID 的属性值」全是 data:image 和别的插件的图标，
        // 真信号一条都没剩下，等于这一轮自检白跑。
        if (/^(data:|blob:|chrome-extension:|moz-extension:|about:)/i.test(val)) continue;
        const short = val.length > 90 ? val.slice(0, 90) + '…' : val;
        const pair = `${name}=${short}`;
        const urlish = /[/?]|^https?:/i.test(val);
        if ((urlish || ID_ATTR_HINT.test(name)) && !NOT_ID_ATTR.test(name)) {
          if (idish.length < 8 && !idish.includes(pair)) idish.push(pair);
        } else if (plain.length < 6 && !plain.includes(pair) && val.length <= 40) {
          plain.push(pair);
        }
      }
    }
  }
  const names = [...attrNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([n]) => n);
  // ⚠️ 这里不再探测「页面有没有 Vue/React」：内容脚本在隔离世界里根本读不到框架实例
  // （见 BACKENDS 上方那段说明），无论页面是什么框架都只会报「无」。报一个恒为假的结论，
  // 比不报更坏——它会让人以为「页面没框架，继续补选择器就行」。要看框架状态，
  // 只能在 DevTools 控制台跑 tools/backend-probe.js（控制台在 MAIN world）。
  const docs = beaconDocs();
  // 页面里出现了哪些关键词——用来分辨「选择器不对」和「压根停在别的页上」。
  // 少了这一条，用户停在「首页概览」而不是「作品数据」时，自检会一路指向选择器，方向全错。
  const frameUrls = docs.slice(1).map((d) => beaconSafeUrl(d.URL || (d.location && d.location.href) || ''));
  const bodyText = docs.map((d) => beaconNorm(d.body ? d.body.textContent : '')).join('');
  const words = ['作品', '内容', '粉丝', '净增', '性别', '年龄', '地域', '流量来源', '完播', '完读', '播放', '阅读', '点赞', '评论']
    .filter((w) => bodyText.includes(w));
  return {
    sigs, names, idish, plain, words, frameUrls,
    frames: docs.length - 1,
    text: [
      `行样本（指纹×行数「文本」）：\n  ${sigs.join('\n  ') || '无'}`,
      `行内出现过的属性名：${names.join(',') || '（除 class/style 外一个都没有）'}`,
      `可能是 ID 的属性值：${idish.length ? idish.join('  |  ') : '（没有任何像 URL/ID 的属性）'}`,
      idish.length ? '' : `其它属性取值样本：${plain.join('  |  ') || '无'}`,
      `页面关键词：${words.join(',') || '无'}`,
      // iframe 的**地址**比个数有用得多：公众号首页的数据面板就藏在子框架里，
      // 只报「1 个」等于没报。地址同样抹 token 后再给。
      `同源 iframe：${docs.length - 1} 个${frameUrls.length ? '（' + frameUrls.join(' , ') + '）' : ''}`,
      // 行内一个链接都没有时，光靠插件（隔离世界）可能真的抠不出 ID——
      // 直接把下一步该跑什么写在证据里，别让人再等一轮。
      idish.length ? '' : '（行内没有可用链接/ID：请在该页 DevTools 控制台跑 extension/tools/backend-probe.js，它能看到插件读不到的框架状态）',
    ].filter(Boolean).join('\n'),
  };
}

// 「解析成功」四个字是不够的：真正要回答的是**采出来的东西对不对**。
// 这些后台我在开发环境打不开，唯一能看到真实页面的人是用户——所以自检必须把
// 「这一趟到底采成了什么」原样列出来（标题 / 链接 / 每个指标的值），
// 让用户对着后台页一眼就能指出「这个标题不对」「这个数字是别人的」。
// 只报条数的话，采错了和采对了长得一模一样。
function beaconSampleText(parsed) {
  if (!parsed || !parsed.posts || parsed.posts.length === 0) return '（没有作品级数据）';
  const lines = [];
  for (const p of parsed.posts.slice(0, 3)) {
    const m = p.metrics || {};
    const nums = Object.keys(m)
      .filter((k) => typeof m[k] === 'number')
      .map((k) => `${k}=${m[k]}`)
      .join(' ');
    lines.push(
      `  · 标题：${p.title || '（空）'}\n`
      + `    链接：${p.url || '（无）'}\n`
      + `    时间：${p.publishedAt || '（没读到，后端会填成回填当天）'}\n`
      + `    指标：${nums || '（一个都没读到）'}\n`
      // 行原文是判断「数字读对没读对」的**唯一**依据：光看 views=1 说不清 1 是从哪个
      // 标签旁边读来的，看到「…阅读1…」还是「…赞赏1…」才知道串没串台。
      + `    行原文：${p.__evidence || '（无）'}`,
    );
  }
  const more = parsed.posts.length > 3 ? `\n  …另有 ${parsed.posts.length - 3} 条` : '';
  return `采到的前 ${Math.min(3, parsed.posts.length)} 条：\n${lines.join('\n')}${more}`;
}

globalThis.__beaconSelfDiagnose = function () {
  beaconResetDocs();
  const cfg = BACKENDS[location.hostname];
  if (!cfg) return { ok: false, reason: `当前域名 ${location.hostname} 不是受支持的创作者后台` };
  if (cfg.pathPrefix !== '/' && !location.pathname.startsWith(cfg.pathPrefix)) {
    return { ok: false, reason: `路径应以 ${cfg.pathPrefix} 开头，当前是 ${location.pathname}` };
  }
  const headers = beaconVisibleHeaders();
  const rows = beaconRowsFor(cfg);
  // withLink 与 withId 是**两个不同的断点**，必须分开数：
  // 旧版在同一个计数器上加了两次（有链接 +1，有链接或有 ID 再 +1），既翻倍又混淆——
  // 「靠 data-* 抠到了 ID 但一个 <a> 都没有」会被报成「有链接」，指向完全错误的修法。
  let withLink = 0, withId = 0, withMetrics = 0;
  const viaCount = new Map();
  for (const row of rows) {
    const link = (row.matches && row.matches(cfg.linkSelector)) ? row : row.querySelector(cfg.linkSelector);
    if (link) withLink++;
    const { id, via } = beaconRowIdInfo(row, cfg);
    if (!id) continue;
    withId++;
    viaCount.set(via, (viaCount.get(via) || 0) + 1);
    if (Object.keys(beaconRowMetrics(row, headers)).length > 0) withMetrics++;
  }
  const ev = beaconEvidence(cfg, rows);
  const parsed = globalThis.__beaconParse({ withEvidence: true });
  const hasAccount = !!(parsed && (parsed.dailyStats || parsed.audience));
  const hasPosts = !!(parsed && parsed.posts && parsed.posts.length > 0);
  const via = [...viaCount.entries()].map(([k, n]) => `${k}×${n}`).join(',') || '无';
  const base = `平台=${cfg.platform} 路径=${beaconSafeRoute()} 行=${rows.length} 有链接=${withLink} 有ID=${withId}(${via}) 有指标=${withMetrics} 表头=[${headers.slice(0, 12).join('/')}]`;

  // 「这一页多半不是数据页」——判据两层：URL 路由认不出，且页面上确实没有指标/粉丝数据。
  //   ① 匹配整条路由而不只是 pathname：公众号后台是 SPA，切到「内容分析」后
  //      pathname 仍可能是 /cgi-bin/home，真正的路由在 ?t=statistics/... 里；
  //   ② URL 认不出时以 DOM 为准：URL 形态会随平台改版失效，页面里有没有数据才是第一手证据。
  //
  // ⚠️ 这个分支**绝不能提前 return**。它原本写在函数开头直接返回，于是自检一个字节的
  //    DOM 证据都采不到——真机 2026-07-25 连着四轮：守卫反复叫人换页，而我需要的线索
  //    被同一个守卫挡在门外，用户每次发回来的都是同一句话，我拿不到任何新信息。
  //    「叫人换页」和「把现场证据交出来」不是二选一：换页建议照给，证据一并附上。
  const routes = beaconRoutes();
  // 「站在已知的数据页上」只看路由，不看 DOM——它回答的是「这一页是不是那张完整的数据表」，
  // 与下面 offDataPage 的「这一页有没有任何可采的东西」是两个不同的问题。
  const onDataPage = !cfg.dataPaths || cfg.dataPaths.some((re) => routes.some((r) => re.test(r)));
  const offDataPage = !onDataPage && !beaconHasDataEvidence(headers);
  if (offDataPage && !hasPosts && !hasAccount) {
    return {
      ok: false,
      platform: cfg.platform,
      path: beaconSafeRoute(),
      rows: rows.length,
      evidence: ev,
      reason:
        `当前是 ${beaconSafeRoute()}，这一页多半没有作品数据表。\n` +
        `建议切到：${cfg.dataPageHint}，等列表完全显示出来再点一次。\n` +
        `如果你就想在这一页采（或它其实就是数据页），把下面这段发我，我照着这一页补：\n` +
        `${base}\n${ev.text}`,
    };
  }

  return {
    ok: true,
    platform: cfg.platform,
    path: beaconSafeRoute(),
    rows: rows.length,
    withLink,
    withId,
    withMetrics,
    via: Object.fromEntries(viaCount),
    headers: headers.slice(0, 20),
    evidence: ev,
    collected: parsed ? parsed.posts.length : 0,
    hasAccount,
    sample: parsed ? parsed.posts[0] : null,
    // 按最常见的断点顺序给出人话提示。失败分支一律附现场证据——
    // 用户复制回来的这一段就是我补选择器的全部依据，缺一项就得再跑一轮。
    hint:
      hasPosts || hasAccount
        ? `解析出 ${parsed ? parsed.posts.length : 0} 条作品数据${hasAccount ? ' + 账号/受众分析数据' : ''}（${base}）\n`
          // 「采到了」不等于「站对了页」。真机 2026-07-27：用户停在首页的「已发表」面板
          // （home?t=home/index#tab=sent-panel），那儿的计数是概览性质的，
          // 完整的阅读次数/送达人数/完读率只有「内容分析」页才有。
          // 解析成功时不提醒，用户就会以为这一页的数字已经是全部了。
          + (onDataPage ? '' : `⚠️ 当前不是标准数据页，这里的数字可能只是概览计数。\n   完整数据请切到：${cfg.dataPageHint}\n`)
          + `${beaconSampleText(parsed)}\n`
          + `—— 请对着后台页核一遍：标题/链接/数字对不上就把这段发我`
        : rows.length === 0
          ? `一行都没认出来：表格可能还没加载完，或用了非 <table> 的虚拟列表。${base}\n页面关键词：${ev.words.join(',') || '无'}\n同源 iframe：${ev.frames} 个 —— 把这段发我`
          : withId === 0
            ? `认出了 ${rows.length} 行，但一行都抠不出作品 ID。\n${base}\n${ev.text}\n—— 把这段发我，据此补选择器/ID 规则`
            : withMetrics === 0
              ? `抠到了 ${withId} 个作品 ID（${via}）但一个指标都没读到：列名对不上。\n${base}\n—— 把这段发我即可补列名别名`
              : `抠到了 ${withMetrics} 行可回填数据但没能组装成结果，请把这段发我：\n${base}`,
  };
};

// ── 账号级数据：粉丝数/净增 + 受众画像 ─────────────────────────────────
// 这些不属于任何一篇作品（粉丝数挂到某篇上是错的），走 payload 的 account 块，
// 后端落 AccountDailyStat / AudienceProfile 两张表。
// 与作品级数据一样：读的是后台**已经渲染出来**的数字，不调接口、不碰 Cookie。

// ⚠️ 公众号「用户分析」页一个「粉丝」字都不写：它的四张指标卡是
//    新增人数 / 取消关注人数 / 净增人数 / 累计人数。只认「粉丝*」等于对公众号全盲。
// ⚠️ 不能加「关注人数」：它是「取消关注人数」的子串，会把**取消**关注数读成粉丝总数。
//    只收长形态（累计关注人数），且排在通用的「粉丝」前面——顺序即优先级，先中先用。
const FOLLOWER_LABELS = ['粉丝总数', '总粉丝数', '粉丝数', '累计关注人数', '累计人数', '关注者', '订阅数', '粉丝'];
const FOLLOWER_DELTA_LABELS = ['粉丝净增', '净增粉丝', '净增人数', '新增粉丝', '新增人数', '粉丝增长', '净增'];

// 受众画像各维度的容器提示词与分组名。与来源分布同一套「先认容器再扫占比」的做法：
// 满页乱扫百分数必然把别的东西当成画像。
const AUDIENCE_DIMS = [
  { key: 'gender', hints: ['性别分布', '性别占比', '性别'], names: ['男', '女'] },
  {
    key: 'age',
    hints: ['年龄分布', '年龄占比', '年龄段', '年龄'],
    names: ['18-23', '24-30', '31-40', '41-50', '50+', '18岁以下', '18-24', '25-34', '35-44', '45-54', '55+'],
  },
  {
    key: 'region',
    hints: ['地域分布', '地区分布', '城市分布', '省份', '地域', '地区'],
    names: ['广东', '江苏', '浙江', '山东', '河南', '四川', '北京', '上海', '湖北', '湖南', '河北', '福建', '安徽', '陕西', '重庆', '天津'],
  },
  { key: 'interest', hints: ['兴趣分布', '兴趣偏好', '内容偏好', '兴趣'], names: [] },
];

function beaconFindBlock(hints) {
  for (const el of beaconQueryAll('div, section, table, ul')) {
    const t = beaconNorm(el.textContent).slice(0, 60);
    if (hints.some((h) => t.includes(h))) return el;
  }
  return null;
}

// 从一块里扫「名称 + 占比%」。names 为空时用通用形态（中文标签紧跟百分数）。
function beaconScanShares(block, names) {
  const text = beaconNorm(block.textContent);
  const out = {};
  if (names.length) {
    for (const n of names) {
      const m = text.match(new RegExp(n.replace(/[+]/g, '\\+') + '[^\\d]{0,6}([\\d.]+)%'));
      if (!m) continue;
      const r = beaconReadRate(m[1] + '%');
      if (r !== undefined) out[n] = r;
    }
    if (Object.keys(out).length) return out;
  }
  // 通用回退：连续的「中文/数字标签 + 百分数」对
  const re = /([\u4e00-\u9fa5A-Za-z0-9+\-]{1,10})[^\d]{0,4}([\d.]+)%/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const r = beaconReadRate(m[2] + '%');
    if (r !== undefined) out[m[1].slice(0, 20)] = r;
    if (Object.keys(out).length >= 20) break;
  }
  return out;
}

function beaconAccountBlock() {
  const pc = globalThis.__beaconParseCount;
  const pageText = beaconDocs().map((d) => beaconNorm(d.body ? d.body.textContent : '')).join('');

  // 粉丝数与净增：后台首页概览的大数字。取不到就不给（不猜、不填 0）。
  //
  // ⚠️ 与作品指标同一个坑：「用户分析」页的四张指标卡同样可能是**数字在上、标签在下**
  //   （「320新增人数45取消关注人数275净增人数12800累计人数」）。按标签在前读，
  //   净增人数会读成 12800（那是累计人数）、累计人数则一个数都读不到——
  //   整排错位一格，而 12800 这种数看着完全正常。方向判定与作品指标共用同一套两端法。
  const numberFirst = beaconNumberFirst(pageText, FOLLOWER_LABELS.concat(FOLLOWER_DELTA_LABELS));
  const readLabeled = (labels) => {
    for (const l of labels) {
      const m = numberFirst
        ? pageText.match(new RegExp('([+\\-]?[\\d.,]+[万亿wWkK]?)[^\\d\\-+]{0,6}' + l))
        : pageText.match(new RegExp(l + '[^\\d\\-+]{0,6}([+\\-]?[\\d.,]+[万亿wWkK]?)'));
      if (!m) continue;
      const neg = m[1].startsWith('-');
      const n = pc(m[1].replace(/^[+\-]/, ''));
      if (n != null) return neg ? -n : n;
    }
    return undefined;
  };
  const followers = readLabeled(FOLLOWER_LABELS);
  const followerDelta = readLabeled(FOLLOWER_DELTA_LABELS);

  // 日期：后台概览通常是「今天/昨天」的数。用本地日期，与后端 YYYY-MM-DD 口径一致。
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const audience = {};
  for (const dim of AUDIENCE_DIMS) {
    const block = beaconFindBlock(dim.hints);
    if (!block) continue;
    const shares = beaconScanShares(block, dim.names);
    if (Object.keys(shares).length) audience[dim.key] = shares;
  }

  const out = {};
  if (followers != null || followerDelta != null) {
    out.dailyStats = [{ date, ...(followers != null ? { followers } : {}), ...(followerDelta != null ? { followerDelta } : {}) }];
  }
  if (Object.keys(audience).length) out.audience = audience;
  return Object.keys(out).length ? out : null;
}

// opts.withEvidence：额外带上每条作品的**行原文**，只给自检用（本地展示，不回传）。
// 采集路径一律不带——页面文本没有理由跑一趟服务器。
globalThis.__beaconParse = function (opts) {
  const withEvidence = !!(opts && opts.withEvidence);
  beaconResetDocs();
  const cfg = BACKENDS[location.hostname];
  // 自证一次：manifest 已限定 host，这里再挡一道，防将来 match 放宽后误采
  if (!cfg) return null;
  if (cfg.pathPrefix !== '/' && !location.pathname.startsWith(cfg.pathPrefix)) return null;

  const headers = beaconVisibleHeaders();

  const rows = beaconRowsFor(cfg);

  // 同一条作品会被匹配到**多个嵌套层级**（真机 2026-07-27 的公众号首页：153 行里 45 行有 ID，
  // 去重后只有 9 篇 —— 平均每篇有 5 层都被当成了「行」）。这些层抠出的是同一个 ID，
  // 但**文本范围天差地别**：最内层只圈住那一个数字，最外层裹进了整块界面文案。
  //
  // 旧规则是「取指标最全的那一层」。它当初是用来打败通知状态块的，但那个目的其实由
  // 上面的「一个指标都没抓到就跳过」已经达成了（状态块本来就抓不到数）。
  // 而「指标最全」在嵌套结构里恰恰选中**最外层**——层越大文本越多、蹭到的标签就越多，
  // 于是采到的是「这篇文章周围所有数字」而不是「这篇文章的数字」。
  // 真机症状：views=1 likes=2（在看比阅读还多，物理上不可能）。
  //
  // 改为**逐个指标各取最小作用域**：某个键由哪一层报出来，就看哪一层的文本范围最小——
  // 范围越小，这个数字与这篇文章的绑定越紧。既不会被外层的无关数字污染，
  // 也不会像「一律取最内层」那样丢掉只有卡片层才写的字段。
  const best = new Map();
  for (const row of rows) {
    const info = beaconRowIdInfo(row, cfg);
    const id = info.id;
    if (!id) continue;

    const metrics = beaconRowMetrics(row, headers);
    // 一个数都没抓到 → 不建空记录污染基线（后端也会 skip，这里先省一次往返）
    if (Object.keys(metrics).length === 0) continue;

    const text = beaconNorm(row.textContent);
    const scope = text.length; // 作用域大小：越小越贴身
    const t = beaconPickTitle(row, info.anchor);
    const publishedAt = beaconReadDateFor(row);

    let e = best.get(id);
    if (!e) {
      e = { id, metrics: {}, at: {}, title: '', titleFromAnchor: false, titleScope: Infinity, publishedAt: undefined, evidence: '' };
      best.set(id, e);
    }
    for (const k of Object.keys(metrics)) {
      if (e.at[k] === undefined || scope < e.at[k]) { e.metrics[k] = metrics[k]; e.at[k] = scope; }
    }
    // 标题**不按作用域挑**：产出这条 ID 的那个 <a> 的文字永远优先。
    // 最内层的小元素（比如只圈住一个数字的 span）没有链接，按类名兜底猜出来的
    // 反而是噪音——按作用域挑会让噪音赢。
    if (t.text && (
      (t.fromAnchor && !e.titleFromAnchor)
      || (t.fromAnchor === e.titleFromAnchor && scope < e.titleScope)
      || !e.title
    )) {
      e.title = t.text; e.titleFromAnchor = t.fromAnchor; e.titleScope = scope;
    }
    if (!e.publishedAt && publishedAt) e.publishedAt = publishedAt;
    // 现场证据留**最大**的那一层：自检要给人看的是「这篇文章周围到底写着什么」，
    // 范围越大越能看出数字是从哪个标签旁边读来的（只进自检文本，不入库）。
    if (text.length > e.evidence.length) e.evidence = text.slice(0, 400);
  }

  const posts = [];
  for (const c of best.values()) {
    posts.push({
      platformItemId: c.id,
      title: c.title,
      url: cfg.urlOf(c.id),
      ...(c.publishedAt ? { publishedAt: c.publishedAt } : {}),
      metrics: c.metrics,
      // 行原文**只在自检时**带上。后端 zod 会 strip 掉未知字段，但那是「存不下」，
      // 不是「没发出去」——页面文本没有理由跑一趟服务器。自检是本地展示，不发网络。
      ...(withEvidence ? { __evidence: c.evidence } : {}),
    });
    if (posts.length >= 50) break; // 与 ownPostIngestSchema 的 max(50) 对齐
  }

  // 页级来源分布只在**整页就这一条作品**时才算数（单篇详情页）。列表页上把全站来源
  // 按到每一篇头上，得到的是 10 篇一模一样的占比——那是错的数据，不是粗略的数据。
  if (posts.length === 1 && !posts[0].metrics.sources) {
    const s = beaconPageSources();
    if (s) posts[0].metrics.sources = s;
  }

  // 账号级数据（粉丝/画像）与作品级数据各自独立：只有其中一块也算这一趟有收获。
  // 用户可能正停在「粉丝分析」页而不是「作品数据」页——那时 posts 为空但画像抓得到。
  const account = beaconAccountBlock();
  if (posts.length === 0 && !account) return null;

  // handle 仅记日志、不参与归属（见 lib/ingest/own-post.ts）。自有作品按 platformItemId 对齐，
  // 不需要账号标识——少采一个身份标识就少一份数据。
  // channel 只进服务端的采集台账（哪次采的、覆盖哪几天），不参与归属判断。
  // 这条路一定是「在你自己的创作者后台里采的」，与作品页单篇采集要能分得开。
  return { platform: cfg.platform, handle: 'self', channel: 'plugin_backend', posts, ...(account ?? {}) };
};

// 供 popup 判断当前页是否是受支持的自有后台（与 SELF_SUPPORTED 正则互为双保险）
globalThis.__beaconSelfBackend = BACKENDS[location.hostname]?.platform ?? null;

