// 用本机 Chrome 采平台主页（2026-09-03）。
//
// 用户的要求：「如果没有安装插件，客户端应该自己操作电脑的浏览器，自行去采集」。
//
// ── 用插件的解析器，不另写一套 ──
// 抖音/小红书/B站/X/YouTube/TikTok 六个主页解析器都在 extension/content/ 里，每一个都真机
// 校准过好几轮（work.js 当年是「第三套解析器」，每轮校准都漏掉它——那课不能再上一遍）。
// 所以这条路不写第二份取数逻辑：把 common.js + 平台解析器**原样注入**到本机 Chrome 新开的
// 那一页里，调它的 __beaconParse()，产出与插件回传的 payload 一字不差，落库走同一个函数。
// 解析器一处修，两条路一起好。
//
// ── 与 lib/browser/local.ts 同一套硬边界（那五条这里逐条照抄）──
//   ① SaaS 恒关（调用方靠 editionCan('localBrowser') 判，SaaS 连 CDP 端点都存不进来）；
//   ② 默认关：没配 CDP 端点就是关；
//   ③ 端点只能是本机回环（vetCdpUrl）；
//   ④ 只读：navigate + 注入只读脚本 + 读 DOM。不点、不填、不提交，不替用户登录；
//   ⑤ 绝不碰已有标签页：只在默认上下文里新开一页，用完关掉。
//
// ── robots.txt 为什么**不**在这里判 ──
// local.ts（任意站点配方）在导航前读 robots，因为那条路抓的是任意站点。这里打开的只有
// 六个内容平台的**公开主页**，且是用户自己的账号或他已订阅的竞对——与插件「访问即采」
// 读的是同一批页面、同一个解析器、同一个登录态；插件那条路从来不读 robots（那是用户
// 自己在浏览）。两条路对同一批页面用两套判据，会出现「插件采得到、本机采不到」的
// 说不清的差别。合规闸（政务/教育/军事域、医疗金融票务）与站点停采申请照判不误。
import fs from 'node:fs';
import path from 'node:path';
import { complianceCheck, SITE_STOPPED_REASON } from '../scrape/recipe';
import { isSiteRemovalRequested } from '../legal/removal';
import { vetCdpUrl, LOGIN_WALL_FN } from './local';
import { SELF_BACKEND_PLATFORMS } from '../browser-task/kinds';
import { backendEntryFor } from '../browser-task/backend-entries';

/** 平台 → 主页解析器文件。**只列主页解析器**：作品页那份会覆盖 __beaconParse（内容脚本覆盖陷阱）。 */
export const PLATFORM_PARSER_FILE: Record<string, string> = {
  bilibili: 'bilibili.js',
  douyin: 'douyin.js',
  xiaohongshu: 'xhs.js',
  x: 'x.js',
  youtube: 'youtube.js',
  tiktok: 'tiktok.js',
};

/**
 * common.js 顶层会碰 chrome.runtime / chrome.storage（消息监听、读设置）。注入到普通页面里
 * 那些 API 不存在，脚本会在第一处就抛出来，后面的解析函数全没定义。
 * 这份垫片让它安静地跑完：设置读出来是空（访问即采于是不触发）、消息发出去没人收。
 * **只补缺的**：页面里若真有 chrome.runtime（externally_connectable 的站点），不覆盖它。
 */
export const CHROME_SHIM = `(() => {
  const g = globalThis;
  g.chrome = g.chrome || {};
  const c = g.chrome;
  c.runtime = c.runtime || {};
  c.runtime.onMessage = c.runtime.onMessage || { addListener() {} };
  c.runtime.sendMessage = c.runtime.sendMessage || (() => Promise.resolve(null));
  c.runtime.lastError = c.runtime.lastError || undefined;
  c.storage = c.storage || {};
  c.storage.sync = c.storage.sync || { get: () => Promise.resolve({}) };
  c.storage.local = c.storage.local || { get: () => Promise.resolve({}) };
  // common.js 顶层订阅规则包变更（__beaconRuleSelectorsSync 的缓存刷新），垫片得有这个监听口
  c.storage.onChanged = c.storage.onChanged || { addListener() {} };
})();`;

