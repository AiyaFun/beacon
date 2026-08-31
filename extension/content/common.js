// 烽火台采集助手 · 内容脚本公共层。
// 职责：① 响应「采集本页」与智能降级解析；② 访问即采；③ 提供通用 DOM 提取服务。

function beaconParseCount(text) {
  if (text == null) return undefined;
  const t = String(text).replace(/[,\s]/g, '');
  const m = t.match(/([\d.]+)\s*(万|亿|w|W|k|K|m|M|b|B)?/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2];
  if (unit === '亿') return Math.round(n * 1e8);
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 1e4);
  if (unit === 'k' || unit === 'K') return Math.round(n * 1e3);
  if (unit === 'm' || unit === 'M') return Math.round(n * 1e6);
  if (unit === 'b' || unit === 'B') return Math.round(n * 1e9);
  return Math.round(n);
}
globalThis.__beaconParseCount = beaconParseCount;

// ── 单次回传的作品条数上限 ──
// **必须 ≤ 服务端 ingestPayloadSchema / ownPostIngestSchema 的 `posts.max(50)`**：
// 超一条不是「多的被截掉」，而是 zod 把**整批打回**，一条都不入库。
// 各站点解析器一律用它，别各写各的数字——此前 x.js 写 20、其余写 30，谁也没到 50，
// 于是翻页翻出来的作品会在解析器那一层被白白丢掉。
// 想要一次采更多，得先把服务端上限提上去**并且**给回传加分批，两件事一起做（见 README）。
const BEACON_POST_CAP = 50;
globalThis.__beaconPostCap = BEACON_POST_CAP;

// ── 带标签的统计数字（粉丝 / 关注 / 获赞 / Followers …）─────────────────────────
//
// 【为什么锚点是文字而不是埋点】平台的 data-e2e / class 是改版重灾区——抖音 2026-08-07
// 就把 `user-fans` 改成了 `user-info-fans`、`user-name` 直接删掉。而「粉丝」这两个字
// 多年没变过。所以这一层的铁律是：**标签文字是锚点，埋点只是加速器**（命中就少走一段扫描）。
// 埋点整批失效时照样出数，代价只是慢一点——但必须由下面三道闸挡住串台，
// 否则「自修复」修出来的是一个看着完全正常的错数字，比取不到更毒。
//
// 【为什么必须共用一份】此前五个站点各写各的，B站与小红书都写成
// `parseCount(t.replace('粉丝',''))` —— replace 只抠掉那两个字，
// 「关注 178 粉丝 328.3万」变成「关注 178  328.3万」，parseCount 取第一个数字，
// 于是**关注数被当成粉丝数**（178 vs 328万，差三个数量级）。
// 同一个坑抖音 07-29 踩过一次修掉了，这两家一直活着——各写各的就会各踩各的。
//
// 【三道闸】
//   ① **截断，不是替换**：只看标签**之后**（或数字在前版式下：标签**之前**）的那一段；
//   ② **到下一个标签为止**：统计栏是「关注 178 粉丝 328.3万 获赞 3023.8万」三个数挨着，
//      不设边界的话「粉丝」后面那三个数字都够得着；数字离标签超过 8 个字符也判为不相干；
//   ③ **同位判串台**：两个统计项若落在同一段文本的**同一个下标**上，说明截断根本没生效，
//      两个一起作废。按**位置**判而不是按数值相等判——「关注 100 粉丝 100」是可能的巧合，
//      位置撞了才是真串台，这个判据不会误伤。
const BEACON_STAT_MAX_LEN = 40; // 超过这个长度的节点文本基本是简介/正文，不是统计项
const BEACON_STAT_MAX_GAP = 8; // 数字与标签之间最多隔这么多字符（「粉丝：  24.1万」够用）
const BEACON_STAT_MAX_NODES = 5000; // 兜底扫描的硬上限，别在超大 DOM 上空转
const BEACON_STAT_NUM = /([\d][\d.,]*)\s*(万|亿|w|W|k|K|m|M|b|B)?/;

// 「标签在前」：粉丝24.1万
function beaconStatAfterLabel(text, label, otherLabels) {
  const i = text.indexOf(label);
  if (i < 0) return null;
  let tail = text.slice(i + label.length);
  let cut = tail.length;
  for (const other of otherLabels) {
    if (!other || other === label) continue;
    const j = tail.indexOf(other);
    if (j >= 0 && j < cut) cut = j;
  }
  tail = tail.slice(0, cut);
  const m = tail.match(BEACON_STAT_NUM);
  if (!m || m.index > BEACON_STAT_MAX_GAP) return null;
  // 时长（00:38）与占比（12%）都不是计数
  if (/^\s*[:：%]/.test(tail.slice(m.index + m[0].length))) return null;
  // ⚠️ 判时长要求冒号**前面是数字**（00:38），不能只看冒号——
  // 「粉丝：  24.1万」的冒号是分隔符，把它当时长会让整类带冒号的写法一个都读不到。
  if (/\d\s*[:：]\s*$/.test(tail.slice(0, m.index))) return null;
  const value = beaconParseCount(m[0]);
  // gap = 数字与标签之间隔了多远。两端都能取到时按它决定谁更可信（见 beaconStatIn）。
  return value != null && value > 0 ? { value, at: i + label.length + m.index, gap: m.index } : null;
}

