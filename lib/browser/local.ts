// 驱动本机浏览器抓取（2026-08-29）。
//
// 用户的要求：「驱动电脑里的浏览器去抓取，不单单依靠插件」。
//
// ── 为什么是 connectOverCDP，而不是自己起一个浏览器 ──
// playwright 自带的浏览器要下载几百 MB，而且那是个**全新的、没登录过任何网站**的浏览器，
// 抓不到只有登录后才看得见的内容——那正是插件方案存在的理由。
// connectOverCDP 连的是**用户自己已经开着的那个 Chrome**：不下载、有他的登录态。
//
// ── 这条路比插件危险得多，所以边界要更硬 ──
// 插件受 Chrome 扩展模型约束（逐站点授权、只跑注入的脚本）；CDP 不受任何约束——
// 连上去就能读所有标签页、能点能填能提交。所以这里定死五条：
//   ① **SaaS 恒关**（能力矩阵）。服务端在机房，够不到用户浏览器。
//   ② **默认关**：没配 CDP 端点就是关闭，不另设开关（少一个会和实际状态对不上的字段）。
//   ③ **端点必须是本机回环地址**。填一个远程地址，等于把「驱动浏览器」变成
//      「连到别人机器上的浏览器」——那是完全不同的一件事，不该被一个配置项悄悄打开。
//   ④ **只读**：navigate + 读 DOM。不点击、不输入、不提交表单。与插件同一条红线。
//   ⑤ **绝不碰已有标签页**：每次新开一个 page，用完就关。用户开着的网银、邮箱、后台，
//      我们连列都不列——CDP 能列出它们，正因为能，才必须明写不做。
import { complianceCheck, robotsAllows, SITE_STOPPED_REASON } from '../scrape/recipe';
import { isSiteRemovalRequested } from '../legal/removal';
import { sanitizeSkeleton, serializeSkeleton, MAX_SKELETON_CHARS } from '../ingest/parser-learn';
import { extractArticle } from '../clip/extract';
import {
  flattenJson, mergeCaptures, lookupJsonPath, lookupJsonColumn, jsonSkeleton,
  MAX_JSON_RESPONSES, MAX_JSON_BODY_CHARS,
} from '../scrape/json-capture';

/** 等就绪选择器的上限。等不到就往下走——可能是站点改版了，那该由取值与重学去判，不是在这儿卡死。 */
const READY_TIMEOUT_MS = 8_000;
/** 最多往下滚几屏。**不是性能考虑**——是别把用户的浏览器占太久。 */
export const MAX_SCROLL_SCREENS = 15;
/** 每滚一屏之间留多久。滚太快等于没滚：内容还没来得及加载。 */
const SCROLL_GAP_MS = 900;
/** 由 JSON 列拼出来的行数上限。与 DOM 那条路的 50 同一个数。 */
const MAX_JSON_ROWS = 50;

/**
 * 回给模型的正文上限。
 *
 * 【为什么必须有】既有教训：没有上限的读会烧光上下文，而那表现为「它突然忘了前面在干什么」，
 * 排查时毫无线索（read_file 的 128KB 上限就是为这个立的）。正文比文件更该压——
 * 一次采集常常要连开好几个页面。
 */
export const MAX_PAGE_TEXT_CHARS = 8_000;

/**
 * 交给正文提取器的 HTML 上限。提取器是纯正则实现，喂一份几十 MB 的 DOM 会把这次调用拖死。
 * 超出部分截断而不是拒绝——正文几乎总在前半段（截断不打回，同项目既有原则）。
 */
const MAX_HTML_CHARS = 2_000_000;

export type LocalPageResult =
  | {
      ok: true;
      title: string;
      skeleton: string;
      values?: Record<string, string>;
      /** 列表行（给了 rowSelector、或 JSON 里有数组时才有）。每行一份 key→值 */
      rows?: Record<string, string>[];
      /**
       * 被动捕获到的 JSON 响应摘要：**只有路径名和值的形状**，没有真实内容。
       * 学习时和页面骨架一起交给模型，让它能提出 jsonPaths 规则。
       */
      jsonHints?: string;
      /** 页面上的外链（只在 options.collectLinks 打开时才有）。 */
      links?: { href: string; text: string }[];
      /**
       * 页面正文（已去掉导航/侧栏/页脚/推荐位）。**只回给模型，不落库**——
       * 这与剪藏是同一条既有通道，但剪藏是用户显式指定要存的；这里是顺手读一眼。
       */
      text?: string;
      /** 正文提取器认出的作者/站点/发布时间，取不到就是空串 */
      meta?: { author: string; siteName: string; publishedAt: string };
    }
  | {
      ok: false;
      error: string;
      needsLogin?: boolean;
      /**
       * 撞上验证码 / 风控页。**与 needsLogin 同一类处置**（跳过、不计失败、只通知一次），
       * 但必须分得开：登录墙要用户去登录，风控要用户**等一会儿**，
       * 给错建议会让他反复去做一件没用的事。
       */
      rateLimited?: boolean;
      connectFailed?: boolean;
    };