/** 页面里跑的采集主体：等解析器认出作品 → 有界翻页（common.js 自己那套） → 返回 payload。 */
export const COLLECT_FN = `async ({ deep }) => {
  const parse = globalThis.__beaconParse;
  if (typeof parse !== 'function') return { error: 'parser_missing' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let payload = null;
  for (let i = 0; i < 15; i += 1) {
    try { payload = parse(); } catch (e) { return { error: 'parse_threw: ' + (e && e.message) }; }
    if (payload && payload.handle && payload.posts && payload.posts.length > 0) break;
    await sleep(600);
  }
  // 解析器自己报的错（如 parser_stale：站点改版把锚点拆了）要原样透出，
  // 否则会被下面那句当成「没认出主页」，用户看到的原因与事实不符。
  if (payload && payload.error) return { error: payload.error };
  if (!payload || !payload.handle) return { error: 'no_handle' };
  if (deep && payload.posts && payload.posts.length > 0 && typeof globalThis.__beaconCollectDeep === 'function') {
    const deeper = await globalThis.__beaconCollectDeep(parse);
    if (deeper && deeper.posts && deeper.posts.length >= payload.posts.length) payload = deeper;
  }
  return { payload };
}`;

/**
 * 在页面里读正文：给 open_and_read 用（桌面执行器那条路）。与插件同一口径——
 * 只取已渲染的可见文字，不动页面。**不能住在 route.ts 里**：Next 的 route 文件只许导出
 * HTTP 方法与几个配置常量，多导出一个函数，`next build` 会报「does not match the required
 * types of a Next.js Route」——而 tsc 与单测都抓不到，只有构建那一刻才炸（2026-09-03 真踩，
 * 与 [[beacon-bot-group-chat]] 里 route.ts 那条同一课）。
 */
export const READ_TEXT_FN = `() => ({
  title: document.title,
  finalUrl: location.href,
  text: ((document.body && document.body.innerText) || '').slice(0, 60000),
})`;

/**
 * 页面直读（2026-09-16）：把这一页**可见的文字**与**页内链接**原样带回，给模型直接读。
 *
 * 【为什么要有】用户 2026-09-16 的原话：「直接在网页上读取对应的信息」——他指着 Gemini 的自动浏览：
 * 打开网页、读页面上的东西、总结出来，不靠平台接口。手写解析器与配方是结构化的路（准、稳、不烧模型额度），
 * 但它们认不出的页面（改版了、新平台、学习中的配方）不该就此停在「解析器没认出」——
 * 页面本身就在那儿，人能读、模型也能读。这个函数只负责把页面内容带回，读出什么由服务端
 * lib/browser/page-read-extract.ts 的模型抽取 + 机器闸（数字必须在页面文字里原样出现）决定。
 *
 * 【与 READ_TEXT_FN 的区别】那个只给正文（open_and_read 用）；这里多带链接——作品 ID 只能从链接里抠，
 * 没有链接就没法去重、没法与已登记的发布记录对齐。链接**只用于当场认 ID**，不进骨架、不进学习。
 * 上限：文字 6 万字符（与 MAX_READ_TEXT_CHARS 同一个数，WAF 请求体那道闸）、链接 400 条。
 */
export const PAGE_READ_FN = `() => {
  const seen = new Set();
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    let href = '';
    try { href = new URL(a.getAttribute('href'), location.href).href; } catch { continue; }
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = ((a.innerText || a.textContent || '')).replace(/\\s+/g, ' ').trim().slice(0, 120);
    links.push({ href: href.slice(0, 500), text });
    if (links.length >= 400) break;
  }
  return {
    title: document.title,
    finalUrl: location.href,
    text: ((document.body && document.body.innerText) || '').slice(0, 60000),
    links,
  };
}`;