// 「数字在前」：24.1万粉丝。中文站现在都是标签在前，但公众号后台的指标卡就是数字在上标签在下
// （self-backend.js 早为此做过两端法），改版翻转版式并不罕见——两端都试，标签在前优先。
function beaconStatBeforeLabel(text, label, otherLabels) {
  const i = text.indexOf(label);
  if (i < 0) return null;
  const head = text.slice(0, i);
  let start = 0;
  for (const other of otherLabels) {
    if (!other || other === label) continue;
    const j = head.lastIndexOf(other);
    if (j >= 0 && j + other.length > start) start = j + other.length;
  }
  const seg = head.slice(start);
  let last = null;
  const re = new RegExp(BEACON_STAT_NUM.source, 'g');
  for (let m = re.exec(seg); m; m = re.exec(seg)) last = m;
  if (!last) return null;
  // ⚠️ 匹配式尾部有 `\s*`（为了吃「328.3 万」这种数字与单位之间的空格），它会把**尾随空格
  // 一起吞掉**。拿 last[0].length 算距离，「关注 178 粉丝」里的 178 到「粉丝」的距离就成了 0，
  // 于是"数字在前"这一端永远以 0 分获胜——粉丝数被读成关注数。算距离必须先把尾随空白去掉。
  const end = last.index + last[0].replace(/\s+$/, '').length;
  const gap = seg.length - end;
  if (gap > BEACON_STAT_MAX_GAP) return null;
  if (/[:：%]/.test(seg.slice(end))) return null;
  const value = beaconParseCount(last[0]);
  return value != null && value > 0 ? { value, at: start + last.index, gap } : null;
}

// 两端都试，**取离标签更近的那个**。
//
// ⚠️ 不能简单地「标签在前优先」：一行里拼了多项时（YouTube 频道头
// 「@handle · 1.2M subscribers · 500 videos」），`subscribers` 后面跟着的是**下一项**的
// 500，标签在前的取法会一声不吭地把视频数当成订阅数。而 1.2M 就贴在标签左边——
// 谁离标签近谁才是它的数字，这是唯一不依赖版式假设的判据。
// 一样近时给「标签在前」（中文站的主流版式，「关注 178 粉丝 328.3万」两边都是 1 格）。
function beaconStatIn(text, labels, otherLabels) {
  for (const l of labels) {
    const a = beaconStatAfterLabel(text, l, otherLabels);
    const b = beaconStatBeforeLabel(text, l, otherLabels);
    if (a && b) return b.gap < a.gap ? b : a;
    if (a || b) return a || b;
  }
  return null;
}

/**
 * 在当前页面上读一组统计项。
 *
 * @param specs  [{ key, labels, e2e? }] —— key 是输出字段名，labels 按优先级排（先中先用），
 *               e2e 是**加速用**的选择器（可写多个，逗号分隔），失效不影响出数。
 * @param scopes 统计栏所在容器的选择器（按优先级）。**兜底扫描必须先限定在容器里**：
 *               登录态下页面别处（头像面板、侧边「我的」）同样写着「粉丝 N」，
 *               那是**你自己的**数字，按文档序取第一个就会写进竞对档案。
 *               容器一个都认不出来才退回全页——宁可退化，不要空手。
 * @returns { values: {key:number}, via: {key:'e2e'|'text'|null} }
 *          via 是**降级留痕**：全站的 e2e 突然集体变成 text，就是平台改版了。
 *          这条信号会随回传上行（见 lib/ingest/competitor.ts 的埋点失效告警）——
 *          没有它，"自修复"成功与否没有任何人知道，只能等用户对着页面核数字。
 */
function beaconReadStats(specs, scopes = []) {
  const allLabels = specs.flatMap((s) => s.labels);
  const values = {};
  const via = {};
  for (const s of specs) via[s.key] = null;

  // 一、埋点直取（加速器）。埋点可能挂在带标签的块上，也可能挂在纯数字上。
  for (const s of specs) {
    if (!s.e2e) continue;
    let el = null;
    try { el = document.querySelector(s.e2e); } catch { el = null; }
    if (!el) continue;
    const txt = (el.textContent || '').trim();
    let hit = beaconStatIn(txt, s.labels, allLabels);
    if (!hit && txt.length <= 12 && !allLabels.some((l) => txt.includes(l))) {
      const v = beaconParseCount(txt);
      if (v != null && v > 0) hit = { value: v, at: 0 };
    }
    if (hit) { values[s.key] = hit.value; via[s.key] = 'e2e'; }
  }

  // 二、文本扫描（真正的锚点）
  const claimed = new Map(); // "节点序号:下标" -> key（或 CONTESTED），闸③用
  // 判过串台的位置要**永久作废**，不能只是把认领撤掉。撤掉的话这个位置就空了出来，
  // 排在后面的第三项会一声不吭地把它认领走：
  //   「粉丝关注获赞 328.3万」→ 关注与粉丝互撞、双双作废，然后**获赞**捡走 328.3万。
  // 标签挤在一个节点、数值单独渲染的版式（左标签列 + 右数值列）就是这个形状。
  // 闸③的意义是「这个数字归属不明」，归属不明对第三项同样成立。
  const CONTESTED = Symbol('contested');
  let idx = 0;
  let scanned = 0;
  const scan = (roots) => {
    for (const root of roots) {
      if (!root) continue;
      for (const node of [root, ...root.querySelectorAll('div, span, p, a, strong, h1, h2')]) {
        if (++scanned > BEACON_STAT_MAX_NODES) return;
        idx++;
        const txt = (node.textContent || '').trim();
        if (!txt || txt.length > BEACON_STAT_MAX_LEN) continue;
        for (const s of specs) {
          if (values[s.key] != null) continue; // 埋点或更早的节点已经给出了
          const hit = beaconStatIn(txt, s.labels, allLabels);
          if (!hit) continue;
          const pos = `${idx}:${hit.at}`;
          const owner = claimed.get(pos);
          if (owner === CONTESTED) continue; // 这个位置已判定归属不明，后面谁都不许再捡
          if (owner && owner !== s.key) {
            // 闸③：同一段文本的同一个下标被两项认领 = 截断没生效，两项一起作废
            delete values[owner];
            via[owner] = null;
            claimed.set(pos, CONTESTED);
            continue;
          }
          claimed.set(pos, s.key);
          values[s.key] = hit.value;
          via[s.key] = 'text';
        }
      }
    }
  };

  const roots = scopes
    .map((sel) => { try { return document.querySelector(sel); } catch { return null; } })
    .filter(Boolean);
  scan(roots.length ? roots : [document.body || document.documentElement]);

  // ⚠️ 容器选中了、里面却一项都没有 → **全页无歧义兜底**。
  //
  // 这一条是给「scopes 写错了」兜底的。容器选择器是各平台各写一套的猜测，写错时最坏的形态
  // 不是「没 narrow 住」，而是**选中了一个不含统计栏的元素** → 扫出空 → 粉丝数变空，
  // 那正是这轮要修的那个 bug，绝不能由防串台的措施自己再造一个出来。
  //
  // 但直接退回全页扫会捞到页面顶部**你自己的**「粉丝 N」（容器约束本来就是为挡它而加的）。
  // 所以只认**整页上取值唯一**的那一项：页面上同时出现两个不同的「粉丝 N」时一律不给。
  // 猜错的代价不对称——空值下游还有侧栏的「粉丝 —（没读到）」和 via 降级告警接着，
  // 错值会被直接写进全局共享的竞对档案，还会喂给基线和同行对比，且没有一键撤销。
  //
  // ⚠️ 判据是「**一项都没取到**」而不是「有项没取到」：容器只要给出了任何一项就说明它是对的，
  // 那时某一项缺失是页面本来就没展示它，再去全页找纯属自找麻烦。
  if (roots.length && Object.keys(values).length === 0) {
    const cand = new Map(); // key -> Set(取值)
    const seenAt = new Map(); // "节点序号:下标" -> key，闸③在兜底路径上同样要生效
    let n = 0;
    const all = document.body || document.documentElement;
    for (const node of all ? [all, ...all.querySelectorAll('div, span, p, a, strong, h1, h2')] : []) {
      if (++n > BEACON_STAT_MAX_NODES) break;
      const txt = (node.textContent || '').trim();
      if (!txt || txt.length > BEACON_STAT_MAX_LEN) continue;
      for (const s of specs) {
        const hit = beaconStatIn(txt, s.labels, allLabels);
        if (!hit) continue;
        // 同一段文本的同一个下标被两项认领 = 截断没生效，两项在本轮一起弃权。
        // 兜底路径不能因为"只收集不判定"就把闸③漏掉——串台在这条路上照样会发生。
        const pos = `${n}:${hit.at}`;
        const owner = seenAt.get(pos);
        if (owner && owner !== s.key) {
          cand.set(owner, null);
          cand.set(s.key, null);
          continue;
        }
        seenAt.set(pos, s.key);
        if (cand.get(s.key) === null) continue; // 已经被判过串台，不再收
        if (!cand.has(s.key)) cand.set(s.key, new Set());
        cand.get(s.key).add(hit.value);
      }
    }
    for (const s of specs) {
      const set = cand.get(s.key);
      if (set && set.size === 1) {
        values[s.key] = [...set][0];
        via[s.key] = 'text';
      }
    }
  }
  return { values, via };
}
globalThis.__beaconReadStats = beaconReadStats;

