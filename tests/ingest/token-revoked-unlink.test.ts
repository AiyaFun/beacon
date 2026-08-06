import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 「注销了账号，插件还在采」——2026-07-30 用户真机报的。
//
// 服务端那半边本来就是对的：注销时 Workspace 随 Tenant 级联删除，ingestToken 当场作废，
// 插件之后每一次回传都是 401。坏的是**没人通知插件**：令牌串、工作区名、竞对清单、
// 自有账号清单全都躺在本机 chrome.storage 里（sync 那半边还会同步到用户登录过的每一台 Chrome），
// 定时闹钟照常挂着，于是每天起来开一次后台标签页、撞一次 401、弹一条看不懂的失败通知。
//
// 这份用例钉的是两条防线**都得在**：
//   ① 网页通道（content/bridge.js 的 clear-token → sw.js 的 beacon-unlink）——只覆盖
//      「在这台浏览器上注销」，但快且准；
//   ② 401 自愈——用户在手机上、在另一台电脑上注销时 ① 根本够不着，只有它兜得住。
// 少任何一条，都会留下「已经注销、设备上还留着一份工作区数据」的状态。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');
const BRIDGE_SRC = readFileSync(resolve(process.cwd(), 'extension/content/bridge.js'), 'utf8');

type Store = Record<string, unknown>;
type Msg = { type: string; reason?: string };

/** chrome.storage 的 get 支持 'key' 与 ['k1','k2'] 两种传法，mock 必须两种都认 */
function pick(store: Store, keys: unknown): Store {
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    const out: Store = {};
    for (const k of keys) out[String(k)] = store[String(k)];
    return out;
  }
  return { ...store };
}

/**
 * @param status 单个值 = 每次请求都返回它；数组 = 按顺序返回，用完停在最后一个。
 *   用来复现「偶发 401 之间夹着一次成功」这种真实序列。
 */
function loadSw(status: number | number[]) {
  const queue = Array.isArray(status) ? [...status] : [status];

  // 初始状态 = 一个正常用了一阵子的插件：令牌在、缓存满、两个定时开关都开着
  const sync: Store = {
    host: 'https://beacon.iyunci.cn',
    token: 'bcn_deadbeef',
    selfAccountId: 'acc_1',
    scheduledCollect: true,
    selfAutoCollect: true,
  };
  const local: Store = {
    competitors: [{ platform: 'x', handle: 'someone' }],
    competitorsAt: 1,
    workspace: '我的工作区',
    selfAccounts: [{ id: 'acc_1', name: '我的公众号' }],
    selfAccountsAt: 1,
    lastScheduledCollectLog: { summary: '每日定时采集完成' },
    wechatThrottle: { at: 1 },
  };

  const alarmsCleared: string[] = [];
  const notified: { title?: string; message?: string }[] = [];
  let onMessage: ((m: unknown, s: unknown, r: (x: unknown) => void) => unknown) | null = null;
  const noop = () => {};
  const listener = { addListener: noop };

  const context = vm.createContext({
    chrome: {
      runtime: {
        onInstalled: listener,
        onStartup: listener,
        onMessage: { addListener: (fn: typeof onMessage) => { onMessage = fn; } },
        getPlatformInfo: noop,
        getManifest: () => ({ version: '0.7.2' }),
        id: 'abcdef',
      },
      storage: {
        sync: {
          get: (k: unknown) => Promise.resolve(pick(sync, k)),
          set: (o: Store) => { Object.assign(sync, o); return Promise.resolve(); },
          remove: (k: string | string[]) => {
            for (const key of ([] as string[]).concat(k)) delete sync[key];
            return Promise.resolve();
          },
        },
        local: {
          get: (k: unknown) => Promise.resolve(pick(local, k)),
          set: (o: Store) => { Object.assign(local, o); return Promise.resolve(); },
          remove: (k: string | string[]) => {
            for (const key of ([] as string[]).concat(k)) delete local[key];
            return Promise.resolve();
          },
        },
        onChanged: listener,
      },
      alarms: {
        onAlarm: listener,
        create: noop,
        get: noop,
        clear: (n: string) => { alarmsCleared.push(n); return Promise.resolve(true); },
      },
      tabs: { onRemoved: listener, create: noop, remove: noop, sendMessage: noop },
      action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve() },
      notifications: {
        create: (_id: string, o: { title?: string; message?: string }) => { notified.push(o); },
        onClicked: listener,
      },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
      scripting: { executeScript: noop },
      management: { getSelf: () => Promise.resolve({ installType: 'normal' }) },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
    fetch: () => {
      const s = queue.length > 1 ? queue.shift()! : queue[0];
      return Promise.resolve({
        status: s,
        ok: s >= 200 && s < 300,
        json: () => Promise.resolve(
          s === 401
            ? { ok: false, error: '采集令牌无效或已停用' }
            : { ok: true, competitors: [], workspace: '我的工作区' },
        ),
      });
    },
  });
  vm.runInContext(SW_SRC, context);

  return {
    ctx: context as unknown as { refreshCompetitors: () => Promise<unknown> },
    sync, local, alarmsCleared, notified,
    onMessage: () => onMessage,
  };
}

const CACHE_KEYS = [
  'competitors', 'competitorsAt', 'workspace',
  'selfAccounts', 'selfAccountsAt',
  'lastScheduledCollectLog', 'wechatThrottle',
];

