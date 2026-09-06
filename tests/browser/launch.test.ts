import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromeCandidates, cdpLive, DEFAULT_CDP_URL } from '@/lib/browser/launch';
import { orderedBefore } from '../helpers/anchor';

// 服务端自己拉起本机 Chrome（2026-09-03）——「浏览器操作」一个开关的底座。
// 【守的核心】与客户端那份（desktop/src-tauri/src/collect_browser.rs）同一套规矩：
// 先探端口 / 绝不替用户杀浏览器 / 独立 profile 只 spawn / 只认本机回环。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = strip(read('lib/browser/launch.ts'));

describe('拉起本机 Chrome 的边界', () => {
  it('🔒 绝不杀浏览器：没有 kill / pkill / taskkill / SIGTERM', () => {
    for (const bad of ['kill(', 'pkill', 'taskkill', 'SIGTERM', 'SIGKILL', 'process.kill']) {
      expect(src, `不该出现 ${bad}`).not.toContain(bad);
    }
  });

  it('🔒 顺序：先探端口 → 没通就用独立 profile 起一个；不再要求用户退出日常 Chrome（2026-09-05：Chrome ≥136 默认 profile 开不了端口，那条指引照做也永远不会成功）', () => {
    orderedBefore(src, 'await cdpLive(url)', 'spawn(chrome');
    expect(src, '还在要求 ⌘Q').not.toContain('完全退出 Chrome');
    expect(src, '还在指向已删除的托盘项').not.toContain('「启动采集浏览器」');
    expect(src).toContain("reason: 'not_up'");
  });

  it('🔒 独立采集 profile（不碰日常 Chrome）、detached+unref（服务重启不带走浏览器）、端口只在本机', () => {
    orderedBefore(src, 'fs.mkdirSync(dir, { recursive: true })', 'spawn(chrome');
    expect(src).toContain('`--user-data-dir=${dir}`');
    expect(src).toContain('--remote-debugging-port=9222');
    expect(src).toContain('--remote-debugging-address=127.0.0.1');
    expect(src).toContain('detached: true');
    expect(src).toContain('child.unref()');
    expect(src).toContain('vetCdpUrl(url)'); // cdpLive 先过回环闸
    expect(DEFAULT_CDP_URL).toBe('http://127.0.0.1:9222');
  });

  it('起完要等握手通了才算开启（否则用户第一次派活就撞「连不上」）', () => {
    orderedBefore(src, 'child.unref()', 'const deadline');
    expect(src).toContain("reason: 'not_up'");
  });

  it('各平台候选路径只认 Chrome，不猜别的浏览器', () => {
    expect(chromeCandidates('darwin', { HOME: '/Users/x' })).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
    const win = chromeCandidates('win32', { PROGRAMFILES: 'C:\\PF', LOCALAPPDATA: 'C:\\LA' });
    expect(win).toEqual(['C:\\PF\\Google\\Chrome\\Application\\chrome.exe', 'C:\\LA\\Google\\Chrome\\Application\\chrome.exe']);
    expect(chromeCandidates('linux', {}).every((p) => /chrom/.test(p))).toBe(true);
  });

  it('cdpLive：非本机地址直接 false（连探都不探）；本机没人听也是 false', async () => {
    expect((await cdpLive('http://example.com:9222')).live).toBe(false);
    expect((await cdpLive('http://127.0.0.1:1', 300)).live).toBe(false);
  });
});

describe('🔒 设置页「浏览器操作」一个开关接到了拉起逻辑', () => {
  const actions = strip(read('app/(app)/settings/shell-actions.ts'));
  const card = read('app/(app)/settings/LocalShellCard.tsx');

  it('action：形态闸 → 角色闸 → 拉起成功才写库；拉不起来不写一个连不上的端点', () => {
    const fn = actions.slice(actions.indexOf('export async function actToggleLocalBrowser'));
    orderedBefore(fn, "can('localBrowser')", "requireRole(s, 'byok.manage')");
    orderedBefore(fn, 'ensureLocalBrowser()', 'browserCdpUrl: v.url');
    expect(fn).toContain('if (!r.ok) return { ok: false, error: r.error }');
    // 关：只清库，不动浏览器
    expect(fn).toContain('browserCdpUrl: null');
  });

  it('卡片：一个按钮调 actToggleLocalBrowser，手填端点收进「高级」', () => {
    expect(card).toContain('data-act="toggle-local-browser"');
    expect(card).toContain('actToggleLocalBrowser(next)');
    expect(card).toContain('开启浏览器操作');
    expect(card).toContain('advanced &&');
    // 说清优先级：开着就优先本机，不是「没插件时的退路」
    expect(card).toContain('<b>优先</b>用它当场跑完');
  });
});

describe('🔒 派活按「此刻活着」判，三处口径一致', () => {
  it('localBrowserState 三态 + 唤醒提示常量被工具回执、系统提示两处共用', () => {
    const run = strip(read('lib/browser-task/local-run.ts'));
    expect(run).toContain("{ state: 'off' } | { state: 'ready'; cdpUrl: string } | { state: 'offline'; cdpUrl: string }");
    expect(run).toContain('export const LOCAL_BROWSER_WAKE_HINT');
    for (const f of ['lib/agent/tools.ts', 'lib/agent/context-accounts.ts']) {
      expect(strip(read(f)), `${f} 没用统一的唤醒提示`).toContain('LOCAL_BROWSER_WAKE_HINT');
    }
  });
});
