// 服务端自己把本机 Chrome 带调试端口拉起来（2026-09-03）。
//
// 【为什么服务端能做这件事】整机版/桌面端的服务就是一个裸 Node 进程跑在用户自己的电脑上
// （deploy/appliance/install.sh 装的就是 node + 3070 端口，不是 Docker）。所以「拉起 Chrome」
// 不必绕到 Tauri 托盘再让用户回设置页手填端点——设置页一个开关就够了。
// 用户的原话：「需要类似 claude code 一样获得 Computer use 和 Browser use 的权限设置」。
// Claude Code 那个模型是：一个开关，点了就能用；这里对齐那个体验。
//
// 【与 desktop/src-tauri/src/main.rs 的 launch_collect_browser 是同一套规矩】
//   ① 先探端口：通了就什么都不做（已经照做过一次的用户不能再被要求退出浏览器）
//   ② 端口不通 + Chrome 在跑 → **不替他杀浏览器**，如实说要先完全退出（Chrome 的硬限制：
//      同一个 profile 只跑一个进程，运行中的实例开不了调试端口）
//   ③ 端口不通 + 没在跑 → 用他的默认 profile 带端口起（登录态全在，装完就能用）
// 托盘那份是给「服务不在本机」的接法留的；两份都在，规矩必须一致，tests/browser/launch.test.ts 钉着。
//
// 【边界】只探 127.0.0.1；只 spawn，不 kill；SaaS 走不到这里（调用方按 editionCan('localBrowser') 拦）。
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { vetCdpUrl } from './local';

const execFileP = promisify(execFile);

export const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

/** 各平台 Chrome 的常见安装位置。找不到就如实报「没装 Chrome」，不去猜别的浏览器。 */
export function chromeCandidates(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${env.HOME ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ];
  }
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.map((r) => `${r}\\Google\\Chrome\\Application\\chrome.exe`);
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

export function findChrome(): string | null {
  for (const p of chromeCandidates()) {
    try { if (fs.existsSync(p)) return p; } catch { /* 读不到就当没有 */ }
  }
  return null;
}

/** 调试端点活着没：能连上 ≠ 是浏览器，必须看它答的是不是 CDP 握手。 */
export async function cdpLive(url: string, timeoutMs = 800): Promise<{ live: boolean; browser?: string }> {
  const v = vetCdpUrl(url);
  if (!v.ok || !v.url) return { live: false };
  try {
    const res = await fetch(`${v.url}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { live: false };
    const j = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    return j?.webSocketDebuggerUrl ? { live: true, browser: j.Browser } : { live: false };
  } catch {
    return { live: false };
  }
}

/** Chrome 在不在跑。只判断，不动它；判不出来按「没在跑」——判错只是多一句提示，误杀浏览器不可接受。 */
export async function chromeRunning(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileP('/usr/bin/pgrep', ['-x', 'Google Chrome']);
      return stdout.trim().length > 0;
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH']);
      return /chrome\.exe/i.test(stdout);
    }
    const { stdout } = await execFileP('pgrep', ['-x', 'chrome']);
    return stdout.trim().length > 0;
  } catch {
    return false; // pgrep 没匹配到会以非零退出：等于「没在跑」
  }
}

export type EnsureResult =
  | { ok: true; url: string; started: boolean; browser?: string }
  | { ok: false; error: string; reason: 'no_chrome' | 'running_without_port' | 'spawn_failed' | 'not_up' };

/**
 * 保证本机有一个带调试端口的 Chrome：已经有就直接用；没有就用默认 profile 起一个。
 * 起完轮询握手端点最多 ~8 秒——起来之前就回「已开启」会让用户第一次派活就撞「连不上」。
 */
export async function ensureLocalBrowser(opts: { url?: string; waitMs?: number } = {}): Promise<EnsureResult> {
  const url = opts.url ?? DEFAULT_CDP_URL;
  const before = await cdpLive(url);
  if (before.live) return { ok: true, url, started: false, browser: before.browser };

  const chrome = findChrome();
  if (!chrome) return { ok: false, reason: 'no_chrome', error: '这台电脑上没找到 Google Chrome。先装上 Chrome 再开这个开关。' };

  if (await chromeRunning()) {
    return {
      ok: false,
      reason: 'running_without_port',
      error: 'Chrome 正开着，但它没开调试端口，运行中的 Chrome 没法再打开（这是 Chrome 的限制）。'
        + '请先完全退出 Chrome（macOS 按 ⌘Q，不是关窗口），再点一次「开启」——重开后标签页和登录态都还在。'
        + '我们不会替你关掉它。',
    };
  }

  try {
    // 不传 --user-data-dir：用他的默认 profile，登录态全在。detached + unref：服务重启不带走浏览器。
    const child = spawn(chrome, ['--remote-debugging-port=9222', '--no-default-browser-check'], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    return { ok: false, reason: 'spawn_failed', error: `启动不了 Chrome：${e instanceof Error ? e.message : String(e)}` };
  }

  const deadline = Date.now() + (opts.waitMs ?? 8000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const now = await cdpLive(url);
    if (now.live) return { ok: true, url, started: true, browser: now.browser };
  }
  return { ok: false, reason: 'not_up', error: 'Chrome 起了，但调试端口一直没通。再点一次「开启」试试；还不行就用客户端托盘的「启动采集浏览器」。' };
}