// ── 「这一页是我自己的号吗？」──
//
// 每个平台的**我的主页与竞对主页都是同一种页面**（同域名、同 DOM、同结构），页面本身分不出是谁的。
// 唯一稳定的差别是：本人主页会露出只有自己看得见的入口（「编辑资料」「自定义频道」…），
// 别人的主页则是「关注 / 订阅 / 发私信」。
//
// ⚠️ 两条铁律：
//   ① **只认阳性信号**。找到就返回 true，找不到返回 undefined（「不确定」），
//      **绝不返回 false**——平台改版会让文案变，那时正确的退路是让用户自己确认一次，
//      而不是一口咬定「这不是你的号」，把一个能用的功能变成永远打不开的门。
//   ② 按**文本**匹配而不是 class：这些站点的 class 是构建期生成的哈希，改版必失效，
//      而「编辑资料」这几个字多年没变过。
//
// 认错的代价不对称：漏认（该 true 却 undefined）= 用户多点一次确认；
// 误认（不是本人却 true）= 竞对的几十条内容被写成你自己的发布记录，且没有一键撤销。
// 所以宁可漏认。
function beaconLooksLikeSelf(labels, scopeSelector) {
  try {
    const scope = (scopeSelector && document.querySelector(scopeSelector)) || document;
    const nodes = scope.querySelectorAll(
      'button, a, span[class*="edit"], div[class*="edit"], yt-button-shape, tp-yt-paper-button',
    );
    let i = 0;
    for (const el of nodes) {
      if (++i > 300) break; // 兜底：别在超大 DOM 上空转
      const t = (el.textContent || '').trim();
      // 限长：避免把「…点击编辑资料…」这种长句子里的子串当成按钮命中
      if (t && t.length <= 12 && labels.includes(t)) return true;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
globalThis.beaconLooksLikeSelf = beaconLooksLikeSelf;

// ── 智能兜底解析器 (保证任何支持平台的页面都不会返回 "解析失败") ──
function beaconFallbackParse() {
  const host = location.hostname;
  let platform = 'bilibili';
  if (host.includes('douyin.com')) platform = 'douyin';
  else if (host.includes('xiaohongshu.com')) platform = 'xiaohongshu';
  else if (host.includes('youtube.com')) platform = 'youtube';
  else if (host.includes('tiktok.com')) platform = 'tiktok';
  else if (host.includes('x.com') || host.includes('twitter.com')) platform = 'x';

  const href = location.href;
  let handle = '';

  if (platform === 'bilibili') {
    const m = href.match(/space\.bilibili\.com\/(\d+)/) || href.match(/video\/(BV\w+)/);
    if (m) handle = m[1];
  } else if (platform === 'douyin') {
    const m = href.match(/user\/([^/?]+)/) || href.match(/video\/(\d+)/);
    if (m) handle = m[1];
  } else if (platform === 'xiaohongshu') {
    const m = href.match(/profile\/([a-zA-Z0-9_]+)/) || href.match(/(?:explore|item|discovery\/item)\/([a-zA-Z0-9_]+)/);
    if (m) handle = m[1];
  } else if (platform === 'youtube') {
    // ⚠️ 两条都踩过（真机 2026-07-28「采 YouTube 没采到对应频道的账号」）：
    // ① handle 必须**带 @**，与 lib/competitor-url.ts / content/youtube.js 一致。
    //    去掉 @ 会让同一个频道被建成两个竞对（'MrBeast' 和 '@MrBeast'），
    //    而「访问即采」按 platform+handle 比对，从此再也匹配不上已订阅的那个。
    // ② **视频 ID 绝不能当频道 handle**。老代码在 /watch 页拿 v= 当 handle，
    //    于是竞对库里会冒出一个以视频 ID 命名的"频道"——那不是采得不准，是凭空造账号。
    // ③ handle 可能是中文（URL 里是百分号编码），要解成原文——否则与库里存的原文对不上，
    //    拼主页地址时还会被二次编码成 404（真机 2026-07-28 的 @傑少JAY）。
    const decYt = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    const at = href.match(/youtube\.com\/(@[^/?#]+)/);
    const ch = href.match(/youtube\.com\/channel\/([\w-]+)/);
    handle = at ? decYt(at[1]) : ch ? ch[1] : '';
  } else if (platform === 'tiktok') {
    // 与 content/tiktok.js / lib/competitor-url.ts 同口径：**只认 /@<unique_id>，且不带 @ 存**。
    // 功能页（/foryou /explore /live /tag/… /tiktokstudio）一律不带 @，靠这一条就全排掉了；
    // 认不出**绝不往下走**——下面那行兜底会把路径片段当 handle，在共享的竞对库里
    // 造出名为 'explore'、'foryou' 的假账号（YouTube 上就是这么造出过假频道的）。
    const m = href.match(/tiktok\.com\/@([^/?#]+)/);
    if (!m) return null;
    try { handle = decodeURIComponent(m[1]); } catch { handle = m[1]; }
  } else if (platform === 'x') {
    const m = href.match(/(?:x|twitter)\.com\/([^/?]+)/);
    if (m && !['home', 'explore', 'notifications', 'messages'].includes(m[1])) handle = m[1];
  }

  // YouTube 的频道身份只能来自 /@handle 或 /channel/<id>。拿不到就**不猜**：
  // 下面那行兜底会把路径片段当 handle（在 /watch、/results、/feed 上分别造出
  // 名为 'watch'、'results'、'feed' 的"竞对账号"）。宁可如实报「没解析出账号」，
  // 也不要在工作区共享的竞对库里凭空建一个不存在的频道。
  if (platform === 'youtube' && !handle) return null;

  if (!handle) {
    handle = location.pathname.replace(/^\//, '').replace(/\//g, '_') || 'page_item';
  }

  const name =
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('meta[name="author"]')?.content ||
    document.querySelector('.nickname, #h-name, h1, title')?.textContent?.trim() ||
    '小红书/社交创作者';

  const posts = [];
  const pageTitle = (document.querySelector('meta[property="og:title"]')?.content || document.title || '').trim();

  let itemId = handle;
  if (href.includes('BV')) {
    const m = href.match(/(BV\w+)/);
    if (m) itemId = m[1];
  } else if (href.match(/\/(video|explore|item|status)\/(\w+)/)) {
    const m = href.match(/\/(video|explore|item|status)\/(\w+)/);
    if (m) itemId = m[2];
  }

  posts.push({
    platformItemId: itemId,
    title: pageTitle.slice(0, 300),
    url: href,
    metrics: {},
  });

  return {
    platform,
    handle,
    profile: { name: name.slice(0, 100) },
    posts,
  };
}
globalThis.beaconFallbackParse = beaconFallbackParse;

// ── 兜底不许把站点解析器已经采到的东西一起扔掉 ──
//
// 兜底解析器只认得出「平台 + handle + 当前这一页」，**它从不看统计栏，给不出 followers**。
// 而触发兜底的条件是「posts 为空」——作品栅格没渲染出来（虚拟列表回收、未登录、改版）时，
// 顶部的粉丝数往往好好地摆在那儿、站点解析器也确实读到了。整包替换 = 连粉丝数一起丢。
//
// 丢了的后果是**永久的**：lib/ingest/competitor.ts 只在 `followers != null` 时才更新档案，
// 建档那次给的是 `?? 0`，于是这个竞对的粉丝数会一直停在 0；而竞对清单是
// `followers > 0 ? 显示 : 不显示`（CompetitorRoster.tsx），用户看到的现象就是「粉丝数没有」。
// 所以按字段补，不整包换：站点解析器给得出的字段一律它说了算（它比按 og:title 猜的准）。
// ⚠️ followersVia 必须一起搬。它是「这个粉丝数是怎么读到的」，服务端靠它判断插件有没有降级
// （lib/ingest/parser-health.ts）。而触发兜底的条件恰恰是「作品栅格没解析出来」——
// **页面刚改版**时最先落空的就是它。也就是说：漏搬这个字段，降级告警会在最该响的那一次静默，
// 而这正是整套告警要抓的那个场景。via='none'（明确没读到）同理，漏搬就成了「没表态」。
// 这与 2026-08-07「字段在回传链路上蒸发」是同一类错误，只是换了一段路。
const BEACON_PROFILE_KEYS = ['name', 'followers', 'followersVia', 'avatar', 'bio'];

function beaconMergeFallback(site, fallback) {
  if (!fallback) return site || null;
  if (!site || !site.profile) return fallback;
  const profile = { ...fallback.profile };
  for (const k of BEACON_PROFILE_KEYS) {
    if (site.profile[k] != null && site.profile[k] !== '') profile[k] = site.profile[k];
  }
  return { ...fallback, profile };
}
globalThis.__beaconMergeFallback = beaconMergeFallback;

// ── 当前页面正文（只喂给 AI 助手）──
// AI 助手此前拿到的「上下文」只有标题 + 几个数字，于是「爆款要点拆解」拆的其实是**一个标题**：
// 用户满屏正文摆在眼前，助手却在猜内容。这里把可见正文取一段带上去。
//
// 三条约束：
//   ① 只在用户**主动点**「拆解 / 衍生选题 / 发送」时才取、才发（不随页面加载上传任何东西）；
//   ② 有硬上限——整页文字动辄几万字，超上下文不说，真正相关的那段还会被淹掉；
//   ③ 跳过我们自己注入的侧栏（`#beacon-ai-root`），否则助手会把自己上一轮的回答当成页面内容。
const PAGE_TEXT_CAP = 4000;
function beaconPageText(cap = PAGE_TEXT_CAP) {
  try {
    const root = document.getElementById('beacon-ai-root');
    const mine = (el) => !!(root && el && root.contains(el));
    const parts = [];
    const push = (el) => {
      if (!el || mine(el)) return;
      const t = (el.innerText || el.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (t) parts.push(t);
    };
    // 信息流站点（X/微博这类）：正文散在多条 article 里，取 main.innerText 会把整条时间线
    // 连同侧栏推荐一起卷进来。有 article 就按条取前几条，没有才退回主区域。
    //
    // ⚠️ 先把**我们自己注入的**那些排掉再判断走哪个分支：侧栏本身可能含 article，
    // 若只在 push 里挡，"页面只有侧栏里那一个 article" 的情况会走进这条分支、被挡光，
    // 最后返回空串——正文明明就在 main 里。
    const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"], article')).filter((a) => !mine(a));
    if (arts.length) for (const a of arts.slice(0, 8)) push(a);
    else push(document.querySelector('main, [role="main"]') || document.body);
    return parts.join('\n---\n').trim().slice(0, cap);
  } catch {
    return '';
  }
}
globalThis.beaconPageText = beaconPageText;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 页面正文：popup / SidePanel 是扩展页面，够不到页面 DOM，只能向内容脚本要
  if (msg?.type === 'beacon-page-text') {
    // 【为什么这里要分两种来源】这个内容脚本挂在 <all_urls> 上，也就是**每一个网页**。
    // 用户自己点侧栏上的按钮要正文，是他当场对着这一页发起的，理所当然。
    // 但 2026-08-21 起服务端也能派活让插件去读网页（open_and_read），
    // 那条路上「读哪一页」是**服务端说了算**的——两者必须分开对待。
    //
    // 派活来的请求带 forTask 标记，此时这一页必须落在插件端硬编码的白名单里。
    // 不加这道闸的话，服务端下发一个 URL 就能读走用户任何一个已登录页面的全文
    //（包括他公司的内网系统）。服务端也校验白名单，但那份不算数：
    // 插件连的服务端地址是可配的，只信服务端等于没有防线。
    if (msg.forTask) {
      const ok = typeof globalThis.beaconReadAllowed === 'function'
        && globalThis.beaconReadAllowed(location.href);
      if (!ok) {
        sendResponse({ ok: false, error: '这一页不在允许读取的站点清单里' });
        return undefined;
      }
    }
    sendResponse({ ok: true, text: beaconPageText(msg.cap), title: document.title, url: location.href });
    return undefined;
  }
  // 自有后台自检：解析失败时告诉用户断在哪一步（选择器？列名？），
  // 而不是只给一句「回填 0 条」让人无从下手。见 self-backend.js __beaconSelfDiagnose。
  if (msg?.type === 'beacon-diagnose') {
    try {
      sendResponse(
        typeof globalThis.__beaconSelfDiagnose === 'function'
          ? globalThis.__beaconSelfDiagnose()
          : { ok: false, reason: '当前页面不是受支持的创作者后台' },
      );
    } catch (e) {
      sendResponse({ ok: false, reason: `自检异常: ${e?.message || e}` });
    }
    return undefined;
  }
  if (msg?.type !== 'beacon-collect') return undefined;
  // 翻页采集要滚动 + 等懒加载，是**异步**的 —— 必须 `return true` 把消息通道留着，
  // 否则 sendResponse 根本发不出去，界面上就是按钮永远停在「采集中…」
  //（同 sw.js 顶部记的那个「按钮永远停在回填中」的老毛病，一模一样的成因）。
  //
  // 什么时候翻页：用户显式点了采集（deep），或这一页本来就在后台标签页里
  //（批量采集打开的那种，document.hidden）。用户正看着的页面不滚。
  const deep = msg.deep === true || document.hidden === true;
  beaconRunCollect(deep).then(sendResponse).catch((e) => sendResponse({ ok: false, error: `解析异常: ${e?.message || e}` }));
  return true;
});

async function beaconRunCollect(deep) {
  try {
    let payload = null;
    if (typeof globalThis.__beaconParse === 'function') {
      try {
        // 创作者后台**不翻页**：那儿是分页按钮而不是滚动加载，且 self-backend.js 的解析
        // 一次要扫整张表，反复跑只是白烧 CPU。这条路是全插件最脆的一段，不动它。
        payload = deep && !globalThis.__beaconSelfOnly
          ? await beaconCollectDeep(globalThis.__beaconParse)
          : globalThis.__beaconParse();
      } catch (e) {
        console.warn('[Beacon] 站点特定解析失败，启动智能兜底:', e);
      }
    }

    // 自有创作者后台**绝不走兜底解析**：beaconFallbackParse 是给竞对公开页写的，
    // 认不出域名时默认 platform='bilibili'——在 mp.weixin.qq.com / channels.weixin.qq.com /
    // member.bilibili.com 上会把公众号/视频号的数据报成 B站，再按路径瞎凑一个 platformItemId。
    // 后台页解析失败的正常原因是表格还没渲染完，正确做法是让用户刷新重试，不是猜一个平台。
    if (globalThis.__beaconSelfOnly) {
      // 作品级（posts）与账号级（dailyStats/audience）各自独立：只有其中一块也算有收获。
      // 用户可能正停在「粉丝分析」页而不是「作品数据」页——那时 posts 为空但画像抓得到。
      const gotPosts = payload && payload.posts && payload.posts.length > 0;
      const gotAccount = payload && (payload.dailyStats || payload.audience);
      if (!gotPosts && !gotAccount) {
        return { ok: false, error: '没读到数据——请确认已打开「数据中心 · 作品数据」或「粉丝/受众分析」页并等内容加载完，再试一次' };
      }
      return { ok: true, payload };
    }

    if (!payload || !payload.handle || !payload.posts || payload.posts.length === 0) {
      payload = beaconMergeFallback(payload, beaconFallbackParse());
    }

    if (!payload || !payload.handle) {
      // 认不出账号 = 这个平台的解析多半失效了（改版）。留一份**脱敏结构骨架**给服务端，
      // 让运维台那边能让模型推断新锚点，而不是等下一次有人来报「采不到」。
      beaconReportParseMiss(beaconPlatformOf(), 'rival', 'handle');
      return { ok: false, error: '未能解析出有效的账号/作品信息，请刷新页面后重试' };
    }
    // 采到了作品却没读到粉丝数：这正是「主页统计栏改版」的典型形状（作品栅格没动、统计栏动了）。
    // 不打断本次回传（作品数据照常入库），只顺手留一份样本。
    if (payload.posts && payload.posts.length > 0 && (payload.profile == null || payload.profile.followers == null)) {
      beaconReportParseMiss(payload.platform || beaconPlatformOf(), 'rival', 'followers');
    }
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, error: `解析异常: ${e?.message || e}` };
  }
}

// ── 访问即采 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 翻页采集（滚动加载更多作品）────────────────────────────────────────────
//
// 这些站点的作品栅格都是**懒加载**的：首屏通常只渲染 18–20 张卡片，剩下的要往下滚才去请求。
// 于是「采集本页」一直只采到首屏那点东西——一个 478 条作品的抖音号也只采到 20 条，
// 用户看到的现象就是「采不全」。
//
// 做法：解析 → 把**最后一条**作品的链接滚进视野 → 等一会儿再解析，直到够 50 条、
// 或连着两轮不再增长、或超出时间预算。
// 用 `scrollIntoView` 而不是 `window.scrollTo`：前者会带动元素**所在的那个滚动容器**，
// 不用去猜这一版页面到底是整页滚还是某个内层 div 在滚（各平台不一样，还会改版）。
//
// 三条约束：
//   ① **不主动滚用户正在看的页面**。只有用户显式点了采集（deep），或页面本来就在后台标签页里
//      （批量采集打开的那种，`document.hidden`）才滚——在用户眼皮底下把页面拽到底很粗暴。
//   ② 采完把滚动位置**还回去**，用户切回来时还在原地。
//   ③ 有硬预算（轮数 + 墙钟），页面怎么表现都会停：宁可少采几条，不能挂在那儿空转
//      （同 sw.js fetchWithTimeout 的道理——「让失败可见」比「万一能成」重要）。
const DEEP_MAX_ROUNDS = 12;
const DEEP_BUDGET_MS = 30000;
const DEEP_ROUND_MS = 900;
const DEEP_IDLE_ROUNDS = 2; // 连着这么多轮没长 = 到底了，或者加载不动了

// 用**作品 ID 反查它在页面上的链接**当滚动锚点：各平台卡片结构天差地别，
// 但作品链接里一定带着这个 ID，这是唯一跨平台通用的定位方式。
function beaconScrollAnchor(payload) {
  const posts = payload && payload.posts;
  const last = posts && posts.length ? posts[posts.length - 1] : null;
  const id = last && last.platformItemId;
  if (!id) return null;
  try {
    return document.querySelector(`a[href*="${CSS.escape(String(id))}"]`);
  } catch {
    return null;
  }
}

async function beaconCollectDeep(parse) {
  const scroller = document.scrollingElement || document.documentElement;
  const startY = scroller ? scroller.scrollTop : 0;
  const deadline = Date.now() + DEEP_BUDGET_MS;
  let payload = null;
  try {
    payload = parse();
  } catch {
    return null;
  }
  let idle = 0;
  for (let round = 0; round < DEEP_MAX_ROUNDS; round++) {
    const count = (payload && payload.posts && payload.posts.length) || 0;
    if (count >= BEACON_POST_CAP || Date.now() > deadline) break;
    beaconLiveStep(`滚动加载第 ${round + 1} 屏（已见 ${count} 条作品）…`);
    const anchor = beaconScrollAnchor(payload);
    try {
      if (anchor) anchor.scrollIntoView({ block: 'end' });
      else if (scroller) scroller.scrollTop = scroller.scrollHeight;
      // 有些站点的懒加载挂在 window 上而不是内层容器，两边都推一把
      window.scrollBy(0, window.innerHeight);
    } catch { /* 页面不给滚就算了，下一轮照样重新解析 */ }
    await sleep(DEEP_ROUND_MS);
    let next = null;
    try {
      next = parse();
    } catch { /* 解析在中途抛错不影响已经采到的那些 */ }
    const nextCount = (next && next.posts && next.posts.length) || 0;
    // **只在不倒退时替换**：懒加载常把已渲染的卡片回收掉（虚拟列表），
    // 那一瞬间解析出来的条数会变少，拿它覆盖会把前面采到的全丢了。
    if (next && nextCount >= count) payload = next;
    idle = nextCount > count ? 0 : idle + 1;
    if (idle >= DEEP_IDLE_ROUNDS) break;
  }
  try {
    if (scroller) scroller.scrollTop = startY;
  } catch { /* ignore */ }
  return payload;
}
globalThis.__beaconCollectDeep = beaconCollectDeep;

// ── 执行可视化的进度卡（0.9.10）─────────────────────────────────────────────
//
// 只有 SW 确认「这一页是本轮可视化执行开的」才渲染（live:query）；用户自己浏览
// 触发的「访问即采」永远不弹卡。卡是纯 DOM 叠加，不碰页面自身的任何元素。
let beaconLiveCard = null;

function beaconLiveStep(text) {
  try {
    if (!beaconLiveCard) return; // 没在可视化：所有 step 调用都是无声无息的 no-op
    const line = document.createElement('div');
    line.textContent = text;
    line.style.cssText = 'opacity:.92;padding:2px 0';
    const list = beaconLiveCard.querySelector('[data-live-steps]');
    list.appendChild(line);
    while (list.children.length > 6) list.removeChild(list.firstChild); // 只留最近几步
  } catch { /* ignore */ }
}
globalThis.__beaconLiveStep = beaconLiveStep;

function beaconLiveDone(ok) {
  try {
    if (!beaconLiveCard) return;
    beaconLiveStep(ok ? '✓ 采集完成，即将关闭本页' : '✗ 这一页没采到（可能要登录或没加载完）');
    const head = beaconLiveCard.querySelector('[data-live-title]');
    head.style.color = ok ? '#4ade80' : '#f87171';
  } catch { /* ignore */ }
}

async function beaconLiveInit() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'live:query' }).catch(() => null);
    if (!r || r.live !== true) return;
    const el = document.createElement('div');
    el.id = 'beacon-live-card';
    el.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647', 'width:300px',
      'padding:12px 14px', 'border-radius:12px', 'background:rgba(17,17,17,.92)', 'color:#fff',
      'font:12.5px/1.6 -apple-system,"PingFang SC",sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.35)', 'backdrop-filter:blur(6px)',
      'pointer-events:none', // 绝不挡用户点页面
    ].join(';');
    el.innerHTML = '<div data-live-title style="font-weight:600;margin-bottom:6px"></div><div data-live-steps></div>';
    el.querySelector('[data-live-title]').textContent = r.title || '烽火台正在采集';
    (document.body || document.documentElement).appendChild(el);
    beaconLiveCard = el;
    beaconLiveStep('已打开页面，等待渲染…');
  } catch { /* ignore */ }
}
// ⚠️ 这里**不注册第二个 onMessage 监听器**：收尾状态由 beaconAutoCollect 回传成功后
// 就地调 beaconLiveDone——内容脚本自己就知道结果，不需要 SW 发消息回来。
// （第一版注册过一个 live:done 监听，把单测桩里「只保留最后一个监听器」的主通道顶掉了，
// 采集消息从此无人应答；生产里多监听虽然合法，但能不加第二个就不加。）
beaconLiveInit();

function beaconToast(text, ok) {
  try {
    const id = 'beacon-toast';
    document.getElementById(id)?.remove();
    const el = document.createElement('div');
    el.id = id;
    el.textContent = text;
    el.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'max-width:280px', 'padding:10px 14px', 'border-radius:10px',
      'font:13px/1.5 -apple-system,"PingFang SC",sans-serif', 'color:#fff',
      `background:${ok ? '#16a34a' : '#dc2626'}`, 'box-shadow:0 4px 16px rgba(0,0,0,.25)',
      'opacity:0', 'transition:opacity .2s',
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = '1'));
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4200);
  } catch { /* ignore */ }
}