/** 解析器产出的形状（与插件回传一致；服务端 zod 再验一遍，这里只做最小结构约束）。 */
export type ParsedPagePayload = {
  platform: string;
  handle: string;
  profile?: { name?: string; followers?: number; followersVia?: string; avatar?: string };
  posts: Array<Record<string, unknown>>;
  isSelf?: boolean;
};

export type LocalCollectResult =
  | { ok: true; title: string; payload: ParsedPagePayload }
  /**
   * read：解析器没认出/没读到时**页面上可见的文字与链接**（2026-09-16，页面直读）。
   * 有它调用方就能让模型直接从页面内容里读出作品与数字（lib/browser/page-read-extract.ts），
   * 而不是只回一句「解析器没认出」——用户的原话：「直接在网页上读取对应的信息」。
   * 登录墙/人机验证/连不上时不带：那种页面上没有可读的东西。
   */
  | { ok: false; error: string; needsLogin?: boolean; connectFailed?: boolean; read?: PageRead };

/** 页面直读带回的东西：与 PAGE_READ_FN 的产出一字不差。链接只用于当场认作品 ID，不进学习、不落配方。 */
export type PageRead = { title: string; finalUrl: string; text: string; links: { href: string; text: string }[] };

/** 找插件源码目录：整机包是 git archive 打的，仓库根目录下就有 extension/。 */
function parserDir(): string | null {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const dir = path.join(base, 'extension', 'content');
    if (fs.existsSync(path.join(dir, 'common.js'))) return dir;
  }
  return null;
}

export function loadParserSources(platform: string): { ok: true; scripts: string[] } | { ok: false; error: string } {
  const file = PLATFORM_PARSER_FILE[platform];
  if (!file) return { ok: false, error: `${platform} 没有主页解析器，本机浏览器采不了这个平台` };
  const dir = parserDir();
  if (!dir) return { ok: false, error: '这个安装包里没有带插件解析器文件（extension/content），本机浏览器采集用不了' };
  try {
    return {
      ok: true,
      scripts: [CHROME_SHIM, fs.readFileSync(path.join(dir, 'common.js'), 'utf8'), fs.readFileSync(path.join(dir, file), 'utf8')],
    };
  } catch (e) {
    return { ok: false, error: `读不到解析器文件：${e instanceof Error ? e.message : String(e)}` };
  }
}

let collecting = false;
export function isLocalCollecting(): boolean {
  return collecting;
}

/**
 * 打开一个平台主页、用插件解析器采一遍。
 * 只开一页、只读、用完关；登录墙如实报出来（不替用户登录，也不把页面留在前台——
 * 这条路是任务派下来的，用户未必在电脑前，弹到前台只会留下一个莫名其妙的标签）。
 */
