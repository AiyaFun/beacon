import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 「没登录就跳到公众号页面等登录，然后接着执行」——2026-08-18 用户明确要求的行为。
//
// 在这之前，未登录时插件是**当场关掉标签页**报一句「登录态已过期」（用户看到的就是
// 「打开公众号后秒退」）。现在改成：把已经打开的那一页切到前台交给用户，等他自己扫码，
// 登录完成后本轮继续采。三条边界必须同时成立，少一条这个功能就变成骚扰或死等：
//   ① 登录动作全部由用户完成——插件只切前台，不填表单、不点按钮、不碰二维码；
//   ② 等待有硬上限，到点如实收尾；
//   ③ 切到前台的那一页**归用户了**，插件不再自动关闭它。
// 外加一条分寸：定时/后台那轮人多半不在电脑前，不许弹前台页。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

type Store = Record<string, unknown>;
type Msg = { type: string; name?: string; fakeid?: unknown };

function pick(store: Store, keys: unknown): Store {
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    const out: Store = {};
    for (const k of keys) out[String(k)] = store[String(k)];
    return out;
  }
  return { ...store };
}

const NOT_LOGGED_IN = {
  ok: false,
  code: 'no_token',
  needLogin: true,
  error: '公众号后台未登录（当前停在登录页）',
};
const COLLECTED = {
  ok: true,
  fakeid: 'MTI0MDU3NDYwMQ==',
  payload: { platform: 'wechat', handle: '央视新闻', posts: [] },
};

/**
 * loggedInAfter: 第 N 次「探登录态」之后算登录成功（Infinity = 用户始终没登录）。
 * 探针与采集是两种消息，分开计数——「等待期间不许再打微信接口」这条就是靠它验证的。
 */
function loadSw(opts: { loggedInAfter?: number; activeUrl?: string; tabGone?: boolean; riskAcked?: boolean } = {}) {
  const noop = () => {};
  const listener = { addListener: noop };
  const local: Store = {
    // 风险确认（0.9.8 起 collectWechatOne 的第一道闸）预置为已确认——本文件测的是
    // 确认**之后**的行为。闸本身由 tests/legal/wechat-risk-ack.test.ts 与本文件末尾
    // 那条「没确认时一个请求都不发」守着。
    ...(opts.riskAcked === false ? {} : { wechatRiskAck: { version: 1, at: Date.now() } }),
    // 两个公开主页竞对（都采不到：内容脚本在用例里永远不发 beacon-collected）+ 缓存时间戳，
    // 让 getCompetitors 直接用本机这份，不去打服务器
    competitors: [
      { platform: 'douyin', handle: 'a', name: '甲', url: 'https://www.douyin.com/user/a', collectable: true },
      { platform: 'bilibili', handle: 'b', name: '乙', url: 'https://space.bilibili.com/b', collectable: true },
    ],
    competitorsAt: Date.now(),
  };
  const sent: Msg[] = [];
  const surfaced: number[] = [];
  const removed: number[] = [];
  const focused: number[] = [];
  let probes = 0;
  let opened = 0;
  const loggedInAfter = opts.loggedInAfter ?? Infinity;

  const sandbox: Record<string, unknown> = {
    chrome: {
      runtime: {
        onInstalled: listener, onStartup: listener, onMessage: listener,
        getPlatformInfo: noop, sendMessage: () => Promise.resolve(),
      },
      storage: {
        sync: { get: () => Promise.resolve({ host: 'https://h', token: 't' }), set: () => Promise.resolve() },
        local: {
          get: (k: unknown) => Promise.resolve(pick(local, k)),  // competitors 由下面预置
          set: (o: Store) => { Object.assign(local, o); return Promise.resolve(); },
          remove: (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) delete local[key];
            return Promise.resolve();
          },
        },
        onChanged: listener,
      },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      scripting: { executeScript: () => Promise.resolve() },
      windows: { update: (id: number) => { focused.push(id); return Promise.resolve({ id }); } },
      tabs: {
        onRemoved: listener,
        // 用户当前停在哪儿：默认不是公众号后台，于是插件自己开一个临时页（就是会「秒退」的那个）
        query: () => Promise.resolve([{ id: 7, url: opts.activeUrl ?? 'https://example.com/' }]),
        // 公众号那条固定用 8；公开主页那条每开一页 +1（11、12…），便于分辨谁被关了
        create: ({ url }: { url: string }) => Promise.resolve(
          url.includes('mp.weixin.qq.com') ? { id: 8, url } : { id: 10 + (++opened), url },
        ),
        get: (id: number) => (opts.tabGone ? Promise.reject(new Error('No tab')) : Promise.resolve({ id })),
        update: (id: number, info: { active?: boolean }) => {
          if (info?.active) surfaced.push(id);
          return Promise.resolve({ id, windowId: 1 });
        },
        remove: (id: number) => { removed.push(id); return Promise.resolve(); },
        sendMessage: (_id: number, m: Msg) => {
          sent.push(m);
          if (m.type === 'beacon-wechat-login-state') {
            probes++;
            return Promise.resolve({ ok: probes >= loggedInAfter, onLoginPage: probes < loggedInAfter });
          }
          return Promise.resolve(probes >= loggedInAfter ? COLLECTED : NOT_LOGGED_IN);
        },
      },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: noop, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, clearTimeout, setInterval, clearInterval, URL, AbortController,
    // 竞对清单走服务器那一跳（batchCollect 一进来就 force 刷新一次），其余接口回通用成功
    fetch: (url: string) => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(
        String(url).includes('/competitor/list')
          ? { ok: true, competitors: local.competitors, workspace: 'w' }
          : { ok: true, competitor: '央视新闻' },
      ),
    }),
  };
  // 假时钟：等用户扫码是分钟级的，用例不能真等。取值时才解析，这样 vi.useFakeTimers()
  // 替换掉的 setTimeout/Date 也能被 vm 里的代码用上。
  Object.defineProperty(sandbox, 'setTimeout', { get: () => globalThis.setTimeout, enumerable: true });
  Object.defineProperty(sandbox, 'Date', { get: () => globalThis.Date, enumerable: true });

  const context = vm.createContext(sandbox);
  vm.runInContext(SW_SRC, context);
  return {
    collectWechatOne: context.collectWechatOne as (
      name: string, opts?: { interactive?: boolean },
    ) => Promise<Record<string, unknown>>,
    // ⚠️ sw.js 顶层的 const 不会挂到 globalThis 上（函数声明才会），
    // 只能再进一次上下文求值——同一个 context 的后续脚本共享那份词法环境。
    batchCollect: context.batchCollect as (
      reportTabId: number | null, opts?: { interactive?: boolean },
    ) => Promise<Record<string, unknown>>,
    LOGIN_WAIT_MS: vm.runInContext('LOGIN_WAIT_MS', context) as number,
    sent, surfaced, removed, focused, local,
  };
}