async function beaconAutoCollect() {
  try {
    const { autoCollect } = await chrome.storage.sync.get('autoCollect');
    if (autoCollect === false) return;
    // 自有数据站点（视频号/公众号/抖音/小红书/B站 创作者后台）永不参与「访问即采」：那是你自己的后台数据，
    // 只能由用户在插件里显式点「这是我的作品 · 回填数据看板」走 /api/ingest/self，
    // 绝不走竞对通道。判定放在首个 await 之后——站点脚本（self-backend.js）在 common.js
    // 之后同步执行，到这里标记必定已置上。
    if (globalThis.__beaconSelfOnly) return;
    const parse = globalThis.__beaconParse || beaconFallbackParse;

    let competitors = [];
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'beacon-get-competitors' });
      competitors = resp?.competitors || [];
    } catch {
      return;
    }
    if (!competitors.length) return;

    beaconLiveStep('解析页面数据…');
    let payload = null;
    for (let i = 0; i < 15; i++) {
      payload = parse();
      if (payload && payload.handle && payload.posts && payload.posts.length > 0) break;
      await sleep(600);
    }
    if (!payload || !payload.handle) return;

    const subscribed = competitors.some(
      (c) => c.platform === payload.platform && String(c.handle) === String(payload.handle),
    );
    if (!subscribed) return;
    if (!payload.posts || payload.posts.length === 0) return;

    // 确认是已订阅的竞对之后，再翻几页把首屏之外的作品带上（首屏通常只有 18–20 条）。
    // 翻页的边界是「**绝不滚用户自己在看的页**」，落成判据是两种情况才滚：
    //   ① 后台标签页（document.hidden）——批量采集默认形态，用户看不见，滚它没有代价；
    //   ② 本页是可视化执行的工作页（beaconLiveCard 存在，即 SW 在 live:query 里认过账）——
    //      页面是插件自己开并放到前台**给用户看**的，滚动本身就是要展示的过程。
    //      少了这半句，开可视化会静默退化成只采首屏（前台 ≠ 用户自己的页）。
    // 用户自己浏览竞对主页触发的「访问即采」两条都不满足：前台且无卡，照旧一律不滚。
    // 放在订阅判定之后：不订阅的号本来就不回传，没必要为它滚一遍页面。
    if (document.hidden || beaconLiveCard) {
      beaconLiveStep('开始翻页，采集首屏之外的作品…');
      const deeper = await beaconCollectDeep(parse);
      if (deeper && deeper.posts && deeper.posts.length > payload.posts.length) payload = deeper;
    }

    beaconLiveStep(`回传烽火台（${payload.posts.length} 条作品）…`);
    const r = await chrome.runtime.sendMessage({ type: 'beacon-ingest', payload });
    try {
      chrome.runtime.sendMessage({ type: 'beacon-collected', platform: payload.platform, handle: payload.handle, ok: !!r?.ok });
    } catch { /* ignore */ }
    beaconLiveDone(!!r?.ok);
    if (r?.ok) beaconToast(`✓ 已自动采集「${r.competitor}」${r.withMetrics ?? r.posts} 条作品`, true);
    else if (r?.error) beaconToast(`采集未成功：${r.error}`, false);
  } catch { /* ignore */ }
}

