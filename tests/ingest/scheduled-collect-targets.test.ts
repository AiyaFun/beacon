import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 每日定时采集挑目标的口径。
//
// 【被守的是什么】`runScheduledCollect` 原先自己挑了一遍目标：`c.collectable && c.url`。
// 当时公众号是「可采却没有公开主页」（url 恒为 null，走用户自己后台的接口），于是只订阅公众号的
// 用户 targets 恒为 0，整个 batchCollect 一次都不跑：开关开着、时间点也设了，采集永远不发生，
// 而且没有任何报错。（公众号那条通道已于 2026-09-03 整条移除，服务端也不再把它标成 collectable；
// 但**存在第二份判据**这个根本问题与平台无关，所以这份用例继续守着。）
//
// 守两件事：
//   ① 谁该采由 batchCollect 一处说了算，上游不许再挑一遍；
//   ② 报数用 batchCollect 交回来的数，不许在别处再数一遍（原来的分子含手动采的、
//      分母又是另一套条件，能报出 3/2 这种比）。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');
const POPUP_SRC = readFileSync(resolve(process.cwd(), 'extension/popup.js'), 'utf8');

type Store = Record<string, unknown>;
type Competitor = { platform: string; handle: string; name: string; collectable: boolean; url: string | null; lastCrawledAt?: string | null };

function pick(store: Store, keys: unknown): Store {
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    const out: Store = {};
    for (const k of keys) out[String(k)] = store[String(k)];
    return out;
  }
  return { ...store };
}

function loadSw(opts: { competitors: Competitor[] }) {
  const noop = () => {};
  const listener = { addListener: noop };
  const local: Store = {};
  const opened: string[] = [];
  const notified: { message?: string }[] = [];
  let context: vm.Context;

  // 有公开主页的平台走「开标签页 → 等内容脚本报『采到了』」，等不到就干等 20 秒。
  // 离线跑用例时那个信号永远不会来，所以这里替内容脚本把 waiter 摁掉。
  // collectWaiters 是 sw.js 顶层的 const —— 它不在 globalThis 上，只能再进一次上下文求值。
  const fireCollect = (platform: string, handle: string) => {
    try {
      vm.runInContext(`collectWaiters.get(${JSON.stringify(`${platform}:${handle}`)})?.()`, context);
    } catch { /* 还没注册就算了，下一跳再说 */ }
  };

  context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop, sendMessage: () => Promise.resolve() },
      storage: {
        // 定时采集默认开启（scheduledCollect !== false）
        sync: { get: () => Promise.resolve({ host: 'https://h', token: 't' }), set: () => Promise.resolve() },
        local: {
          get: (k: unknown) => Promise.resolve(pick(local, k)),
          set: (o: Store) => { Object.assign(local, o); return Promise.resolve(); },
          remove: (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) delete local[String(key)];
            return Promise.resolve();
          },
        },
        onChanged: listener,
      },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      scripting: { executeScript: () => Promise.resolve() },
      tabs: {
        onRemoved: listener,
        query: () => Promise.resolve([{ id: 7, url: 'https://space.bilibili.com/1' }]),
        create: ({ url }: { url: string }) => {
          opened.push(url);
          // waitForCollect 在 create 之后才注册 waiter，所以隔一跳再触发
          const hit = opts.competitors.find((c) => c.url === url);
          if (hit) setTimeout(() => fireCollect(hit.platform, hit.handle), 5);
          return Promise.resolve({ id: 8, url });
        },
        remove: () => Promise.resolve(),
        sendMessage: () => Promise.resolve({ ok: true }),
      },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: {
        create: (_id: string, o: { message?: string }) => { notified.push(o); },
        onClicked: listener,
      },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
    fetch: (url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes('/competitor/list')
              ? { ok: true, competitors: opts.competitors, workspace: 'w' }
              : { ok: true, competitor: '央视新闻' },
          ),
      }),
  });
  vm.runInContext(SW_SRC, context);
  return {
    runScheduledCollect: context.runScheduledCollect as () => Promise<void>,
    batchCollect: context.batchCollect as (t: number | null) => Promise<{ total: number; collected: number; notes: string[] } | { busy: true }>,
    local, opened, notified,
  };
}

// 公众号：插件采不到（2026-09-03 起服务端也不再把它标成 collectable），但订阅项仍在清单里。
const WECHAT: Competitor = { platform: 'wechat', handle: '央视新闻', name: '央视新闻', collectable: false, url: null, lastCrawledAt: null };
const BILI: Competitor = { platform: 'bilibili', handle: 'uid1', name: '某站号', collectable: true, url: 'https://space.bilibili.com/1', lastCrawledAt: null };

const summaryOf = (local: Store) => String((local.lastScheduledCollectLog as { summary?: string })?.summary ?? '');

describe('每日定时采集 · 挑目标只看 collectable', () => {
  it('🔒 采不了的订阅项不进分母（公众号：插件已不再进它的后台）', async () => {
    const sw = loadSw({ competitors: [WECHAT] });
    await sw.runScheduledCollect();
    const log = sw.local.lastScheduledCollectLog as { totalCompetitors: number; collectedCompetitors: number };
    expect(log.totalCompetitors).toBe(0);
    expect(log.collectedCompetitors).toBe(0);
    // 采不了就一个标签页都不开——绝不为它开一个「公众号后台」
    expect(sw.opened).toEqual([]);
  });

  it('混着订阅时只算能采的那些', async () => {
    const sw = loadSw({ competitors: [WECHAT, BILI] });
    await sw.runScheduledCollect();
    const log = sw.local.lastScheduledCollectLog as { totalCompetitors: number };
    expect(log.totalCompetitors).toBe(1);
    expect(sw.opened).toEqual([BILI.url]); // 只为有主页的那个开页
  });

  it('🔒 报数用 batchCollect 交回来的，不在别处再数一遍', async () => {
    const sw = loadSw({ competitors: [WECHAT, BILI] });
    const r = (await sw.batchCollect(null)) as { total: number; collected: number };
    expect(r.total).toBe(1);
    // 分子绝不会超过分母（原来的写法数的是「今天被采过的竞对」，含手动采的，能报出 3/2）
    expect(r.collected).toBeLessThanOrEqual(r.total);
  });

  it('一个都没订阅时不炸，也照常留下一条记录', async () => {
    const sw = loadSw({ competitors: [] });
    await sw.runScheduledCollect();
    expect(summaryOf(sw.local)).toContain('0/0');
  });
});

describe('🔒 可采性判据只有一份', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('sw.js 里没有任何 `collectable && … url` 的挑目标写法', () => {
    const src = strip(SW_SRC);
    // 可采性只看 collectable；要不要开标签页是另一回事（batchCollect 内部按 c.url 分）。
    expect(src).not.toMatch(/collectable\s*&&\s*c?\.?url/);
    expect(src).not.toMatch(/collectable\s*&&\s*[^\n;]*\.url\b/);
  });

  it('popup 的列表过滤与「待刷新 N」用同一个判据（否则数目对不上）', () => {
    const src = strip(POPUP_SRC);
    // 早先的补丁把平台名写死进了过滤条件，下一个没有主页的平台会原样再消失一次
    expect(src).not.toMatch(/c\.url\s*\|\|\s*c\.platform\s*===\s*'wechat'/);
    expect(src).toMatch(/allCompetitors\.filter\(\s*\n?\s*\(c\)\s*=>\s*c\.collectable\s*&&/);
  });
});
