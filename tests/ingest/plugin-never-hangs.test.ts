import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 「按钮永远停在『回填中…』」——真机 2026-07-27 在 X 上撞到的故障形态：
// 不报错、不复原、没有任何线索，用户只能刷新页面。
//
// 它不是一个 bug，是**三处都缺一道兜底**，任何一处发作都长这个样：
//   ① sw.js 的 fetch **没有超时** → promise 永不 settle → sendResponse 永不发；
//   ② `handler().then(sendResponse)` **没有 catch** → 处理函数一抛错，sendResponse 就永不发；
//   ③ 三个界面 `await chrome.runtime.sendMessage(...)` **没有 catch** → 上面两条任一发生
//      （或插件刚被重新加载，页面上还是旧的内容脚本）时 await 转 reject，
//      直接跳过后面的 restore()，按钮再也回不来。
//
// 这个文件锁的是同一条底线：**无论后台发生什么，界面都必须回到可点状态，并说出原因。**

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');
const SIDEBAR_SRC = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.js'), 'utf8');

function loadSw(fetchImpl: unknown) {
  const noop = () => {};
  const listener = { addListener: noop };
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
      storage: {
        sync: { get: () => Promise.resolve({ host: 'https://beacon.iyunci.cn', token: 't' }), set: () => Promise.resolve() },
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
        onChanged: listener,
      },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      tabs: { onRemoved: listener, onUpdated: listener, create: noop, remove: noop, sendMessage: noop },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: noop, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
    fetch: fetchImpl,
  });
  vm.runInContext(SW_SRC, context);
  return context as unknown as {
    ingestSelf: (p: unknown) => Promise<{ ok: boolean; error?: string }>;
    fetchWithTimeout: (u: string, i?: unknown, ms?: number) => Promise<unknown>;
    respond: (p: unknown, send: (r: unknown) => void, what: string) => void;
  };
}

describe('🔒 sw.js · 网络吊住时必须超时，而不是永远等下去', () => {
  it('fetch 一直不返回 → fetchWithTimeout 主动中止', async () => {
    // 永不 settle 的 fetch，只听 abort —— 正是「一直显示回填中」的现场
    const hanging = (_u: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          rej(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
        });
      });
    const sw = loadSw(hanging);
    await expect(sw.fetchWithTimeout('https://h/x', {}, 20)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('超时后 ingestSelf 返回可读的失败，而不是挂着', async () => {
    const aborted = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const sw = loadSw(aborted);
    const r = await sw.ingestSelf({ platform: 'x', posts: [{ platformItemId: '1' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
    // 挂 VPN 看 X、而烽火台在国内，是这个超时最常见的成因——错误里要直接说怎么办
    expect(r.error).toContain('VPN');
    expect(r.error).toContain('白名单');
  });

  it('连不上（非超时）仍按老口径报，不与超时混为一谈', async () => {
    const sw = loadSw(() => Promise.reject(new TypeError('Failed to fetch')));
    const r = await sw.ingestSelf({ platform: 'x', posts: [{ platformItemId: '1' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无法连接服务器');
    expect(r.error).not.toContain('超时');
  });
});

describe('🔒 sw.js · 处理函数抛错也必须回话', () => {
  it('respond 接住异常 → sendResponse 照发（否则消息通道关闭，调用方 await 转 reject）', async () => {
    const sw = loadSw(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    let got: { ok: boolean; error?: string } | undefined;
    sw.respond(Promise.reject(new Error('boom')), (r) => { got = r as typeof got; }, '回填');
    await new Promise((r) => setTimeout(r, 0));
    expect(got?.ok).toBe(false);
    expect(got?.error).toContain('回填');
    expect(got?.error).toContain('boom');
  });

  it('每一处 .then(sendResponse) 都配了 catch（不许再出现裸链）', () => {
    expect(SW_SRC).not.toMatch(/\)\.then\(sendResponse\)/);
  });
});

describe('🔒 页内侧栏 · 后台不回话时按钮必须复原', () => {
  function mount(sendMessageImpl: (msg: { type: string }) => Promise<unknown>) {
    const dom = new JSDOM('<html><body></body></html>', { url: 'https://x.com/Aiyafun' });
    const chrome = {
      runtime: {
        getURL: (p: string) => `chrome-extension://test/${p}`,
        sendMessage: (msg: { type: string }, cb?: (r: unknown) => void) => {
          if (cb) { cb({ ok: true }); return undefined; }
          return sendMessageImpl(msg);
        },
        onMessage: { addListener: () => {} },
      },
      storage: {
        sync: { get: (_k: string, cb: (r: unknown) => void) => cb({ showInPageAi: true }) },
        onChanged: { addListener: () => {} },
      },
    };
    const context = vm.createContext({
      document: dom.window.document,
      location: dom.window.location,
      window: dom.window,
      URL: dom.window.URL,
      chrome, console,
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      setTimeout,
      __beaconParse: () => ({
        platform: 'x', handle: 'Aiyafun', isSelf: true,
        posts: [{ platformItemId: '111', title: '推文', metrics: { views: 1 } }],
      }),
    });
    vm.runInContext(SIDEBAR_SRC, context);
    const btn = () => dom.window.document.getElementById('beacon-self-btn') as HTMLButtonElement;
    const click = async () => {
      btn().dispatchEvent(new dom.window.Event('click'));
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const toast = () => dom.window.document.querySelector('.beacon-toast')?.textContent ?? '';
    return { btn, click, toast };
  }

  it('sendMessage reject（插件刚重载 / 后台抛错）→ 不是停在「回填中…」，而是复原并说人话', async () => {
    const p = mount(() => Promise.reject(new Error('Extension context invalidated.')));
    await p.click();
    expect(p.btn().disabled).toBe(false);
    expect(p.btn().textContent).toContain('这是我的作品');
    expect(p.btn().textContent).not.toContain('回填中');
    expect(p.toast()).toContain('刷新');
  });

  it('后台回 ok:false（超时/令牌无效）→ 同样复原，并把原因显示出来', async () => {
    const p = mount(() => Promise.resolve({ ok: false, error: '请求超时（30 秒没有响应）' }));
    await p.click();
    expect(p.btn().disabled).toBe(false);
    expect(p.btn().textContent).not.toContain('回填中');
    expect(p.toast()).toContain('超时');
  });

  it('成功路径照常复原', async () => {
    const p = mount(() => Promise.resolve({ ok: true, summary: '✓ 已回填：2 条作品', summaryOk: true }));
    await p.click();
    expect(p.btn().disabled).toBe(false);
    expect(p.toast()).toContain('已回填');
  });
});