export type BrowseRule = {
  key: string;
  selectors: string[];
  anchors: string[];
  /**
   * 从被捕获的 JSON 响应里取值的路径（如 `data.items.*.title`）。
   * 只在 CDP 这条路有效——插件那端拿不到响应体（那要另申请 webRequest 权限），
   * 它会自然退回选择器与锚点。**同一条配方在两条路上因此可能少几个字段，
   * 但绝不会给出不同的值**，这是刻意的取舍。
   */
  jsonPaths?: string[];
};

/** 配方的页面级选项。存在 ScrapeRecipe.options（JSON）里。 */
export type BrowseOptions = {
  /**
   * 等到这个选择器出现才算页面就绪。
   * 【为什么需要】原来是 domcontentloaded + 固定 1500ms —— 前端框架渲染慢一点就抓到骨架屏，
   * 而骨架屏上什么都没有，于是被当成「站点改版了」拿去重学，学出一堆空规则。
   */
  readySelector?: string;
  /**
   * 往下滚几屏（0 = 不滚）。列表页首屏之外的内容只能靠它。
   * 【为什么滚动不算越界】滚动不点击、不填写、不提交任何东西——它是人读页面的方式。
   * 而且插件那条路的翻页采集**早就在滚**，隐私政策已经披露过；
   * CDP 这边不滚只是能力落后于已披露的行为，不是边界更严。
   */
  scrollScreens?: number;
  /**
   * 列表的行容器选择器。给了它就按行取值，产出 rows。
   * ⚠️ 行边界判错 = 跨条目串数（这个事故在后台采集那条路上真发生过），
   * 所以行容器必须是**用户/模型明确指定的**，绝不由代码去猜。
   */
  rowSelector?: string;
  /**
   * 顺带把页面上的**外链**取回来（默认关）。
   *
   * 【为什么要单开一个开关，而不是一直取】脱敏骨架**刻意不含链接**——
   * 那是它的隐私设计：学取数规则不需要知道链接指向谁。
   * 但「AI 引用了谁」这件事，要的**恰恰就是链接本身**。
   * 两个用途，两条产出，各自只拿自己需要的东西；默认关，谁要谁显式打开。
   *
   * ⚠️ 取回的链接**只用于当场比对**，不进骨架、不进学习、不落进配方规则。
   */
  collectLinks?: boolean;
};

/** 端点必须是本机回环。见文件头闸③。 */
export function vetCdpUrl(raw: string | null | undefined): { ok: boolean; url?: string; error?: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: '没配浏览器调试端点' };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: '端点地址格式不对' }; }
  if (u.protocol !== 'http:') return { ok: false, error: '调试端点只能是 http://' };
  const h = u.hostname;
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') {
    return { ok: false, error: '调试端点只能指向本机（127.0.0.1 / localhost）' };
  }
  return { ok: true, url: u.origin };
}

/**
 * 在页面里取值的那段脚本。**与插件执行器同一套口径**——两处口径不一致，
 * 同一个配方在两条路上会给出不同的数，而那种不一致极难排查。
 */
