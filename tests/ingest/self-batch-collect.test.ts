import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 「我的账号 · 一键采集」——与竞对清单的「一键全部采集」同一个形态，只是走自有通道。
//
// 【为什么不能直接复用竞对那套】竞对批量靠 waitForCollect 等「访问即采」的信号，
// 而访问即采**只对已订阅的竞对触发**（common.js 拿竞对清单比对 platform+handle）——
// 自己的主页永远等不到那个信号，照抄过来就是每个账号干等 20 秒超时。
// 所以这里主动向内容脚本要数据，采到就带着 accountId 走自有通道。
//
// 【哪些账号能一键采】必须有一个「打开就能读到自有数据」的地址。认不出入口的账号
// 要**如实标成不可一键采**，而不是白开一个标签页让用户以为在采——那比不做更糟。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

type Tab = { id: number; url: string };

function loadSw(accounts: Record<string, unknown>[], opts: { collect?: unknown } = {}) {
  const noop = () => {};
  const listener = { addListener: noop };
  const opened: Tab[] = [];
  const removed: number[] = [];
  const ingested: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let nextTabId = 100;

  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop, sendMessage: () => Promise.resolve() },
      storage: {
        sync: { get: () => Promise.resolve({ host: 'https://h', token: 't' }), set: () => Promise.resolve() },
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
        onChanged: listener,
      },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      tabs: {
        onRemoved: listener,
        create: ({ url }: { url: string }) => { const t = { id: nextTabId++, url }; opened.push(t); return Promise.resolve(t); },
        remove: (id: number) => { removed.push(id); return Promise.resolve(); },
        sendMessage: (_id: number, m: { type: string }) => {
          if (m.type === 'beacon-collect') {
            return Promise.resolve(opts.collect ?? {
              ok: true,
              payload: { platform: 'x', handle: 'Aiyafun', posts: [{ platformItemId: '1', metrics: { views: 9 } }] },
            });
          }
          return Promise.resolve({ ok: true });
        },
      },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: (_id: string, o: { message: string }) => { notes.push(o.message); } , onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
    fetch: (url: string, init: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/accounts') && method === 'GET') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, accounts }) });
      }
      if (url.endsWith('/api/ingest/self')) {
        ingested.push(JSON.parse(init.body!));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, created: 3, updated: 0, skipped: 0 }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    },
  });
  vm.runInContext(SW_SRC, context);
  return {
    batchCollectSelf: context.batchCollectSelf as (t?: number) => Promise<void>,
    selfCollectUrl: context.selfCollectUrl as (a: unknown) => string | null,
    opened, removed, ingested, notes,
  };
}

const X = { id: 'a-x', name: 'Aiya哎呀', platform: 'x', handle: 'Aiyafun', status: 'active' };
const X_NO_HANDLE = { id: 'a-x2', name: '没填handle', platform: 'x', handle: null, status: 'active' };
const MULTI = { id: 'a-m', name: '我的账号', platform: 'multi', status: 'active' };
const WECHAT = { id: 'a-w', name: '公众号', platform: 'wechat', status: 'active' };

describe('selfCollectUrl · 哪些账号有「打开就能采」的地址', () => {
  it('X 有 handle → 开自己主页', () => {
    expect(loadSw([]).selfCollectUrl(X)).toBe('https://x.com/Aiyafun');
  });

  it('handle 带 @ 也认（用户可能连 @ 一起填）', () => {
    expect(loadSw([]).selfCollectUrl({ ...X, handle: '@Aiyafun' })).toBe('https://x.com/Aiyafun');
  });

  it.each([
    ['X 没填 handle', X_NO_HANDLE],
    ['multi 多平台账号（不对应任何具体平台页面）', MULTI],
    ['创作者后台平台（要换 token + 站内跳转，走另一套流程）', WECHAT],
    ['B站（一个账号对应 N 篇作品，没有一个地址采全部）', { id: 'b', name: 'b', platform: 'bilibili' }],
  ])('%s → 没有一键入口', (_why, acc) => {
    expect(loadSw([]).selfCollectUrl(acc)).toBeNull();
  });
});