beaconAutoCollect();


// ── 采集自学习：脱敏结构骨架 ────────────────────────────────────────────────
//
// 采不到字段时，把**页面结构的形状**上传给服务端，让模型推断新锚点（平台改版后不必等发版）。
//
// 🔒 这里是隐私的第一道闸，规矩只有一条：**只上传形状，不上传内容**。
//    · 标签名、类名、data-*/aria-* 的**属性名**（不含值——值里可能是用户 ID）；
//    · 文本一律过 shape()：数字→NUM、长中文→CJK，只保留「粉丝」「获赞」这类两字以内的标签词
//      （它们正是文本锚点本身，不带个人信息）；
//    · 不含 href / src / alt / 图片 / 正文 / 昵称。
//    服务端收到后**还会再脱敏一次**（lib/ingest/parser-learn.ts）——两道闸，谁也不信谁。

function beaconTextShape(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  // 一次扫描替换，不能链式：链式会把上一步产出的 'NUM'/'CJK' 再替换成 'EN'
  //（与服务端 lib/ingest/parser-learn.ts 的 textShape 同一口径，两边要一起改）
  return t
    .replace(/(\d+(?:\.\d+)?)|([一-龥]+)|([A-Za-z]{3,})/g, (m, num, cjk, en) => {
      if (num) return 'NUM';
      if (cjk) return cjk.length <= 2 ? cjk : 'CJK';
      // 【幂等】NUM/CJK/EN 是成形记号，不是英文单词。服务端会再成形一遍，
      // 不认它们的话「粉丝 NUM万」会变成「粉丝 EN万」（与服务端同一处修复，两边口径必须一致）
      if (en) return en === 'NUM' || en === 'CJK' || en === 'EN' ? en : 'EN';
      return m;
    })
    .slice(0, 24);
}