/** 跑一次采集，同时把假时钟推到底（等待循环全靠它转） */
async function runWithClock<T>(p: Promise<T>, ms: number): Promise<T> {
  const done = p.then((v) => ({ v }), (e) => ({ e }));
  await vi.advanceTimersByTimeAsync(ms);
  const r = (await done) as { v?: T; e?: unknown };
  if (r.e) throw r.e;
  return r.v as T;
}

afterEach(() => { vi.useRealTimers(); });

describe('未登录 → 把登录页交给用户 → 登录完接着采', () => {
  it('🔒 用户点采集、撞到未登录：切到前台，而且**不关**这一页', async () => {
    vi.useFakeTimers();
    const sw = loadSw({ loggedInAfter: 2 }); // 探两次之后用户扫完码
    const r = await runWithClock(sw.collectWechatOne('央视新闻', { interactive: true }), 60_000);

    expect(sw.surfaced).toContain(8);            // 插件自己开的那一页被摆到了用户面前
    expect(sw.focused).toContain(1);             // 窗口也聚焦了，否则用户在别的窗口什么都看不见
    expect(sw.removed).not.toContain(8);         // ③ 已交给用户的页不许再自动关掉
    expect(r.ok).toBe(true);                     // 登录完成后本轮接着采到了数据
  });

  it('🔒 等待期间只探登录态，一个采集请求都不发（那正是最容易撞频控的做法）', async () => {
    vi.useFakeTimers();
    const sw = loadSw({ loggedInAfter: 4 });
    await runWithClock(sw.collectWechatOne('央视新闻', { interactive: true }), 60_000);

    const probes = sw.sent.filter((m) => m.type === 'beacon-wechat-login-state').length;
    const collects = sw.sent.filter((m) => m.type === 'beacon-wechat-collect').length;
    expect(probes).toBeGreaterThanOrEqual(4);
    expect(collects).toBe(2); // 只有「一开始那次」和「登录成功后那次」，等待期间一次都没有
  });

  it('🔒 等待有上限：一直不登录就如实收尾，且仍然不关那一页', async () => {
    vi.useFakeTimers();
    const sw = loadSw({ loggedInAfter: Infinity });
    const r = await runWithClock(
      sw.collectWechatOne('央视新闻', { interactive: true }),
      sw.LOGIN_WAIT_MS + 30_000,
    );

    expect(r.ok).toBe(false);
    expect(r.code).toBe('login_required');
    expect(String(r.error)).toContain('仍未登录');
    expect(sw.removed).not.toContain(8);
  });

  it('🔒 用户把登录页关掉 = 放弃本次，如实说，不无限等下去', async () => {
    vi.useFakeTimers();
    const sw = loadSw({ loggedInAfter: Infinity, tabGone: true });
    const r = await runWithClock(sw.collectWechatOne('央视新闻', { interactive: true }), 60_000);

    expect(r.code).toBe('login_required');
    expect(String(r.error)).toContain('关掉');
  });

  it('🔒 定时/后台那一轮不弹前台页（人多半不在电脑前），照旧关掉自己开的临时页', async () => {
    vi.useFakeTimers();
    const sw = loadSw({ loggedInAfter: Infinity });
    const r = await runWithClock(sw.collectWechatOne('央视新闻'), 60_000); // interactive 缺省 = false

    expect(sw.surfaced).toEqual([]);
    expect(sw.removed).toContain(8);
    expect(r.ok).toBe(false);
    expect(sw.sent.filter((m) => m.type === 'beacon-wechat-login-state')).toHaveLength(0);
  });

  it('🔒 借用用户自己已打开的后台页时，不因为等登录就把它关了', async () => {
    vi.useFakeTimers();
    const sw = loadSw({
      loggedInAfter: 2,
      activeUrl: 'https://mp.weixin.qq.com/cgi-bin/home?token=1234567890',
    });
    const r = await runWithClock(sw.collectWechatOne('央视新闻', { interactive: true }), 60_000);

    expect(sw.removed).toEqual([]); // 用户自己的标签页，任何情况下都不关
    expect(r.ok).toBe(true);
  });

  // ── 风险确认闸（0.9.8 起）──────────────────────────────────────────
  //
  // 这条通道用用户自己的公众平台登录态调非官方后台接口，踩线的后果落在**用户自己的号**上。
  // 上面所有用例都预置了「已确认」，所以这里必须反过来验一遍：没确认时它是真的什么都不做，
  // 而不只是返回一个错误对象却已经把请求发出去了。
  it('🔒 没确认过风险 → 一个标签页都不开、一个请求都不发', async () => {
    vi.useFakeTimers();
    const sw = loadSw({ riskAcked: false, loggedInAfter: 0 });
    const r = await runWithClock(sw.collectWechatOne('央视新闻', { interactive: true }), 60_000);

    expect(r.ok).toBe(false);
    expect(r.code).toBe('risk_unacked');
    // 真正要紧的是这三条：没开页、没关页、没发任何消息给内容脚本
    expect(sw.sent).toEqual([]);
    expect(sw.surfaced).toEqual([]);
    expect(sw.removed).toEqual([]);
  });

  it('🔒 定时那一轮同样被拦 —— 用户没确认过，自动跑更不能开始', async () => {
    vi.useFakeTimers();
    const sw = loadSw({ riskAcked: false, loggedInAfter: 0 });
    const r = await runWithClock(sw.collectWechatOne('央视新闻'), 60_000); // interactive 缺省 = false

    expect(r.code).toBe('risk_unacked');
    expect(sw.sent).toEqual([]);
  });
});