describe('batchCollectSelf · 逐个后台开页 → 采 → 回填 → 关页', () => {
  it('只为有入口的账号开标签页，采完立刻关掉', async () => {
    const sw = loadSw([X, MULTI, X_NO_HANDLE]);
    await sw.batchCollectSelf();
    expect(sw.opened.map((t) => t.url)).toEqual(['https://x.com/Aiyafun']); // multi 与没 handle 的不开
    expect(sw.removed).toEqual([sw.opened[0].id]);
  });

  it('🔒 回填时显式带上这个账号的 accountId——页面是为它开的，归属不能再让别处去猜', async () => {
    const sw = loadSw([X]);
    await sw.batchCollectSelf();
    expect(sw.ingested).toHaveLength(1);
    expect(sw.ingested[0].accountId).toBe('a-x');
    expect(sw.ingested[0].platform).toBe('x');
  });

  it('页面一直读不出数据 → 轮询到超时就收尾，标签页必关、通知照发', async () => {
    // collectFromTab 会轮询 25 秒才放弃（页面要渲染、内容脚本要注入）。
    // 假时钟：验的是「超时后一定收尾」，不是真的等 25 秒。
    // 必须在 loadSw 之前开——vm 上下文拿到的是**建上下文那一刻**的 setTimeout / Date。
    vi.useFakeTimers();
    try {
      const sw = loadSw([X], { collect: { ok: false, error: '没解析出来' } });
      const running = sw.batchCollectSelf();
      await vi.advanceTimersByTimeAsync(30000);
      await running;
      expect(sw.ingested).toHaveLength(0);
      expect(sw.removed).toHaveLength(1); // 不留下打开的标签页
      expect(sw.notes.join()).toContain('回填 0 条');
    } finally {
      vi.useRealTimers();
    }
  });

  it('一个可采账号都没有 → 说清楚为什么，而不是假装采过', async () => {
    const sw = loadSw([MULTI, X_NO_HANDLE]);
    await sw.batchCollectSelf();
    expect(sw.opened).toHaveLength(0);
    expect(sw.notes.join()).toContain('没有可一键采集的账号');
  });

  it('有公众号账号 → 通知里说明后台回填也启动了', async () => {
    const sw = loadSw([X, WECHAT]);
    await sw.batchCollectSelf();
    expect(sw.notes.join()).toContain('公众号');
  });
});

// ── 两个界面上都要有这块 ──
const SURFACES: [string, string, string, string, string][] = [
  ['SidePanel', 'extension/sidepanel.js', 'extension/sidepanel.html', 'spBatchSelf', 'spSelfList'],
  ['popup', 'extension/popup.js', 'extension/popup.html', 'batchself', 'selflist'],
];

describe.each(SURFACES)('%s · 我的账号清单', (_name, jsPath, htmlPath, btnId, listId) => {
  function mount() {
    const dom = new JSDOM(readFileSync(resolve(process.cwd(), htmlPath), 'utf8'), {
      url: 'chrome-extension://test/panel.html',
    });
    const sent: { type: string }[] = [];
    const chrome = {
      runtime: {
        sendMessage: (msg: { type: string }) => {
          sent.push(msg);
          if (msg.type === 'beacon-get-config') return Promise.resolve({ host: 'https://h' });
          if (msg.type === 'beacon-get-competitors') return Promise.resolve({ ok: true, competitors: [] });
          if (msg.type === 'beacon-get-accounts') return Promise.resolve({ ok: true, accounts: [X, MULTI] });
          return Promise.resolve({ ok: true });
        },
        openOptionsPage: () => {},
        onMessage: { addListener: () => {} },
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1, url: 'https://x.com/Aiyafun', title: 't' }]),
        sendMessage: () => Promise.resolve({ ok: false }),
        create: () => {},
        onActivated: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
      storage: { sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, local: { get: () => Promise.resolve({}) } },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      sidePanel: { open: () => Promise.resolve() },
    };
    const context = vm.createContext({
      document: dom.window.document, window: dom.window, navigator: dom.window.navigator,
      chrome, console, setTimeout, Date,
    });
    vm.runInContext(readFileSync(resolve(process.cwd(), jsPath), 'utf8'), context);
    const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
    return { dom, sent, settle, doc: dom.window.document };
  }

  it('列出账号，并标明每个能不能一键采', async () => {
    const p = mount();
    await p.settle();
    const text = p.doc.getElementById(listId)!.textContent ?? '';
    expect(text).toContain('Aiya哎呀');
    expect(text).toContain('可一键采集');
    expect(text).toContain('我的账号');
    expect(text).toContain('请在具体作品页回填'); // multi 如实标成不可一键采
  });

  it('点按钮发起批量自有采集（与竞对的批量是两条不同的消息）', async () => {
    const p = mount();
    await p.settle();
    p.doc.getElementById(btnId)!.dispatchEvent(new p.dom.window.Event('click'));
    await p.settle();
    expect(p.sent.some((m) => m.type === 'batch-collect-self')).toBe(true);
    expect(p.sent.some((m) => m.type === 'batch-collect')).toBe(false);
  });
});
