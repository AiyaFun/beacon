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
import { complianceCheck, robotsAllows } from '../scrape/recipe';
import { sanitizeSkeleton, serializeSkeleton, MAX_SKELETON_CHARS } from '../ingest/parser-learn';

export type LocalPageResult =
  | { ok: true; title: string; skeleton: string; values?: Record<string, string> }
  | { ok: false; error: string; needsLogin?: boolean; connectFailed?: boolean };

export type BrowseRule = { key: string; selectors: string[]; anchors: string[] };

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
const PICK_FN = `(rules) => {
  const out = {};
  const pick = (rule) => {
    for (const sel of rule.selectors || []) {
      try { const el = document.querySelector(sel); const v = el && el.textContent && el.textContent.trim(); if (v) return v.slice(0, 200); } catch {}
    }
    for (const anchor of rule.anchors || []) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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
  for (const r of rules || []) { const v = pick(r); if (v) out[r.key] = v; }
  return out;
}`;

/**
 * 认登录墙。三条独立信号，命中任一条就算——
 * 【为什么不只看有没有密码框】很多站点的登录墙是弹层或整页跳转，密码框在 iframe 里取不到；
 * 而只看 URL 又会漏掉「原地弹层」那种。三条一起看，宁可偶尔误判一次让用户重试，
 * 也不要把登录页当成内容页学进配方里。
 */
const LOGIN_WALL_FN = `() => {
  const url = location.href.toLowerCase();
  if (/\\/(login|signin|sign-in|auth|passport)(\\/|\\?|$)/.test(url)) return { walled: true, why: '地址是登录页' };
  if (document.querySelector('input[type=password]')) return { walled: true, why: '页面上有密码输入框' };
  const t = (document.body && document.body.innerText || '').slice(0, 2000);
  if (/(请先登录|登录后查看|需要登录|登录以继续|please log ?in|sign in to continue)/i.test(t)) {
    return { walled: true, why: '页面提示需要登录' };
  }
  return { walled: false, why: '' };
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
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string') ? el.className.split(/\\s+/).slice(0, 4) : [],
      attrs: [...el.attributes].map((a) => a.name).filter((n) => n !== 'style').slice(0, 8),
      text: own.slice(0, 3),
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
): Promise<LocalPageResult> {
  const vet = vetCdpUrl(cdpUrl);
  if (!vet.ok) return { ok: false, error: vet.error! };

  // 导航前过合规闸——和插件那条路同一套判据，不因为换了通道就放松
  let origin = ''; let path = '/';
  try { const u = new URL(url); origin = u.origin; path = u.pathname || '/'; }
  catch { return { ok: false, error: '网址格式不对' }; }
  const c = complianceCheck(origin);
  if (!c.ok) return { ok: false, error: c.reason! };
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
    // 撞上登录墙时把这一页留给用户登录，不在 finally 里关掉
    let leaveOpen = false;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      // 给前端框架一点渲染时间。不用 networkidle：很多站点长连接不断，会一直等到超时
      await page.waitForTimeout(1500);
      const title = (await page.title()).slice(0, 200);

      // 【登录墙必须当场认出来】不判的话，学习器会**照着登录页学出一堆规则存进去**，
      // 之后每次都稳定地抓到「请登录」——而且一切看起来都正常：有规则、有值、不报错。
      // 这是这条路上最容易发生、也最难排查的一种错。
      let wall = await page.evaluate(LOGIN_WALL_FN) as { walled: boolean; why: string };
      if (wall.walled && waitForLoginSec > 0) {
        // 【把页面推到前台】用户要「直接驱动本地浏览器去获取」——那就别让他自己再去找网址。
        // 页面已经开在他的 Chrome 里，推到前台，他登完就走。
        // 我们只做「把他带到登录页」这一半；**另一半（输入凭据）永远由他自己完成**。
        await page.bringToFront().catch(() => { /* 推不到前台不影响后面的等待 */ });
        const deadline = Date.now() + Math.min(waitForLoginSec, 300) * 1000;
        while (Date.now() < deadline) {
          await page.waitForTimeout(3000);
          // 登完通常会跳走或原地刷新，两种情况这个判据都认得出
          wall = await page.evaluate(LOGIN_WALL_FN) as { walled: boolean; why: string };
          if (!wall.walled) break;
        }
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

      const rawSkeleton = await page.evaluate(SKELETON_FN);
      const skeleton = serializeSkeleton(sanitizeSkeleton(rawSkeleton)).slice(0, MAX_SKELETON_CHARS);
      const values = rules && rules.length
        ? (await page.evaluate(PICK_FN, rules as unknown as BrowseRule[])) as Record<string, string>
        : undefined;
      return { ok: true, title, skeleton, values };
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
  name: string; url: string; rules: readonly BrowseRule[]; cdpUrl: string;
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

const PICK = ${PICK_FN};

(async () => {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 });
  try {
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(URL_TO_SCRAPE, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      const values = await page.evaluate(PICK, RULES);
      const missing = RULES.filter((r) => !values[r.key]).map((r) => r.key);
      console.log(JSON.stringify({ url: URL_TO_SCRAPE, values, missing }, null, 2));
      // 取不到就以非零退出：挂在定时任务里时，这一位才是「站点改版了」的信号
      if (missing.length === RULES.length) process.exit(2);
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