describe('🔒 sw.js · 令牌作废后插件必须自己停手并清干净', () => {
  it('连续 3 次 401 → 清令牌、清全部工作区缓存、停三只闹钟、弹一条说明', async () => {
    const t = loadSw(401);

    await t.ctx.refreshCompetitors();
    await t.ctx.refreshCompetitors();
    // 还没到阈值：401 也可能是用户正在轮换令牌的中间态，两次就清代价太大
    expect(t.sync.token, '第 2 次 401 就清空 = 一次网络抖动就要用户重配整套设置').toBe('bcn_deadbeef');

    await t.ctx.refreshCompetitors();

    expect(t.sync.token).toBeUndefined();
    expect(t.sync.selfAccountId).toBeUndefined();
    for (const k of CACHE_KEYS) {
      expect(t.local[k], `${k} 没被清掉——它会在用户注销之后继续留在设备上`).toBeUndefined();
    }
    expect(t.alarmsCleared).toEqual(
      expect.arrayContaining(['beacon-self-auto', 'beacon-scheduled-collect', 'beacon-daily']),
    );
    // 必须说话：插件突然不采了而用户不知道为什么，比继续报 401 更让人抓瞎
    expect(t.notified).toHaveLength(1);
    expect(t.notified[0]?.message ?? '').toContain('令牌');
  });

  it('🔒 停表不能只清闹钟：scheduledCollect 默认是「开」，不落盘写 false 下次启动就自己挂回来', async () => {
    const t = loadSw(401);
    for (let i = 0; i < 3; i++) await t.ctx.refreshCompetitors();
    expect(t.sync.scheduledCollect).toBe(false);
    expect(t.sync.selfAutoCollect).toBe(false);
  });

  it('中间通过一次就把计数清零——不许靠跨周攒够 3 次偶发 401 来误清', async () => {
    const t = loadSw([401, 401, 200, 401, 401]);
    for (let i = 0; i < 5; i++) await t.ctx.refreshCompetitors();
    expect(t.sync.token).toBe('bcn_deadbeef');
    expect(t.notified).toHaveLength(0);
  });

  it('并发撞 401（批量采集的常态）只弹一条通知，不是三条', async () => {
    const t = loadSw(401);
    await t.ctx.refreshCompetitors();
    await t.ctx.refreshCompetitors(); // authFail = 2，下一批同时越线
    await Promise.all([t.ctx.refreshCompetitors(), t.ctx.refreshCompetitors(), t.ctx.refreshCompetitors()]);
    expect(t.sync.token).toBeUndefined();
    expect(t.notified, '清理是幂等的，通知不是——用户不该一次收到三条一样的').toHaveLength(1);
  });

  it('host 不清：它是服务器地址不是个人数据，清掉只会让重新配置多绕一步', async () => {
    const t = loadSw(401);
    for (let i = 0; i < 3; i++) await t.ctx.refreshCompetitors();
    expect(t.sync.host).toBe('https://beacon.iyunci.cn');
  });

  it('网页通道：一条 beacon-unlink 就完成同一套清理，且原因照原话进通知', async () => {
    const t = loadSw(200);
    const handler = t.onMessage();
    expect(handler, 'sw.js 没注册 onMessage，后面的断言都是假的').toBeTruthy();

    await new Promise((done) => handler!({ type: 'beacon-unlink', reason: '账号已注销，采集令牌随工作区一并作废。' }, {}, done));

    expect(t.sync.token).toBeUndefined();
    for (const k of CACHE_KEYS) expect(t.local[k]).toBeUndefined();
    expect(t.notified[0]?.message ?? '').toContain('账号已注销');
  });
});

describe('🔒 bridge.js · 注销落地页的 clear-token 必须真的转成 beacon-unlink', () => {
  function mountBridge() {
    const dom = new JSDOM('<html><body></body></html>', { url: 'https://beacon.iyunci.cn/login?bye=tenant' });
    const sent: Msg[] = [];
    const context = vm.createContext({
      window: dom.window,
      document: dom.window.document,
      chrome: {
        runtime: {
          sendMessage: (m: Msg) => { sent.push(m); return Promise.resolve({ ok: true }); },
          onMessage: { addListener: () => {} },
        },
        storage: { sync: { set: (_o: Store, cb?: () => void) => cb && cb() } },
      },
      console, setTimeout,
    });
    vm.runInContext(BRIDGE_SRC, context);

    const post = async (data: unknown, source: unknown = dom.window) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source } as never));
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    };
    return { sent, post };
  }

  it('clear-token → beacon-unlink，并把原因带过去', async () => {
    const { sent, post } = mountBridge();
    await post({ __beacon: 'clear-token', reason: '账号已注销' });
    expect(sent).toEqual([{ type: 'beacon-unlink', reason: '账号已注销' }]);
  });

  it('不是本窗口发来的消息一律不理（与既有 config-token 同一道闸）', async () => {
    const { sent, post } = mountBridge();
    await post({ __beacon: 'clear-token', reason: 'x' }, null);
    expect(sent).toHaveLength(0);
  });
});

describe('🔒 登录页必须挂上 ExtUnlink —— 注销的落地页是唯一稳的通知时机', () => {
  // server action 成功即 redirect，在注销按钮的点击处理里 postMessage 必然打空。
  // 这条是接线检查：真正的行为由上面两组用例覆盖。
  const PAGE = readFileSync(resolve(process.cwd(), 'app/login/page.tsx'), 'utf8');

  it('bye 分支里渲染了 ExtUnlink', () => {
    expect(PAGE).toContain("from './ExtUnlink'");
    expect(PAGE).toMatch(/bye\s*\?\s*<ExtUnlink\s+scope=\{bye\}\s*\/>/);
  });
});