const PICK_FN = `(args) => {
  const rules = args.rules || [];
  const rowSelector = args.rowSelector || '';

  // 一条规则在某个根节点下取值。**根节点是行边界**：给了 rowSelector 时，
  // 每一行只在自己那棵子树里找——不这样的话，第二行取不到就会退到全局，
  // 把第一行的值当成自己的（跨条目串数，这个事故真发生过）。
  const pick = (rule, root) => {
    for (const sel of rule.selectors || []) {
      try { const el = root.querySelector(sel); const v = el && el.textContent && el.textContent.trim(); if (v) return v.slice(0, 200); } catch {}
    }
    for (const anchor of rule.anchors || []) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (!n.textContent || !n.textContent.includes(anchor)) continue;
        const host = n.parentElement; if (!host) continue;
        const near = [host.nextElementSibling, host.previousElementSibling, host.parentElement]
          .filter(Boolean).map((e) => (e.textContent || '').replace(anchor, '').trim())
          .find((t) => t && t.length < 60);
        if (near) return near.slice(0, 200);
      }
    }
    return null;
  };

  const out = { values: {}, rows: [] };
  for (const r of rules) { const v = pick(r, document.body); if (v) out.values[r.key] = v; }

  if (rowSelector) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(rowSelector)]; } catch { nodes = []; }
    // 上限 50：与既有翻页采集的服务端硬上限同一个数，也是「别把一页几千条全搬回来」的闸
    for (const node of nodes.slice(0, 50)) {
      const row = {};
      for (const r of rules) { const v = pick(r, node); if (v) row[r.key] = v; }
      // 【空行不收】一行一个字段都没取到，说明 rowSelector 指到了容器而不是行
      // ——收进来只会让「抓到 200 条」变成一个假象
      if (Object.keys(row).length > 0) out.rows.push(row);
    }
  }
  return out;
}`;

/**
 * 有界滚动。**只滚，不点**——「加载更多」按钮是点击，那是另一件事，明确不做。
 *
 * 三条边界，每条都对应一种「不给上限就会出事」：
 *   · 屏数上限：无上限会在无限流页面上一直滚下去，占着用户的浏览器不放；
 *   · 连续两轮高度不涨就停：不这样的话，一个不加载更多的页面会白滚满 N 轮；
 *   · 每轮之间留时间：滚太快等于没滚，内容还没来得及加载。
 */
/**
 * 取页面上的**外链**。
 *
 * 只取 http(s)、只取站外（同源的都是它自己的导航，不是引用）、去重、有上限。
 * 锚文本一起带回来：AI 的引用条目上通常写着来源标题，比链接本身好认。
 */
const LINKS_FN = `() => {
  const here = location.origin;
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (out.length >= 80) break;
    let u;
    try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    // 同源链接是这个站自己的导航，不是「它引用了谁」
    if (u.origin === here) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ href: u.toString().slice(0, 500), text: (a.textContent || '').trim().slice(0, 120) });
  }
  return out;
}`;

const SCROLL_STEP_FN = `() => {
  const before = document.body.scrollHeight;
  window.scrollBy(0, Math.round(window.innerHeight * 0.9));
  return before;
}`;
const SCROLL_HEIGHT_FN = `() => document.body.scrollHeight`;

/**
 * 认登录墙。三条独立信号，命中任一条就算——
 * 【为什么不只看有没有密码框】很多站点的登录墙是弹层或整页跳转，密码框在 iframe 里取不到；
 * 而只看 URL 又会漏掉「原地弹层」那种。三条一起看，宁可偶尔误判一次让用户重试，
 * 也不要把登录页当成内容页学进配方里。
 */
const LOGIN_WALL_FN = `() => {
  const url = location.href.toLowerCase();
  if (/\\/(login|signin|sign-in|auth|passport)(\\/|\\?|$)/.test(url)) return { walled: true, kind: 'login', why: '地址是登录页' };
  if (document.querySelector('input[type=password]')) return { walled: true, kind: 'login', why: '页面上有密码输入框' };
  const t = (document.body && document.body.innerText || '').slice(0, 2000);
  if (/(请先登录|登录后查看|需要登录|登录以继续|please log ?in|sign in to continue)/i.test(t)) {
    return { walled: true, kind: 'login', why: '页面提示需要登录' };
  }
  // 【第四条信号：验证码与风控页】
  // 【为什么必须和登录墙归成一类】它们是同一种事：**页面是好的、配方是好的，只是这一次没让我们看**。
  // 不认出来的话，这一页会被当成「一个字段都没取到 = 站点改版了」拿去重学——
  // 而学习器看到的是一张验证码页，于是学出一堆「请输入验证码」的规则存进配方，
  // 之后每次都稳定抓到那句话，且一切看起来正常（有规则、有值、不报错）。
  // 这个项目已经撞过一次真的：公众号对机房 IP 返验证码页。
  if (/\\/(captcha|verify|challenge|robot|seccode)(\\/|\\?|$)/.test(url)) {
    return { walled: true, kind: 'captcha', why: '地址是验证码/风控页' };
  }
  if (/(请完成安全验证|安全验证|滑动验证|拖动滑块|人机验证|请输入验证码|访问过于频繁|操作频繁|请稍后再试|unusual traffic|verify you are (a )?human|are you a robot|rate limit|too many requests)/i.test(t)) {
    return { walled: true, kind: 'captcha', why: '页面要求人机验证或提示访问过于频繁' };
  }
  return { walled: false, kind: '', why: '' };
}`;