export async function collectPlatformPageLocal(
  cdpUrl: string,
  url: string,
  platform: string,
  opts: { deep?: boolean } = {},
): Promise<LocalCollectResult> {
  const vet = vetCdpUrl(cdpUrl);
  if (!vet.ok) return { ok: false, error: vet.error! };
  let origin = '';
  try { origin = new URL(url).origin; } catch { return { ok: false, error: '网址格式不对' }; }
  const c = complianceCheck(origin);
  if (!c.ok) return { ok: false, error: c.reason! };
  if (await isSiteRemovalRequested(origin)) return { ok: false, error: SITE_STOPPED_REASON };
  const src = loadParserSources(platform);
  if (!src.ok) return { ok: false, error: src.error };
  if (collecting) return { ok: false, error: '本机浏览器正在采别的页面，稍后再试' };

  const { chromium } = await import('playwright-core');
  collecting = true;
  let browser;
  try {
    browser = await chromium.connectOverCDP(vet.url!, { timeout: 8000 });
  } catch (e) {
    collecting = false;
    return {
      ok: false,
      connectFailed: true,
      error: `连不上本机浏览器（${vet.url}）：请先用调试端口启动 Chrome（客户端托盘里有「启动采集浏览器」）。${e instanceof Error ? e.message : ''}`,
    };
  }
  try {
    // 只在默认上下文（用户的登录态在里面）里**新开一页**；绝不遍历、绝不读已开着的标签
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(1500);
      const title = (await page.title()).slice(0, 200);
      const wall = await page.evaluate(LOGIN_WALL_FN) as { walled: boolean; kind: string; why: string };
      if (wall.walled) {
        return {
          ok: false,
          needsLogin: wall.kind === 'login',
          error: wall.kind === 'login'
            ? `这个主页要求登录（${wall.why}）。在你的 Chrome 里登录一次该平台再派（我不会替你输入账号密码）。`
            : `这个站点这次要求人机验证或提示访问过于频繁（${wall.why}），过一阵再试。我们不会替你过验证码。`,
        };
      }
      for (const s of src.scripts) await page.addScriptTag({ content: s });
      const r = await page.evaluate(COLLECT_FN, { deep: opts.deep !== false }) as
        | { payload: ParsedPagePayload }
        | { error: string };
      // 解析器认不出 / 一条没读到：把页面可见文字与链接带回，服务端可让模型直读（页面直读，2026-09-16）
      const read = ('error' in r || !r.payload.posts?.length)
        ? await page.evaluate(PAGE_READ_FN).catch(() => undefined) as PageRead | undefined
        : undefined;
      if ('error' in r) {
        const why = r.error === 'no_handle'
          ? '解析器没在这一页认出账号主页（可能没加载完、或站点改版了）'
          : r.error === 'parser_missing' ? '解析器没装载上'
          : r.error === 'parser_stale'
            ? '解析器取不到内容：页面上能看到作品，但读不出正文与数据。最常见的原因是**采集浏览器还没登录这个平台**（X 未登录时给的是精简页面，没有可读的结构）——请在「烽火台采集浏览器」窗口里登录一次再派；已经登录仍这样的话，就是站点改版了，等解析器更新（服务端修好当天生效，客户端不用重装）。'
            : r.error;
        return { ok: false, error: why, ...(read ? { read } : {}) };
      }
      if (!r.payload.posts?.length) return { ok: false, error: '主页上一条作品都没读到。最常见的原因是**采集浏览器还没登录这个平台**（很多站点未登录时只给一个登录弹层）——去「烽火台采集浏览器」窗口里登录一次再派；也可能是页面没加载完，或这个号确实没发过内容。', ...(read ? { read } : {}) };
      return { ok: true, title, payload: r.payload };
    } finally {
      await page.close().catch(() => { /* 关不掉不影响结论 */ });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '打开页面失败' };
  } finally {
    collecting = false;
    // 只断开连接，不关用户的浏览器（connectOverCDP 拿到的 browser，close 的语义是断开；见 local.ts）
    await browser.close().catch(() => { /* 同上 */ });
  }
}

// ── 创作者后台（2026-09-16 起桌面客户端 / 本机浏览器也进）──────────────────────
//
// 用户原话：「每一个平台都可以通过插件或者调用浏览器的方式采集对应的数据」。
// 此前后台回填只有插件会做（内容脚本 + 用户日常 Chrome 的登录态）。采集专用浏览器是独立 profile、
// 登录态长存，用户在里面登过一次后台，后面就能像插件一样进去读——脚本仍是插件那份 self-backend.js
// **原样注入**（与主页解析器同一条「三条路一个解析器」的原则），站内走哪几页由它的 autoRoutes 算。

/** 后台脚本文件；公众号那份是可选模块（开源发行版不带），要排在 self-backend.js 之前（它先把配置放进 __beaconBackendExtras） */
export const BACKEND_PARSER_FILE = 'self-backend.js';
export const WECHAT_BACKEND_MODULE = 'self-backend-wechat.js';

