import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { PLATFORMS } from '@/lib/constants';
import {
  BROWSER_TASK_KINDS, SELF_BACKEND_PLATFORMS, RECIPE_PLATFORMS, SELF_PROFILE_PLATFORMS,
  selfCollectKindFor, competitorKindFor, selfProfileFallbackFor,
} from '@/lib/browser-task/kinds';
import { SELF_BACKEND_ENTRY } from '@/lib/browser-task/backend-entries';
import { competitorHomeUrl } from '@/lib/competitor-url';

// 「每一个平台都可以通过插件或者调用浏览器的方式采集对应的数据或者竞对的数据」（用户 2026-09-16 原话）。
//
// 这份用例把那句话钉成机器判据：PLATFORMS 里的每个平台
//   ① 自有数据有一条服务端能派的路（后台 / 公开主页 / 配方）；
//   ② 竞对有一条路（主页解析器 / 配方），例外只有公众号与视频号——它们没有公开主页，这是平台结构，不是我们没做；
//   ③ 三条执行路（插件 sw.js、桌面客户端 executor.rs、本机浏览器 local-run.ts）都认识白名单里的每一种 kind；
//   ④ 桌面客户端/本机浏览器进后台用的入口表与插件那张逐字相同；
//   ⑤ 插件的 self-backend.js 真的导出了给 CDP 注入方用的探针。
// 少一条就是又回到「有的平台采得到、有的采不到」。

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 竞对没有公开主页可开的平台：公众号（只能走用户自己后台查别人——已按用户要求删除）、视频号（没有 web 主页） */
const NO_PUBLIC_HOME = new Set(['wechat', 'shipinhao']);

