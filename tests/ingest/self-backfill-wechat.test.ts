import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 公众号后台 · 自有数据回填 = **官方发行版专有的可选模块**（用户 2026-09-04 拍板：cnb 保留，
// GitHub 不发）。本文件守的是那条「可选」是真的可选：
//
//   ① 没有模块（开源发行版）时，插件里那条通道**不存在**——不是留一个关着的开关，
//      而是 selfAutoPlatforms() 为空、runSelfAuto 如实拒绝、闹钟被清掉、设置页那块不显示；
//   ② 有模块时，入口、按需授权、注入顺序三件事都对；
//   ③ 发布脚本真的把这两个文件剥掉，并且有一道「公开树里不许再有访问公众号后台的代码」的闸。
//
// ⚠️ 本文件自己也在剥离清单里（它 import 的东西开源版没有）。
//
// 被删掉的那条（拿你的登录态去搜**别人**的公众号）不在这里，也不该回来：
// 判据永远是「读的是不是**他自己的**数据」。

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const SW_SRC = read('extension/sw.js');
const MODULE_SRC = read('extension/sw-self-backends.js');

type Tab = { id: number; url: string };

/** 把 sw.js 跑起来。withModule=false 模拟开源发行版：importScripts 抛错（文件不存在）。 */
function loadSw(opts: { withModule: boolean; granted?: boolean; token?: string }) {
  const noop = () => {};
  const listener = { addListener: noop };
  const opened: Tab[] = [];
  const injected: { tabId: number; files: string[] }[] = [];
  const alarmsCreated: string[] = [];
  const alarmsCleared: string[] = [];
  const notes: string[] = [];
  let nextTabId = 100;

  const context: vm.Context = vm.createContext({
    // 缺文件时浏览器抛 NetworkError；这里如实模拟「加载失败」而不是静默返回
    importScripts: (f: string) => {
      // 只模拟「可选模块这一个文件不存在」；sw.js 还会 importScripts 别的东西，那些照跑
      if (f === 'sw-self-backends.js') {
        if (!opts.withModule) throw new Error(`Failed to load script: ${f}`);
        vm.runInContext(MODULE_SRC, context);
        return;
      }
      vm.runInContext(readFileSync(resolve(ROOT, 'extension', f), 'utf8'), context);
    },
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop, sendMessage: () => Promise.resolve() },
      storage: {
        sync: {
          get: () => Promise.resolve({ host: 'https://h', token: opts.token ?? 't', selfAutoCollect: true, selfAutoHour: 9 }),
          set: () => Promise.resolve(),
        },
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
        onChanged: listener,
      },
      permissions: { contains: () => Promise.resolve(opts.granted === true) },
      alarms: {
        onAlarm: listener,
        create: (name: string) => { alarmsCreated.push(name); },
        get: noop,
        clear: (name: string) => { alarmsCleared.push(name); return Promise.resolve(); },
      },
      tabs: {
        onRemoved: listener,
        onUpdated: listener,
        create: ({ url }: { url: string }) => { const t = { id: nextTabId++, url }; opened.push(t); return Promise.resolve(t); },
        remove: () => Promise.resolve(),
        sendMessage: () => Promise.resolve({ ok: true }),
      },
      scripting: {
        executeScript: ({ target, files }: { target: { tabId: number }; files: string[] }) => {
          injected.push({ tabId: target.tabId, files });
          return Promise.resolve([]);
        },
      },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: (_id: string, o: { message: string }) => { notes.push(o.message); }, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  vm.runInContext(SW_SRC, context);
  return {
    ctx: context,
    entries: () => (context.__beaconSelfAutoEntries ?? {}) as Record<string, { origin: string; url: string; inject: string[] }>,
    platforms: () => (context.selfAutoPlatforms as () => string[])(),
    runSelfAuto: context.runSelfAuto as (o?: Record<string, unknown>) => Promise<{ ok: boolean; message?: string; needGrant?: boolean }>,
    armSelfAutoAlarm: context.armSelfAutoAlarm as () => Promise<void>,
    injectSelfAuto: context.injectSelfAuto as (id: number, e: unknown) => Promise<boolean>,
    opened, injected, alarmsCreated, alarmsCleared, notes,
  };
}

describe('可选模块缺席时（= 开源发行版）：这条通道不存在，不是关着', () => {
  it('注册表为空，可自动回填的平台一个都没有', () => {
    const sw = loadSw({ withModule: false });
    expect(sw.entries()).toEqual({});
    expect(sw.platforms()).toEqual([]);
  });

  it('缺文件不该让整个 service worker 崩掉（importScripts 抛错要被咽掉）', () => {
    loadSw({ withModule: false }); // 真的跑一遍：抛出来的话这一句就炸了
    // 上一条能跑起来本身就证明了；这里再钉一次「咽掉」的写法，别哪天改成裸调用
    expect(SW_SRC).toMatch(/try \{ importScripts\('sw-self-backends\.js'\); \} catch/);
  });

  it('用户就算把开关打开，也如实说「没有可回填的后台」，而不是开个标签页装样子', async () => {
    const sw = loadSw({ withModule: false, granted: true });
    const r = await sw.runSelfAuto({ force: true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('没有可自动回填');
    expect(sw.opened, '什么都做不了却开了标签页').toHaveLength(0);
  });

  it('闹钟被清掉——开关开着却挂一个永远什么都不做的定时器，是最难查的那种「坏」', async () => {
    const sw = loadSw({ withModule: false });
    await sw.armSelfAutoAlarm();
    expect(sw.alarmsCleared).toContain('beacon-self-auto');
    expect(sw.alarmsCreated).not.toContain('beacon-self-auto');
  });

  it('设置页按插件自报的 available 决定显不显示那一块（不是写死显示）', () => {
    const optsJs = read('extension/options.js');
    expect(optsJs).toContain("type: 'beacon-self-auto-info'");
    expect(optsJs, '没有 available 就该整块隐藏').toMatch(/if \(!selfAutoInfo\?\.available\) \{ block\.style\.display = 'none'; return; \}/);
  });
});

describe('可选模块在位时：入口、授权、注入顺序', () => {
  it('注册的是公众号后台的裸入口地址（带参数会被 302 丢掉）', () => {
    const sw = loadSw({ withModule: true });
    expect(sw.platforms()).toEqual(['wechat']);
    const e = sw.entries().wechat;
    expect(e.origin).toBe('https://mp.weixin.qq.com');
    expect(e.url).toBe('https://mp.weixin.qq.com/cgi-bin/home');
    expect(e.url, '入口不许自己拼查询参数——重定向会把它丢掉').not.toContain('?');
  });

  it('🔒 没授权就一个标签页都不开，并指路去点授权（绝不在这儿偷偷申请）', async () => {
    const sw = loadSw({ withModule: true, granted: false });
    const r = await sw.runSelfAuto({ force: true });
    expect(r.ok).toBe(false);
    expect(r.needGrant).toBe(true);
    expect(r.message).toContain('授权');
    expect(sw.opened, '没授权却开了后台页').toHaveLength(0);
    // 注释里提到它是可以的（那儿正解释了为什么不在这儿调）；这里查的是**代码**
    const code = SW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code, 'SW 里不许调 permissions.request（它必须在用户手势里调）')
      .not.toMatch(/chrome\.permissions\.request/);
  });

  it('授权之后才开后台页，且开在后台（active:false）', async () => {
    const sw = loadSw({ withModule: true, granted: true });
    const r = await sw.runSelfAuto({ force: true });
    expect(r.ok).toBe(true);
    expect(sw.opened.map((t) => t.url)).toEqual(['https://mp.weixin.qq.com/cgi-bin/home']);
    expect(SW_SRC).toMatch(/chrome\.tabs\.create\(\{ url: entry\.url, active: false \}\)/);
  });

  it('🔒 注入顺序：站点模块必须排在 self-backend.js 之前（它要先把配置放进 __beaconBackendExtras）', async () => {
    const sw = loadSw({ withModule: true, granted: true });
    const files = sw.entries().wechat.inject;
    expect(files).toContain('content/self-backend-wechat.js');
    expect(files.indexOf('content/self-backend-wechat.js'))
      .toBeLessThan(files.indexOf('content/self-backend.js'));
    // 真的按这份清单注入
    await sw.injectSelfAuto(7, sw.entries().wechat);
    expect(sw.injected).toEqual([{ tabId: 7, files }]);
  });

  it('没填采集令牌时不开页，如实通知（开了也没处回传）', async () => {
    const sw = loadSw({ withModule: true, granted: true, token: '' });
    const r = await sw.runSelfAuto({ force: true });
    expect(r.ok).toBe(false);
    expect(sw.opened).toHaveLength(0);
    expect(sw.notes.join()).toContain('采集令牌');
  });
});

describe('站点配置：只读自己的数据，且能被 self-backend.js 认出来', () => {
  const SITE = read('extension/content/self-backend-wechat.js');

  it('注册进 __beaconBackendExtras，且 self-backend.js 真的合并它', () => {
    expect(SITE).toContain("globalThis.__beaconBackendExtras['mp.weixin.qq.com']");
    expect(read('extension/content/self-backend.js'))
      .toMatch(/\.\.\.\(globalThis\.__beaconBackendExtras \|\| \{\}\)/);
  });

  it('抠行 ID 走的是通用钩子 rowIdOf，不是在 self-backend.js 里写平台分支', () => {
    expect(SITE).toMatch(/rowIdOf: beaconWechatRowId/);
    expect(read('extension/content/self-backend.js'))
      .toMatch(/if \(typeof cfg\.rowIdOf === 'function'\) return cfg\.rowIdOf\(row, cfg\)/);
  });

  it('🔒 只走后台页面导航，一个平台接口都不调（被删掉的那条正是「调接口」）', () => {
    expect(SITE, '又出现了 searchbiz —— 那是查别人的号，已经删掉且不许回来').not.toContain('searchbiz');
    expect(SITE, '站点配置里不该有 fetch/XHR：这条通道只读已经渲染出来的页面').not.toMatch(/\bfetch\s*\(|XMLHttpRequest/);
  });
});

describe('🔒 发布到 GitHub 时真的被剥掉', () => {
  const PUB = read('scripts/publish-github.sh');

  it('两个模块文件与本测试都在剥离清单里', () => {
    for (const f of [
      'extension/sw-self-backends.js',
      'extension/content/self-backend-wechat.js',
      'tests/ingest/self-backfill-wechat.test.ts',
    ]) {
      expect(PUB, `剥离清单里缺 ${f}`).toContain(f);
      expect(existsSync(resolve(ROOT, f)), `${f} 不存在，剥离清单会剥了个寂寞`).toBe(true);
    }
  });

  it('剥完还有一道「公开树里不许再有通往公众号后台的路」的闸', () => {
    // 盯的是**通路**不是域名字样：域名会出现在政策、README、界面举例与注释里，
    // 禁掉那些只会逼人把解释删掉（这条判据本身 2026-09-04 就这么翻过一次车）。
    expect(PUB, '没查「有没有代码还引用被剥掉的站点模块」').toMatch(/grep -rn "self-backend-wechat"/);
    expect(PUB, '闸门没生效时必须中止发布，不能只打印一句').toMatch(/\[ -z "\$DANGLING" \] \|\| die/);
    expect(PUB, '没查 manifest 里有没有混进那个域名').toMatch(/grep -q "mp\\\.weixin\\\.qq\\\.com" "\$WT\/extension\/manifest\.json"/);
  });
});
