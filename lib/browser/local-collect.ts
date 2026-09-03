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
  | { ok: false; error: string; needsLogin?: boolean; connectFailed?: boolean };

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
      if ('error' in r) {
        const why = r.error === 'no_handle'
          ? '解析器没在这一页认出账号主页（可能没加载完、或站点改版了）'
          : r.error === 'parser_missing' ? '解析器没装载上' : r.error;
        return { ok: false, error: why };
      }
      if (!r.payload.posts?.length) return { ok: false, error: '主页上没读到作品（可能没加载完，或这个号还没发过内容）' };
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