/** 抽页面结构骨架的脚本。与插件 tools/recipe-run.js 同一口径：不含正文、昵称、链接、图片。 */
const SKELETON_FN = `() => {
  const shape = (s) => {
    const t = String(s || '').trim().slice(0, 40);
    if (!t) return '';
    if (/^[\\d.,%万千亿]+$/.test(t)) return 'NUM';
    if (/[\\u4e00-\\u9fa5]{4,}/.test(t)) return 'CJK';
    return t;
  };
  const budget = { n: 0 };
  const walk = (el, d) => {
    if (!el || d > 12 || budget.n > 1500 || el.nodeType !== 1) return null;
    budget.n += 1;
    const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => shape(c.textContent)).filter(Boolean);
    const kids = [];
    for (const c of el.children) { const k = walk(c, d + 1); if (k) kids.push(k); if (budget.n > 1500) break; }
    // 【role 与 data-testid 的**值**要带上】类名被混淆成随机哈希时，
    // 它们是仅剩的稳定锚点——那正是各家前端改版后的常态。
    // 服务端 vetRole / vetTestId 会再卡一道（role 只认标准词表、testid 只认标识符形状）。
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test')
      || el.getAttribute('data-qa') || el.getAttribute('data-cy') || '';
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string') ? el.className.split(/\\s+/).slice(0, 4) : [],
      attrs: [...el.attributes].map((a) => a.name).filter((n) => n !== 'style').slice(0, 8),
      role: el.getAttribute('role') || '',
      tid: tid,
      // 【字段名必须是 shape，且必须是字符串】服务端 sanitizeSkeleton 的类型是
      // { shape?: string }。这里原来产出的是 \`text: [...]\`（数组），两个判据都不匹配，
      // **整层文本被静默丢掉**——模型于是看不到任何文字，永远提不出文本锚点，
      // 学出来的规则只剩最脆的类名。服务端现在也兼容旧数组形状（为了还没更新的插件），
      // 但新代码一律产出 shape，别再依赖那条兼容路。
      shape: own.slice(0, 3).join(' '),
      children: kids,
    };
  };
  return walk(document.body, 0);
}`;

// ── 同一时刻只让一个动作驱动浏览器 ──────────────────────────────────────
//
// 【为什么需要】定时扫描一轮要开二十来个标签、约十分钟；这期间用户手动点「跑一次」、
// 或 AI 调 browse_local，就会同时往他的 Chrome 里塞标签。功能上不会算错（Chrome 撑得住），
// 但用户看到的是标签一下子弹出好几个——而这个功能本来就已经「藏不住」了，不该更吵。
//
// 【为什么是进程内标志而不是数据库锁】整机版就一个进程（见 lib/jobs/local-scheduler.ts
// 那段「不另起 worker」的说明）。上数据库锁是把一个单进程问题做成分布式问题。
//
// 【交互优先】用户当场点的动作**不等待也不让位**——他在跟前，让他等十分钟是荒谬的。
// 让位的是定时扫描：它看到有人在用就整轮跳过，反正 6 小时后还有一轮。
let browserBusy = false;

/** 现在有没有动作正在驱动浏览器。定时扫描据此让位。 */
export function isBrowserBusy(): boolean {
  return browserBusy;
}

/**
 * 打开一个页面，取骨架（以及可选地按规则取值）。
 * 每次新开 page、用完关掉——绝不去动用户已经开着的标签。
 */
