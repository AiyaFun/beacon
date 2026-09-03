import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CHROME_SHIM, PLATFORM_PARSER_FILE, loadParserSources } from '@/lib/browser/local-collect';
import { SELF_PROFILE_PLATFORMS } from '@/lib/browser-task/kinds';
import { between, orderedBefore } from '../helpers/anchor';

// 本机 Chrome 采平台主页（2026-09-03）。
//
// 【守的核心】这条路复用插件的解析器（注入 common.js + 平台解析器），产出与插件回传一字不差；
// 边界与 lib/browser/local.ts 那五条相同：只读、只新开一页、端点只能本机、合规闸与停采闸在导航前。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const src = read('lib/browser/local-collect.ts');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('只读、只新开一页、不碰凭据', () => {
  it('不出现任何点击/填写/按键动作', () => {
    for (const forbidden of ['.click(', '.fill(', '.type(', '.press(']) {
      expect(code, `不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('只在默认上下文里 newPage，绝不遍历已开着的标签', () => {
    expect(code).toContain('browser.contexts()[0]');
    expect(code).toContain('ctx.newPage()');
    expect(code).not.toContain('.pages()');
  });

  it('端点必须过 vetCdpUrl（只能本机回环）', () => {
    orderedBefore(code, 'vetCdpUrl(cdpUrl)', 'connectOverCDP(');
  });

  it('合规闸与站点停采闸都在连接浏览器之前', () => {
    orderedBefore(code, 'complianceCheck(origin)', 'connectOverCDP(');
    orderedBefore(code, 'await isSiteRemovalRequested(origin)', 'connectOverCDP(');
  });

  it('登录墙先判再注入解析器（不然会照着登录页解析出空结果）', () => {
    orderedBefore(code, 'page.evaluate(LOGIN_WALL_FN)', 'page.addScriptTag(');
    expect(code).not.toContain('bringToFront'); // 派下来的任务人未必在电脑前，不弹前台
  });

  it('页面用完必关、连接只断开不关浏览器', () => {
    expect(code).toContain('await page.close()');
    expect(code).toContain('await browser.close()');
  });
});

describe('解析器来自插件，不另写一套', () => {
  it('每个平台对应的文件都真的在 extension/content 里，且是主页解析器（不是作品页那份）', () => {
    for (const [platform, file] of Object.entries(PLATFORM_PARSER_FILE)) {
      const p = path.join(__dirname, '..', '..', 'extension', 'content', file);
      expect(fs.existsSync(p), `${platform} → ${file} 不存在`).toBe(true);
      expect(read(`extension/content/${file}`), `${file} 不像主页解析器`).toContain('globalThis.__beaconParse = ');
      // 作品页脚本会覆盖 __beaconParse（内容脚本覆盖陷阱），这张表里不许出现它们
      expect(file).not.toMatch(/video|note|work|comments|article/);
    }
  });

  it('自有主页回填支持的平台都有解析器', () => {
    for (const p of SELF_PROFILE_PLATFORMS) expect(PLATFORM_PARSER_FILE[p], `${p} 缺解析器`).toBeTruthy();
  });

  it('加载顺序：垫片 → common.js → 平台解析器', () => {
    const r = loadParserSources('x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scripts).toHaveLength(3);
      expect(r.scripts[0]).toBe(CHROME_SHIM);
      expect(r.scripts[1]).toContain('globalThis.__beaconParseCount');
      expect(r.scripts[2]).toContain("platform: 'x'");
    }
  });

  it('没有解析器的平台如实拒绝', () => {
    expect(loadParserSources('wechat').ok).toBe(false);
  });

  it('🔒 垫片盖住 common.js 顶层碰到的每一个 chrome.* 路径（漏一个脚本就在那一行抛掉）', () => {
    const common = read('extension/content/common.js');
    const used = new Set<string>();
    for (const m of common.matchAll(/chrome\.(\w+)\.(\w+)/g)) used.add(`${m[1]}.${m[2]}`);
    expect(used.size).toBeGreaterThan(0);
    for (const u of used) {
      const [ns, member] = u.split('.');
      expect(CHROME_SHIM, `垫片没盖住 chrome.${u}`).toContain(`c.${ns}.${member} = c.${ns}.${member} ||`);
    }
  });
});

describe('robots.txt 不在这条路判，但 URL 只能来自已知账号', () => {
  it('🔒 local-collect.ts 不导入 robotsAllows（同一批页面两条路两套判据→说不清）', () => {
    expect(code).not.toContain('robotsAllows');
    expect(code).not.toContain("from '../scrape/robots'");
    expect(code).not.toContain("from '../../scrape/robots'");
  });

  it('🔒 local-run.ts 的 URL 全部来自 competitorHomeUrl（不透传任意 URL）', () => {
    const run = read('lib/browser-task/local-run.ts');
    const runCode = run.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 采主页的 URL 只有一个来源：executorTarget（自有账号 handle / 已订阅竞对 → competitorHomeUrl）
    const calls = runCode.match(/collectPlatformPageLocal\([^)]+\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) expect(call).toContain('target.url');
    const target = runCode.slice(runCode.indexOf('export async function executorTarget'), runCode.indexOf('export async function runBrowserTaskLocally'));
    const urlAssigns = target.match(/const url = [^;]+;/g) ?? [];
    expect(urlAssigns.length).toBeGreaterThanOrEqual(2);
    for (const a of urlAssigns) expect(a, 'URL 只从 competitorHomeUrl 构建').toContain('competitorHomeUrl(');
    expect(runCode).not.toMatch(/collectPlatformPageLocal\(cdpUrl, payload\.url/);
  });
});

describe('落库走与插件相同的函数', () => {
  const run = read('lib/browser-task/local-run.ts');
  it('自有主页 → ingestOwnPostData，竞对 → ingestCompetitorData（都在 ingestParsedPage 里），本机那条路通道标 local_browser', () => {
    const ingest = between(run, 'export async function ingestParsedPage', 'export async function executorTarget');
    expect(ingest).toContain('ingestOwnPostData(');
    expect(ingest).toContain('ingestCompetitorData(');
    expect(ingest).toContain('{ channel }');
    expect(run).toContain("channel: 'local_browser'");
  });

  it('自有主页回填前核对 handle：打开的不是这个账号的主页就一条都不写', () => {
    const seg = between(run, "if (payload.kind === 'collect_self_profile') {", 'ingestOwnPostData(');
    expect(seg).toContain('norm(parsed.handle) !== norm(payload.handle)');
  });

  it('可用判定 = 形态允许 且 配了合法本机端点（SaaS 第一道就回 null）', () => {
    const seg = between(run, 'export async function localBrowserCdpUrl', 'export type LocalRunResult');
    expect(seg).toContain("editionCan('localBrowser')");
    expect(seg).toContain('vetCdpUrl(');
  });
});