const BEACON_SKELETON_ATTR = /^(data-[\w-]+|aria-[\w-]+|role|type|id)$/;

/** 从一个根节点抽结构骨架。深度与广度都封顶——整页 DOM 既喂不进模型，也不该上传。 */
function beaconSkeleton(root, depth) {
  const el = root || document.body;
  const d = depth == null ? 0 : depth;
  if (!el || !el.tagName || d > 6) return null;
  const node = { tag: el.tagName.toLowerCase() };
  if (el.classList && el.classList.length) node.cls = Array.from(el.classList).slice(0, 6);
  const attrs = [];
  for (const a of Array.from(el.attributes || [])) {
    if (BEACON_SKELETON_ATTR.test(a.name)) attrs.push(a.name);
  }
  if (attrs.length) node.attrs = attrs.slice(0, 8);

  // 只取**直接**文本子节点的形状：整棵子树的 innerText 会把正文也带上
  const own = Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent)
    .join(' ')
    .trim();
  if (own) node.shape = beaconTextShape(own);

  const kids = Array.from(el.children || []).slice(0, 12);
  const children = [];
  for (const k of kids) {
    const c = beaconSkeleton(k, d + 1);
    if (c) children.push(c);
  }
  if (children.length) node.children = children;
  return node;
}
globalThis.__beaconSkeleton = beaconSkeleton;
globalThis.__beaconTextShape = beaconTextShape;

