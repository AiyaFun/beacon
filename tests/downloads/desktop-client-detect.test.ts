import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectDesktopClient, CLIENT_STORE_KEY } from '@/lib/desktop-client';
import { compareVersion } from '@/lib/version';

// 「网页跑在桌面客户端里吗」的识别（2026-08-28）。
//
// 起因是用户的两句话：「已经下载了客户端，就不要显示这个下载桌面客户端的了」
// 和「有客户端更新的时候，可以提醒更新」——同一个侧栏槽位的三种状态。
//
// 这里既验行为（三路识别各自成立），也源码级钉死几件**错了就静默失效**的事：
// 版本号写在三个文件里，漏改一处 = 用户被永久提醒「有新版」。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// node 环境里没有 window，手搓一个够用的替身：比拉 jsdom 轻，也更清楚测的是什么
function fakeWindow(href: string, store: Record<string, string> = {}, tauri = false) {
  let current = href;
  const w: Record<string, unknown> = {
    location: { get href() { return current; } },
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
    },
    history: { replaceState: (_a: unknown, _b: unknown, url: string) => { current = url; } },
  };
  if (tauri) w.__TAURI_INTERNALS__ = {};
  (globalThis as { window?: unknown }).window = w;
  return { store, url: () => current };
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('桌面客户端识别', () => {
  it('① 壳带来的标记：认出版本、存起来、并把参数从地址栏抹掉', () => {
    const env = fakeWindow('https://beacon.iyunci.cn/today?_client=desktop&_cv=1.2.1');
    expect(detectDesktopClient()).toEqual({ version: '1.2.1' });
    expect(JSON.parse(env.store[CLIENT_STORE_KEY])).toEqual({ version: '1.2.1' });
    // 参数是一次性握手，留在地址栏会被复制分享出去
    expect(env.url()).not.toContain('_client');
    expect(env.url()).not.toContain('_cv');
    expect(env.url()).toContain('/today');
  });

  it('② 认过一次就记住（之后地址栏没有标记也算数）', () => {
    fakeWindow('https://beacon.iyunci.cn/today', { [CLIENT_STORE_KEY]: '{"version":"1.2.1"}' });
    expect(detectDesktopClient()).toEqual({ version: '1.2.1' });
  });

  it('③ 旧客户端兜底：认得出人、认不出版本', () => {
    fakeWindow('https://beacon.iyunci.cn/today', {}, true);
    expect(detectDesktopClient()).toEqual({ version: null });
  });

  it('普通浏览器返回 null（不能把浏览器当成客户端，否则下载入口整个消失）', () => {
    fakeWindow('https://beacon.iyunci.cn/today');
    expect(detectDesktopClient()).toBeNull();
  });

  it('伪造的版本号不当真', () => {
    fakeWindow('https://beacon.iyunci.cn/?_client=desktop&_cv=not-a-version');
    expect(detectDesktopClient()).toEqual({ version: null });
  });
});

describe('版本号三处必须一致', () => {
  // 壳里的 CLIENT_VERSION 是硬编码的（静态 HTML 拿不到 Cargo/Tauri 的版本）。
  // 它一旦落后于打包版本，用户装了最新版仍会被永久提醒「有新版」——不报错、不变红，
  // 只是天天弹一次假通知。所以钉死。
  it('index.html 的 CLIENT_VERSION == tauri.conf.json == desktop/package.json', () => {
    const shell = read('desktop/ui/index.html').match(/const CLIENT_VERSION = '([^']+)'/)?.[1];
    const tauri = JSON.parse(read('desktop/src-tauri/tauri.conf.json')).version;
    const pkg = JSON.parse(read('desktop/package.json')).version;
    expect(shell, 'index.html 里找不到 CLIENT_VERSION').toBeTruthy();
    expect(shell).toBe(tauri);
    expect(shell).toBe(pkg);
  });

  it('壳跳转时必须带上标记（不带的话站点永远认不出客户端）', () => {
    const shell = read('desktop/ui/index.html');
    expect(shell).toContain('_client=desktop');
    expect(shell).toContain('_cv=');
  });
});

describe('侧栏卡在客户端里的行为', () => {
  const card = read('components/DesktopDownloadCard.tsx');

  it('在客户端里绝不再劝下载', () => {
    // 取 `if (client) {` 到该分支结束这一段，断言里面没有下载文案
    const i = card.indexOf('if (client) {');
    expect(i).toBeGreaterThan(-1);
    const branch = card.slice(i, card.indexOf('if (!show) return null;'));
    expect(branch).not.toContain('下载桌面客户端');
    expect(branch).toContain('有新版');
  });

  it('版本未知按「落后」处理（否则现存客户端永远收不到更新提醒）', () => {
    expect(card).toContain("client.version === null || compareVersion(client.version, version) < 0");
  });

  it('客户端组件不许 import 带 node:fs 的 lib/downloads', () => {
    expect(card).not.toMatch(/from '@\/lib\/downloads'/);
    // 只看 import 行——这两个文件的注释里就写着「node:fs」，全文匹配会被自己的注释绊倒
    const imports = (p: string) => read(p).split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    expect(imports('lib/desktop-client.ts')).not.toContain('node:fs');
    expect(imports('lib/version.ts')).not.toContain('node:fs');
  });
});

describe('compareVersion 搬家后仍然可用', () => {
  it('两处导出同一个实现', async () => {
    const fromDownloads = (await import('@/lib/downloads')).compareVersion;
    expect(fromDownloads).toBe(compareVersion);
  });
  it('比较正确', () => {
    expect(compareVersion('1.2.0', '1.2.1')).toBe(-1);
    expect(compareVersion('1.2.1', '1.2.1')).toBe(0);
    expect(compareVersion('1.10.0', '1.9.0')).toBe(1);
  });
});