export async function browseLocal(
  cdpUrl: string,
  url: string,
  rules?: readonly BrowseRule[],
  /**
   * 撞上登录墙时，把页面**推到前台**并等用户登录多少秒。0=不等。
   *
   * 【为什么必须有上限】等待期间这次工具调用是卡住的，整个 AI 执行也停在那儿。
   * 无上限地等，会把一次「顺手抓一下」变成挂死——而用户可能根本不在电脑前。
   * 90 秒是「人在键盘前，扫码/输密码够用」与「不在的话尽快让出去」之间的折中。
   */
  waitForLoginSec = 0,
  options: BrowseOptions = {},
): Promise<LocalPageResult> {
  const vet = vetCdpUrl(cdpUrl);
  if (!vet.ok) return { ok: false, error: vet.error! };

  // 导航前过合规闸——和插件那条路同一套判据，不因为换了通道就放松
  let origin = ''; let path = '/';
  try { const u = new URL(url); origin = u.origin; path = u.pathname || '/'; }
  catch { return { ok: false, error: '网址格式不对' }; }
  const c = complianceCheck(origin);
  if (!c.ok) return { ok: false, error: c.reason! };
  // 【站点停采闸也要在这里判，不能只在建配方时判】配方是一次性建的，停采申请是后来提的——
  // 只在建的时候判，等于「申请提交之后，已经建好的配方照抓不误」，那道闸形同虚设。
  if (await isSiteRemovalRequested(origin)) return { ok: false, error: SITE_STOPPED_REASON };
  const r = await robotsAllows(origin, path);
  if (!r.ok) return { ok: false, error: r.reason! };

  // 只在真要用的时候才加载 playwright：SaaS 上这条路走不到，不该为它多驮一个模块
  const { chromium } = await import('playwright-core');
  browserBusy = true;
  let browser;
  try {
    browser = await chromium.connectOverCDP(vet.url!, { timeout: 8000 });
  } catch (e) {
    browserBusy = false; // 连不上也要复位，否则一次连接失败会把定时扫描永久挡在门外
    // 【必须与「页面抓不到」区分开】连不上 = 浏览器没开着，跟配方好不好毫无关系。
    // 不标出来的话，定时扫描会给每个配方各记一次失败，约 18 小时后全部变成「抓不到了」——
    // 而它们一个都没坏。用户看到一屏红色，会去查站点改版，方向完全错。
    return {
      ok: false,
      connectFailed: true,
      error: `连不上本机浏览器（${vet.url}）：请先用调试端口启动 Chrome（客户端托盘里有「启动采集浏览器」）。${e instanceof Error ? e.message : ''}`,
    };
  }

  try {
    // 【用他自己的上下文，但只新开一个 page】
    // contexts()[0] 是这个 Chrome 的默认上下文——**用户的 cookie 和登录态都在里面**，
    // 所以需要登录才看得见的内容也读得到（这正是连真实浏览器而不是自带浏览器的理由；
    // newContext() 是一个干净的、没登录过任何网站的环境，抓不到那些内容）。
    // 但**只往里新开一个 page**：绝不遍历、绝不读用户已经开着的那些标签
    // （他的网银、邮箱、后台都在里面，CDP 能列出来，正因为能才必须明写不做）。
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();

    // ── 被动捕获页面自己发出的 JSON 响应 ──
    //
    // 【「被动」是这条路的全部边界】我们只读浏览器**本来就已经发出**的响应，
    // 绝不自己发请求。这个区别不是措辞：被动观察拿到的是和 DOM 一模一样的数据，
    // 只是在渲染之前——不产生额外请求、不给站点增加负载、不重放任何凭据。
    // 主动调接口是另一件事（公众号后台那条通道，既有分级里评为最高危，且逐平台预审过），
    // 任意站点不能走那条。本文件里没有任何发起请求的调用，守卫逐个断言。
    //
    // 【为什么只收同源】第三方的广告、埋点、统计响应既不是用户要的数据，
    // 又最可能带着跨站标识。只收同源，噪音和风险一起少掉。
    const jsonCaptures: Record<string, string>[] = [];
    const capturing: Promise<void>[] = [];
    page.on('response', (res) => {
      if (jsonCaptures.length + capturing.length >= MAX_JSON_RESPONSES) return;
      const ct = String(res.headers()['content-type'] ?? '').toLowerCase();
      if (!ct.includes('json')) return;
      let same = false;
      try { same = new URL(res.url()).origin === origin; } catch { same = false; }
      if (!same) return;
      capturing.push((async () => {
        try {
          const body = await res.text();
          if (body.length > MAX_JSON_BODY_CHARS) return; // 几 MB 的响应读它既慢又没必要
          jsonCaptures.push(flattenJson(JSON.parse(body)));
        } catch { /* 读不到 / 不是合法 JSON：跳过，绝不让它影响正常抓取 */ }
      })());
    });
    // 撞上登录墙时把这一页留给用户登录，不在 finally 里关掉
    let leaveOpen = false;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      // ── 页面就绪的判据 ──
      // 【为什么不用 networkidle】很多站点长连接不断（推送、埋点心跳），networkidle 永远等不到，
      // 一路等到超时。这不是猜的，是这条路一开始就写在注释里的取舍。
      // 【为什么固定 1500ms 不够】前端框架渲染慢一点就抓到骨架屏，而骨架屏上什么都没有——
      // 于是被当成「站点改版了」拿去重学，学出一堆空规则，而且一切看起来正常。
      // 所以：配方声明了就绪选择器就等它出现（有上限），没声明才退回固定等待。
      const ready = String(options.readySelector ?? '').trim();
      if (ready) {
        await page.waitForSelector(ready, { timeout: READY_TIMEOUT_MS, state: 'attached' })
          .catch(() => { /* 等不到不算失败：可能是站点改版了，交给下面的取值与重学去判 */ });
      }
      await page.waitForTimeout(ready ? 300 : 1500);
      const title = (await page.title()).slice(0, 200);

      // 【登录墙必须当场认出来】不判的话，学习器会**照着登录页学出一堆规则存进去**，
      // 之后每次都稳定地抓到「请登录」——而且一切看起来都正常：有规则、有值、不报错。
      // 这是这条路上最容易发生、也最难排查的一种错。
      let wall = await page.evaluate(LOGIN_WALL_FN) as { walled: boolean; kind: string; why: string };
      // 【验证码不等人】登录墙推到前台等他登是有意义的（他登完就能继续）；
      // 验证码推到前台只是把一个我们解决不了的东西塞给他看——而且我们**明确不做**
      // 替用户过验证码这件事（那是规避技术措施，与替他输密码同一条红线）。
      if (wall.walled && wall.kind === 'login' && waitForLoginSec > 0) {
        // 【把页面推到前台】用户要「直接驱动本地浏览器去获取」——那就别让他自己再去找网址。
        // 页面已经开在他的 Chrome 里，推到前台，他登完就走。
        // 我们只做「把他带到登录页」这一半；**另一半（输入凭据）永远由他自己完成**。
        await page.bringToFront().catch(() => { /* 推不到前台不影响后面的等待 */ });
        const deadline = Date.now() + Math.min(waitForLoginSec, 300) * 1000;
        while (Date.now() < deadline) {
          await page.waitForTimeout(3000);
          // 登完通常会跳走或原地刷新，两种情况这个判据都认得出
          wall = await page.evaluate(LOGIN_WALL_FN) as { walled: boolean; kind: string; why: string };
          // 【登录途中变成验证码页也要停下等】那是站点在盘问他，不是我们该继续轮询的时候；
          // 而且此时 kind 已经变了，下面的分支会给出「等一会儿」而不是「去登录」
          if (!wall.walled || wall.kind !== 'login') break;
        }
      }
      // 【验证码 / 风控要单独回答】它和登录墙是同一种事（页面好的、配方好的，只是这次没让我们看），
      // 处置也一样（跳过、不计失败、只通知一次）——但**给用户的下一步完全不同**：
      // 登录墙要他去登录，风控要他等一会儿或把频率调低。合成一句就必然给错建议，
      // 而给错建议会让他反复去做一件没用的事。
      if (wall.walled && wall.kind === 'captcha') {
        // 【这一页不留着】登录页留着是有用的（他登完，登录态就留在浏览器里了）；
        // 验证码页留在那儿对他没有任何用处——他也过不了「我们的」那一关。
        return {
          ok: false,
          rateLimited: true,
          error: `这个站点这次要求人机验证或提示访问过于频繁（${wall.why}）。`
            + '已经跳过这一次，不算配方坏了。过一阵子会自动再试；'
            + '如果一直这样，把这个配方的采集频率调低一些。'
            + '（我们不会替你过验证码——那是规避站点的技术措施，和替你输密码是同一条红线。）',
        };
      }
      if (wall.walled) {
        leaveOpen = true; // 【不关这一页】关掉的话用户回来时又得自己找一遍网址
        return {
          ok: false,
          needsLogin: true,
          error: `这个页面要求登录（${wall.why}）。已经在你的 Chrome 里打开并推到前台了，`
            + '登录一次就好——登录态留在你浏览器里，之后我直接就能读到。'
            + '（我不会替你输入账号密码。）',
        };
      }

      // ── 有界滚动 ──
      // 列表页首屏之外的内容只能靠它。**只滚，不点**：「加载更多」按钮是点击，明确不做。
      const screens = Math.min(Math.max(Number(options.scrollScreens ?? 0) || 0, 0), MAX_SCROLL_SCREENS);
      if (screens > 0) {
        let flat = 0;
        for (let i = 0; i < screens; i += 1) {
          const before = await page.evaluate(SCROLL_STEP_FN) as number;
          await page.waitForTimeout(SCROLL_GAP_MS);
          const after = await page.evaluate(SCROLL_HEIGHT_FN) as number;
          // 【连续两轮不涨就停】一个根本不加载更多的页面，不这样判会白滚满 N 轮，
          // 而每一轮都占着用户的浏览器。给两轮而不是一轮：内容偶尔会晚一拍才到。
          if (after <= before) { flat += 1; if (flat >= 2) break; } else flat = 0;
        }
      }

      // 【收口捕获必须在滚动之后】滚动会触发新的 XHR——那正是「加载更多」的数据来源。
      // 放在滚动之前收口，等于只拿到首屏那几条，而列表页真正值钱的恰恰是后面那些。
      // （这条是写完自查时发现的：先写的版本把收口放在滚动前，TypeScript 一声不吭。）
      await Promise.race([
        Promise.allSettled(capturing),
        new Promise((r) => { setTimeout(r, 2_000); }),
      ]);
      const jsonHints = jsonCaptures.length ? jsonSkeleton(mergeCaptures(jsonCaptures)) : undefined;

      // 【骨架在滚动之后取】滚动会带进新内容——先取骨架等于只让模型看见首屏，
      // 而列表页要学的行结构往往在第二屏才出现。
      const rawSkeleton = await page.evaluate(SKELETON_FN);
      const skeleton = serializeSkeleton(sanitizeSkeleton(rawSkeleton)).slice(0, MAX_SKELETON_CHARS);
      let values: Record<string, string> | undefined;
      let rows: Record<string, string>[] | undefined;
      if (rules && rules.length) {
        const picked = await page.evaluate(PICK_FN, {
          rules: rules as unknown as BrowseRule[],
          rowSelector: String(options.rowSelector ?? ''),
        }) as { values: Record<string, string>; rows: Record<string, string>[] };
        values = picked.values;
        rows = picked.rows.length ? picked.rows : undefined;

        // ── DOM 取不到的字段，回落到被捕获的 JSON ──
        // 【为什么是回落而不是优先】DOM 是所见即所得，出了问题肉眼能核对；
        // JSON 路径对不上时没人看得出来。先信眼睛看得见的那份。
        const flat = mergeCaptures(jsonCaptures);
        if (Object.keys(flat).length > 0) {
          for (const r of rules) {
            if (values[r.key] || !r.jsonPaths?.length) continue;
            for (const path of r.jsonPaths) {
              const v = lookupJsonPath(flat, path);
              if (v) { values[r.key] = v.slice(0, 200); break; }
            }
          }
          // 列表：DOM 没抓到行时，用 JSON 的列拼行（这才是 JSON 真正值钱的地方——
          // 列表在响应里天然就是数组，不受任何改版影响）
          if (!rows) {
            const cols = new Map<string, string[]>();
            for (const r of rules) {
              for (const path of r.jsonPaths ?? []) {
                const col = lookupJsonColumn(flat, path);
                if (col.length > 1) { cols.set(r.key, col); break; }
              }
            }
            if (cols.size > 0) {
              const n = Math.min(MAX_JSON_ROWS, ...[...cols.values()].map((c) => c.length));
              const built: Record<string, string>[] = [];
              for (let i = 0; i < n; i += 1) {
                const row: Record<string, string> = {};
                for (const [k, col] of cols) if (col[i]) row[k] = col[i].slice(0, 200);
                if (Object.keys(row).length > 0) built.push(row);
              }
              if (built.length > 0) rows = built;
            }
          }
        }
      }

      // 【骨架不是内容】骨架是**脱敏过的结构**（数字→NUM、长中文→CJK），它只够用来学取数规则，
      // 拿它当页面内容读是读不懂的。而这个工具对模型自称「打开一个网址并读取内容」——
      // 在补上这一段之前，没给配方时它只回一个标题，说的和做的对不上
      //（本项目为这类「文案与实际行为相反」专门做过一轮审计）。
      //
      // 【为什么用 lib/clip/extract.ts 而不是 innerText】那个提取器已经把导航、侧栏、页脚、
      // 推荐位剔掉了，且是零依赖纯函数。直接 innerText 会把「关注我们／相关阅读／版权声明」
      // 一起交给模型去总结。不要另建一套。
      // 【外链：只在显式打开时取】默认不取——骨架刻意不含链接是它的隐私设计，
      // 这里是另一个用途（比对 AI 引用了谁），所以另开一条产出，而不是把链接塞进骨架
      let links: { href: string; text: string }[] | undefined;
      if (options.collectLinks) {
        links = await page.evaluate(LINKS_FN) as { href: string; text: string }[];
      }

      let text: string | undefined;
      let meta: { author: string; siteName: string; publishedAt: string } | undefined;
      try {
        const html = (await page.content()).slice(0, MAX_HTML_CHARS);
        const art = extractArticle(html, { maxChars: MAX_PAGE_TEXT_CHARS });
        if (art.text) {
          text = art.text;
          meta = { author: art.author, siteName: art.siteName, publishedAt: art.publishedAt };
        }
      } catch { /* 取不到正文不影响骨架与取值这两件正事 */ }

      return { ok: true, title, skeleton, jsonHints, values, rows, links, text, meta };
    } finally {
      if (!leaveOpen) await page.close().catch(() => { /* 关不掉不影响结论 */ });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '打开页面失败' };
  } finally {
    browserBusy = false;
    // 只断开连接，**不关用户的浏览器**。
    // 【这条是实测过的，不是照文档推的】2026-08-29 用临时 profile 起了一个 Chrome、
    // connectOverCDP 之后调 close()，进程仍然活着。对 connectOverCDP 拿到的 browser，
    // close() 的语义是断开连接；若它真会关掉浏览器，用户几十个标签会被我们一次带走。
    await browser.close().catch(() => { /* 同上 */ });
  }
}