/**
 * 上报「这个字段采不到」。**静默失败**：这是旁路，自学习自己出问题不能连累正在跑的采集。
 * 同一页面同一字段一次会话只报一次——重复上报只会把同一件事刷成几百条。
 */
const beaconReported = new Set();
async function beaconReportParseMiss(platform, scope, field, rootSelector) {
  try {
    const key = platform + ':' + scope + ':' + field;
    if (beaconReported.has(key)) return;
    beaconReported.add(key);
    const root = rootSelector ? document.querySelector(rootSelector) : document.body;
    const skeleton = beaconSkeleton(root);
    if (!skeleton) return;
    chrome.runtime.sendMessage({ type: 'parser:miss', platform, scope, field, skeleton }, () => {
      // 回调里读 lastError 是为了不让「后台没响应」变成一条 unchecked runtime.lastError 警告
      void chrome.runtime.lastError;
    });
  } catch {
    /* 旁路，出错就算了 */
  }
}
globalThis.__beaconReportParseMiss = beaconReportParseMiss;

/** 当前页面大致属于哪个平台（只给上报用；真正的平台判定仍在各站点解析器里）。 */
function beaconPlatformOf() {
  const h = location.hostname;
  if (h.includes('douyin')) return 'douyin';
  if (h.includes('xiaohongshu')) return 'xiaohongshu';
  if (h.includes('bilibili')) return 'bilibili';
  if (h.includes('youtube')) return 'youtube';
  if (h.includes('tiktok')) return 'tiktok';
  if (h.includes('x.com') || h.includes('twitter')) return 'x';
  if (h.includes('weixin')) return 'wechat';
  return 'unknown';
}
globalThis.__beaconPlatformOf = beaconPlatformOf;

/**
 * 服务端下发的解析规则（平台改版后的兜底锚点）。
 * 主解析器先跑；主解析器没读到时才用这里的候选选择器试一遍——
 * **顺序不能反**：下发规则是应急补丁，不该盖过已经在真机上校准过的主解析器。
 */
async function beaconRuleSelectors(platform, field) {
  try {
    const { parserRules } = await chrome.storage.local.get('parserRules');
    const pack = parserRules && parserRules.rules;
    if (!Array.isArray(pack)) return [];
    const hit = pack.find((r) => r.platform === platform && r.field === field);
    return hit ? (hit.selectors || []) : [];
  } catch {
    return [];
  }
}
globalThis.__beaconRuleSelectors = beaconRuleSelectors;