describe('每个平台都有路', () => {
  it('① 自有数据：PLATFORMS 里的每个平台 selfCollectKindFor 都不为 null', () => {
    for (const key of Object.keys(PLATFORMS)) {
      expect(selfCollectKindFor(key), `${key} 没有可派的自有回填路`).not.toBeNull();
    }
  });

  it('① 后台平台优先走后台；抖音/小红书/B站另有公开主页当退路；视频号/公众号没有退路', () => {
    for (const p of SELF_BACKEND_PLATFORMS) expect(selfCollectKindFor(p)).toBe('collect_self_backend');
    for (const p of ['douyin', 'xiaohongshu', 'bilibili']) expect(selfProfileFallbackFor(p), `${p} 该有公开主页退路`).toBe(true);
    for (const p of ['shipinhao', 'wechat']) expect(selfProfileFallbackFor(p), `${p} 没有公开主页`).toBe(false);
    for (const p of RECIPE_PLATFORMS) expect(selfCollectKindFor(p)).toBe('collect_self_recipe');
    for (const p of ['x', 'tiktok', 'youtube']) expect(selfCollectKindFor(p)).toBe('collect_self_profile');
  });

  it('② 竞对：除公众号/视频号外每个平台都拼得出主页地址，且 kind 按平台分（配方 / 解析器）', () => {
    for (const key of Object.keys(PLATFORMS)) {
      if (NO_PUBLIC_HOME.has(key)) {
        expect(competitorHomeUrl(key, 'h'), `${key} 没有公开主页，不该拼出地址`).toBeNull();
        continue;
      }
      expect(competitorHomeUrl(key, 'h'), `${key} 拼不出竞对主页地址`).not.toBeNull();
      expect(competitorKindFor(key)).toBe((RECIPE_PLATFORMS as readonly string[]).includes(key) ? 'collect_competitor_recipe' : 'collect_competitor');
    }
  });

  it('② 自有主页的地址与竞对同一套拼法：SELF_PROFILE_PLATFORMS 与配方平台在插件 SELF_COLLECT_URL 里都有入口', () => {
    const sw = read('extension/sw.js');
    const block = sw.slice(sw.indexOf('const SELF_COLLECT_URL'), sw.indexOf('function selfCollectUrl'));
    for (const p of [...SELF_PROFILE_PLATFORMS, ...RECIPE_PLATFORMS]) {
      expect(block, `插件没有 ${p} 的主页入口`).toMatch(new RegExp(`^\\s{2}${p}:`, 'm'));
    }
  });

  it('③ 三条执行路都认识白名单里的每一种 kind', () => {
    const rs = read('desktop/src-tauri/src/executor.rs');
    const kinds = rs.match(/pub const SUPPORTED_KINDS: &str = "([^"]+)"/)?.[1].split(',') ?? [];
    for (const k of BROWSER_TASK_KINDS) expect(kinds, `桌面客户端不自报 ${k}`).toContain(k);
    const sw = read('extension/sw.js');
    const listed = sw.match(/const SUPPORTED_TASK_KINDS = \[([^\]]+)\]/)![1].match(/'(\w+)'/g)!.map((s) => s.replace(/'/g, ''));
    for (const k of BROWSER_TASK_KINDS) expect(listed, `插件不自报 ${k}`).toContain(k);
    const run = strip(read('lib/browser-task/local-run.ts'));
    const fn = run.slice(run.indexOf('export async function runBrowserTaskLocally'));
    for (const k of BROWSER_TASK_KINDS) {
      if (k === 'collect_competitor' || k === 'collect_self_profile') continue; // 主页类走最后那条公共路径
      expect(fn, `本机浏览器那条路没有 ${k} 的分支`).toContain(`payload.kind === '${k}'`);
    }
  });

  it('③ 桌面客户端对后台 / 配方各有执行函数，且交回时带 backend / recipe 原料；主页类认不出时带页面直读', () => {
    const rs = strip(read('desktop/src-tauri/src/executor.rs'));
    expect(rs).toMatch(/"collect_self_backend" => run_backend\(/);
    expect(rs).toMatch(/"collect_competitor_recipe" \| "collect_self_recipe" => run_recipe\(/);
    expect(rs).toMatch(/json!\(\{ "backend": backend \}\)/);
    expect(rs).toMatch(/json!\(\{ "recipe": outcome, "read": read, "url": cur \}\)/);
    expect(rs).toMatch(/"read": read, "parserError": why/);
    // 脚本包按 kind 现取；后台/配方脚本不随客户端打包
    expect(rs).toContain('/api/ingest/executor?platform={}&kind={}');
    expect(rs, '后台脚本/配方执行器不该写死在客户端里').not.toMatch(/__beaconParse|__beaconRecipe/);
  });

  it('③ 服务端交活入口对四种原料一个分发（不再只收主页解析器产物）', () => {
    const route = strip(read('app/api/ingest/tasks/route.ts'));
    expect(route).toContain('ingestExecutorResult(');
    expect(route).toContain("payload.data.kind !== 'open_and_read'");
    const ex = strip(read('app/api/ingest/executor/route.ts'));
    for (const k of ['collect_self_backend', 'collect_competitor_recipe', 'collect_self_recipe']) expect(ex).toContain(`'${k}'`);
    expect(ex).toContain('backendProbe: BACKEND_PROBE_FN');
    expect(ex).toContain('recipeRun: runner.fn');
    expect(ex).toContain('pageRead: PAGE_READ_FN');
  });

  it('④ 服务端的后台入口表与插件 SELF_AUTO_CORE_ENTRIES（+ 可选模块的公众号入口）逐字相同', () => {
    const sw = read('extension/sw.js');
    const block = sw.slice(sw.indexOf('const SELF_AUTO_CORE_ENTRIES = {'), sw.indexOf('const SELF_AUTO_ENTRY ='));
    for (const p of ['shipinhao', 'douyin', 'xiaohongshu', 'bilibili'] as const) {
      const m = block.match(new RegExp(`${p}: \\{ origin: '([^']+)', url: '([^']+)'`));
      expect(m, `插件表里没有 ${p}`).not.toBeNull();
      expect(SELF_BACKEND_ENTRY[p].origin).toBe(m![1]);
      expect(SELF_BACKEND_ENTRY[p].url).toBe(m![2]);
    }
    const modFile = path.join(ROOT, 'extension/sw-self-backends.js');
    if (fs.existsSync(modFile)) {
      const mod = fs.readFileSync(modFile, 'utf8');
      expect(mod).toContain(`origin: '${SELF_BACKEND_ENTRY.wechat.origin}'`);
      expect(mod).toContain(`url: '${SELF_BACKEND_ENTRY.wechat.url}'`);
    }
    for (const p of SELF_BACKEND_PLATFORMS) expect(SELF_BACKEND_ENTRY[p].url.startsWith(SELF_BACKEND_ENTRY[p].origin)).toBe(true);
  });

  it('⑤ self-backend.js 导出 __beaconBackendProbe：认得出后台、答登录页/数据页/路线，且不发消息', () => {
    const src = read('extension/content/self-backend.js');
    expect(src).toContain('globalThis.__beaconBackendProbe = function (href)');
    const seg = src.slice(src.indexOf('globalThis.__beaconBackendProbe'), src.indexOf('globalThis.__beaconAutoRoutes'));
    expect(seg).toContain('beaconLooksLikeLoginPage(cfg)');
    expect(seg).toContain('cfg.autoRoutes(');
    expect(seg, '探针是纯读的，不该向 SW 发消息').not.toContain('beaconAutoSend');
    // 在一个假的抖音创作者后台页面里跑一遍：认得出平台、登录页判定、候选路线
    const ctx = vm.createContext({
      location: { hostname: 'creator.douyin.com', pathname: '/creator-micro/home', search: '', hash: '', href: 'https://creator.douyin.com/creator-micro/home', origin: 'https://creator.douyin.com' },
      document: { body: { textContent: '抖音创作者中心 作品数据 内容管理' }, querySelector: () => null, querySelectorAll: () => [], documentElement: {}, URL: 'https://creator.douyin.com/creator-micro/home' },
      URL, console, setTimeout, clearTimeout,
      chrome: { runtime: { sendMessage: (_m: unknown, cb?: (r: unknown) => void) => { cb?.(null); }, lastError: null } },
      globalThis: undefined,
    });
    (ctx as Record<string, unknown>).globalThis = ctx;
    vm.runInContext(src, ctx);
    const probe = vm.runInContext("__beaconBackendProbe('https://creator.douyin.com/creator-micro/home')", ctx) as { known: boolean; platform: string; login: boolean; routes: string[] };
    expect(probe.known).toBe(true);
    expect(probe.platform).toBe('douyin');
    expect(probe.login).toBe(false);
    expect(probe.routes.length).toBeGreaterThan(0);
    expect(probe.routes.every((r) => r.startsWith('https://creator.douyin.com/'))).toBe(true);
    const unknown = vm.runInContext("(() => { location.hostname = 'example.com'; return __beaconBackendProbe(); })()", ctx) as { known: boolean };
    expect(unknown.known).toBe(false);
  });
});