/**
 * 把学到的配方生成一份**能独立跑**的脚本。
 *
 * 【为什么要产出脚本而不是只存规则】用户原话「抓取后形成一个抓取的脚本信息」。
 * 存在库里的规则只有烽火台自己能用；一份脚本是他能读、能改、能拿走、能放进自己
 * 定时任务里的东西。这是「工具」和「黑盒」的区别。
 */
export function buildScrapeScript(input: {
  name: string; url: string; rules: readonly BrowseRule[]; cdpUrl: string; options?: BrowseOptions;
}): string {
  return `#!/usr/bin/env node
// 「${input.name}」采集脚本 —— 由烽火台从一次真实抓取中学出来的。
//
// 用法：
//   1) 先用调试端口启动 Chrome（已经开着的话要先完全退出）：
//      macOS:   open -a "Google Chrome" --args --remote-debugging-port=9222
//      Windows: chrome.exe --remote-debugging-port=9222
//   2) node ${input.name.replace(/[^\\w-]/g, '_')}.js
//
// 它连的是**你自己那个 Chrome**，所以需要登录才看得见的内容它也能抓到。
// 只读：打开页面、取值、关掉。不点击、不输入、不提交任何表单。
const { chromium } = require('playwright-core');

const URL_TO_SCRAPE = ${JSON.stringify(input.url)};
const CDP = ${JSON.stringify(input.cdpUrl)};
const RULES = ${JSON.stringify(input.rules, null, 2)};
const OPTIONS = ${JSON.stringify(input.options ?? {}, null, 2)};

const PICK = ${PICK_FN};

(async () => {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 });
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(URL_TO_SCRAPE, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (OPTIONS.readySelector) {
        await page.waitForSelector(OPTIONS.readySelector, { timeout: 8000, state: 'attached' }).catch(() => {});
      }
      await page.waitForTimeout(OPTIONS.readySelector ? 300 : 1500);
      // 只滚，不点。连续两轮高度不涨就停，别在不加载更多的页面上白滚
      let flat = 0;
      for (let i = 0; i < (OPTIONS.scrollScreens || 0); i++) {
        const before = await page.evaluate(() => {
          const h = document.body.scrollHeight;
          window.scrollBy(0, Math.round(window.innerHeight * 0.9));
          return h;
        });
        await page.waitForTimeout(900);
        const after = await page.evaluate(() => document.body.scrollHeight);
        if (after <= before) { if (++flat >= 2) break; } else flat = 0;
      }
      const out = await page.evaluate(PICK, { rules: RULES, rowSelector: OPTIONS.rowSelector || '' });
      const values = out.values;
      const rows = out.rows;
      const missing = RULES.filter((r) => !values[r.key]).map((r) => r.key);
      console.log(JSON.stringify({ url: URL_TO_SCRAPE, values, rows, missing }, null, 2));
      // 取不到就以非零退出：挂在定时任务里时，这一位才是「站点改版了」的信号。
      // 有行就不算取不到——纯列表页往往没有任何页面级标量
      if (missing.length === RULES.length && rows.length === 0) process.exit(2);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    // 只断开，不关用户的浏览器
    await browser.close().catch(() => {});
  }
})();
`;
}