// 公开主页那一路没有可靠的「未登录」判据（各平台登录遮罩长相不同且会改版），
// 所以不猜原因，只保证一件事：别把现场关掉——用户看一眼那一页就知道是登录墙还是没加载完。
describe('公开主页采不到时：把现场留给用户，而不是静默关页', () => {
  it('🔒 用户点「全部采集」：第一个没采到的页留着并切到前台，理由进 notes', async () => {
    vi.useFakeTimers();
    const sw = loadSw();
    const r = await runWithClock(sw.batchCollect(null, { interactive: true }), 120_000);

    expect(sw.surfaced).toContain(11);           // 第一个失败的页被摆到用户面前
    expect(sw.removed).not.toContain(11);        // 且没被关掉
    expect(sw.removed).toContain(12);            // 后面的照旧关（一轮只打扰一次）
    expect(String((r.notes as string[]).join(''))).toContain('没采到数据');
  });

  it('🔒 定时那轮不打扰：一个前台页都不弹，全部照旧关掉', async () => {
    vi.useFakeTimers();
    const sw = loadSw();
    await runWithClock(sw.batchCollect(null), 120_000); // interactive 缺省 = false

    expect(sw.surfaced).toEqual([]);
    expect(sw.removed).toEqual(expect.arrayContaining([11, 12]));
  });
});

describe('🔒 插件不代替用户登录（政策红线，源码级）', () => {
  const FILES = ['extension/sw.js', 'extension/content/wechat-competitor.js', 'extension/content/self-backend.js'];

  it('等待登录的这几个文件里，没有任何「替用户操作登录」的痕迹', () => {
    for (const f of FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      // 注释里可以讲「不代替用户登录」，所以只查代码行
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, `${f} 里出现了疑似替用户填登录信息的代码`).not.toMatch(/password|passwd|\.value\s*=\s*.*(account|user|phone)/i);
      expect(code, `${f} 里出现了疑似替用户点登录/扫码的代码`).not.toMatch(/(login|signin|qrcode|扫码)[^\n]{0,40}\.click\(\)/i);
    }
  });
});