export function loadBackendSources(platform: string): { ok: true; scripts: string[] } | { ok: false; error: string } {
  if (!(SELF_BACKEND_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, error: `${platform} 没有创作者后台可回填` };
  const dir = parserDir();
  if (!dir) return { ok: false, error: '这个安装包里没有带插件解析器文件（extension/content），本机浏览器采集用不了' };
  const files = ['common.js'];
  if (platform === 'wechat') {
    if (!fs.existsSync(path.join(dir, WECHAT_BACKEND_MODULE))) {
      return { ok: false, error: '这个发行版不带公众号后台模块（self-backend-wechat.js），公众号后台只能由官方发行版的插件回填' };
    }
    files.push(WECHAT_BACKEND_MODULE);
  }
  files.push(BACKEND_PARSER_FILE);
  try {
    return { ok: true, scripts: [CHROME_SHIM, ...files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))] };
  } catch (e) {
    return { ok: false, error: `读不到后台脚本：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 这一页是哪个后台、停在登录页没有、该走哪几站——判据在 self-backend.js 的 __beaconBackendProbe 里（与插件同一套）。 */
export const BACKEND_PROBE_FN = `() => (typeof globalThis.__beaconBackendProbe === 'function'
  ? globalThis.__beaconBackendProbe(location.href)
  : { known: false, platform: null, login: false, onDataPage: false, routes: [], noRoutes: null })`;

/**
 * 等后台列表把数据渲染出来再读：后台列表是异步出数的，一上来解析必然是空的。
 * 节奏与插件那条路一致（self-backend.js 的 BEACON_AUTO_POLL_MS × BEACON_AUTO_POLL_MAX ≈ 14 秒）。
 */
export const BACKEND_COLLECT_FN = `async () => {
  const parse = globalThis.__beaconParse;
  if (typeof parse !== 'function') return { error: 'parser_missing' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 12; i += 1) {
    await sleep(1200);
    let payload = null;
    try { payload = parse(); } catch (e) { return { error: 'parse_threw: ' + (e && e.message) }; }
    if (payload && ((payload.posts && payload.posts.length > 0) || payload.dailyStats || payload.audience)) return { payload };
  }
  return { error: 'no_rows' };
}`;

export type BackendPayload = {
  platform: string;
  handle: string;
  posts: Array<Record<string, unknown>>;
  dailyStats?: unknown[];
  audience?: unknown;
  /** 走了哪几站（回执/排查用） */
  routes?: string[];
};

/** 几站读到的东西合成一份：作品按 platformItemId 去重（指标合并、先到者优先），账号级块取第一份非空。 */
export function mergeBackendPayloads(platform: string, parts: BackendPayload[], routes: string[] = []): BackendPayload | null {
  const byId = new Map<string, Record<string, unknown>>();
  let dailyStats: unknown[] | undefined;
  let audience: unknown;
  for (const p of parts) {
    for (const post of p.posts ?? []) {
      const id = String(post.platformItemId ?? '');
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev) { byId.set(id, { ...post }); continue; }
      const pm = (prev.metrics && typeof prev.metrics === 'object') ? (prev.metrics as Record<string, unknown>) : {};
      const nm = (post.metrics && typeof post.metrics === 'object') ? (post.metrics as Record<string, unknown>) : {};
      byId.set(id, { ...post, ...prev, metrics: { ...nm, ...pm } });
    }
    if (!dailyStats && Array.isArray(p.dailyStats) && p.dailyStats.length) dailyStats = p.dailyStats;
    if (!audience && p.audience) audience = p.audience;
  }
  if (byId.size === 0 && !dailyStats && !audience) return null;
  return {
    platform, handle: 'self', posts: Array.from(byId.values()).slice(0, 50),
    ...(dailyStats ? { dailyStats } : {}), ...(audience ? { audience } : {}), routes,
  };
}

export type LocalBackendResult =
  | { ok: true; payload: BackendPayload }
  | { ok: false; error: string; needsLogin?: boolean; connectFailed?: boolean };

/**
 * 用本机浏览器进自己的创作者后台读数（2026-09-16）。
 * 入口 → 探针（哪个后台/登没登录/该走哪几站）→ 逐站导航、注入、读数 → 合并。
 * 只读、只新开一页、用完关；登录页如实报出来（本机浏览器是用户日常的 Chrome，不弹到前台等他登——
 * 这条路是任务派下来的，人未必在电脑前）。
 */
export async function collectBackendLocal(cdpUrl: string, platform: string): Promise<LocalBackendResult> {
  const vet = vetCdpUrl(cdpUrl);
  if (!vet.ok) return { ok: false, error: vet.error! };
  const entry = backendEntryFor(platform);
  if (!entry) return { ok: false, error: `${platform} 没有创作者后台可回填` };
  const c = complianceCheck(entry.origin);
  if (!c.ok) return { ok: false, error: c.reason! };
  if (await isSiteRemovalRequested(entry.origin)) return { ok: false, error: SITE_STOPPED_REASON };
  const src = loadBackendSources(platform);
  if (!src.ok) return { ok: false, error: src.error };
  if (collecting) return { ok: false, error: '本机浏览器正在采别的页面，稍后再试' };

  const { chromium } = await import('playwright-core');
  collecting = true;
  let browser;
  try {
    browser = await chromium.connectOverCDP(vet.url!, { timeout: 8000 });
  } catch (e) {
    collecting = false;
    return { ok: false, connectFailed: true, error: `连不上本机浏览器（${vet.url}）：请先用调试端口启动 Chrome（客户端托盘里有「启动采集浏览器」）。${e instanceof Error ? e.message : ''}` };
  }
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    const inject = async () => { for (const s of src.scripts) await page.addScriptTag({ content: s }); };
    try {
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(2500);
      await inject();
      const probe = await page.evaluate(BACKEND_PROBE_FN) as { known: boolean; login: boolean; routes: string[]; noRoutes: { reason?: string; needLogin?: boolean } | null };
      if (!probe.known) return { ok: false, error: `打开 ${entry.label} 后被带到了一个不认识的页面（${page.url().slice(0, 120)}），没法读数` };
      if (probe.login) return { ok: false, needsLogin: true, error: `${entry.label}还没登录。在本机浏览器里登录一次再派（我不会替你输入账号密码）。` };
      const routes = (probe.routes ?? []).slice(0, 4);
      if (routes.length === 0) {
        return { ok: false, needsLogin: !!probe.noRoutes?.needLogin, error: probe.noRoutes?.reason || `${entry.label}里没找到「作品数据/内容管理」页的入口，这次没读到` };
      }
      const parts: BackendPayload[] = [];
      for (const r of routes) {
        try {
          await page.goto(r, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await page.waitForTimeout(1500);
          await inject();
          const got = await page.evaluate(BACKEND_COLLECT_FN) as { payload?: BackendPayload; error?: string };
          if (got.payload) parts.push(got.payload);
        } catch { /* 某一站打不开不该让整趟白跑 */ }
      }
      const merged = mergeBackendPayloads(platform, parts, routes);
      if (!merged) return { ok: false, error: `${entry.label}的作品数据页上一行都没读到（可能页面改版了、列表还没出数，或这个号还没发过内容）` };
      return { ok: true, payload: merged };
    } finally {
      await page.close().catch(() => { /* 关不掉不影响结论 */ });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '打开后台页失败' };
  } finally {
    collecting = false;
    await browser.close().catch(() => { /* 只断开连接 */ });
  }
}

// ── 配方（2026-09-16 起桌面客户端 / 本机浏览器也按配方采）──────────────────────
//
// 执行器不知道配方长什么样：规则与选项由服务端随脚本包下发，页面里跑的是插件那份 tools/recipe-run.js
// **原样包一层**（它读 window.__beaconRecipe），三条路同一份取值逻辑。学习（骨架→规则）与映射
// （行→作品）仍只在服务端有一份。

/** 等配方指定的就绪选择器（没有就算就绪）。 */
export const RECIPE_READY_FN = `(sel) => { if (!sel) return true; try { return !!document.querySelector(sel); } catch { return true; } }`;

export function loadRecipeRunner(): { ok: true; fn: string } | { ok: false; error: string } {
  const dir = parserDir();
  if (!dir) return { ok: false, error: '这个安装包里没有带插件脚本（extension/），配方采集用不了' };
  const file = path.join(dir, '..', 'tools', 'recipe-run.js');
  if (!fs.existsSync(file)) return { ok: false, error: '这个安装包里没有带配方执行器（extension/tools/recipe-run.js）' };
  const src = fs.readFileSync(file, 'utf8');
  // recipe-run.js 是一个「求值即返回结果」的 IIFE；括号包住是为了让 return 后面允许换行与注释（ASI）
  return { ok: true, fn: `(recipe) => { window.__beaconRecipe = recipe; return (\n${src}\n); }` };
}

export type RecipeForExecutor = {
  id: string; origin: string; pathPattern: string | null; status: string; version: number;
  rules: unknown[]; options: Record<string, unknown>;
};

/** recipe-run.js 的三种产出（与插件 runRecipeOnTab 看到的一字不差）。 */
export type RecipeOutcome =
  | { ok: true; mode: 'learn'; skeleton: unknown }
  | { ok: false; mode: 'stale'; skeleton: unknown }
  | { ok: true; mode: 'scrape'; values: Record<string, string>; rows: Record<string, string>[]; got: number; want: number }
  | { ok: false; error: string };

export type LocalRecipeResult =
  | { ok: true; outcome: RecipeOutcome; read: PageRead; finalUrl: string }
  | { ok: false; error: string; needsLogin?: boolean; connectFailed?: boolean };

/** 用本机浏览器按配方采一页；顺带把页面可见文字与链接带回（配方还没学会时模型直读兜底）。 */
export async function collectRecipeLocal(cdpUrl: string, url: string, recipe: RecipeForExecutor): Promise<LocalRecipeResult> {
  const vet = vetCdpUrl(cdpUrl);
  if (!vet.ok) return { ok: false, error: vet.error! };
  let origin = '';
  try { origin = new URL(url).origin; } catch { return { ok: false, error: '网址格式不对' }; }
  const c = complianceCheck(origin);
  if (!c.ok) return { ok: false, error: c.reason! };
  if (await isSiteRemovalRequested(origin)) return { ok: false, error: SITE_STOPPED_REASON };
  const runner = loadRecipeRunner();
  if (!runner.ok) return { ok: false, error: runner.error };
  if (collecting) return { ok: false, error: '本机浏览器正在采别的页面，稍后再试' };

  const { chromium } = await import('playwright-core');
  collecting = true;
  let browser;
  try {
    browser = await chromium.connectOverCDP(vet.url!, { timeout: 8000 });
  } catch (e) {
    collecting = false;
    return { ok: false, connectFailed: true, error: `连不上本机浏览器（${vet.url}）：请先用调试端口启动 Chrome（客户端托盘里有「启动采集浏览器」）。${e instanceof Error ? e.message : ''}` };
  }
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(1500);
      const wall = await page.evaluate(LOGIN_WALL_FN) as { walled: boolean; kind: string; why: string };
      if (wall.walled) {
        return {
          ok: false,
          needsLogin: wall.kind === 'login',
          error: wall.kind === 'login'
            ? `这个主页要求登录（${wall.why}）。在你的 Chrome 里登录一次该平台再派（我不会替你输入账号密码）。`
            : `这个站点这次要求人机验证或提示访问过于频繁（${wall.why}），过一阵再试。我们不会替你过验证码。`,
        };
      }
      const ready = String((recipe.options as { readySelector?: unknown })?.readySelector ?? '');
      for (let i = 0; i < 20; i += 1) {
        if (await page.evaluate(RECIPE_READY_FN, ready)) break;
        await page.waitForTimeout(1000);
      }
      const outcome = await page.evaluate(runner.fn, recipe) as RecipeOutcome;
      const read = await page.evaluate(PAGE_READ_FN) as PageRead;
      return { ok: true, outcome, read, finalUrl: page.url() };
    } finally {
      await page.close().catch(() => { /* 同上 */ });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '打开页面失败' };
  } finally {
    collecting = false;
    await browser.close().catch(() => { /* 同上 */ });
  }
}
