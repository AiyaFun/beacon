import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ownAccountIngestSchema } from '@/lib/ingest/own-account';
import { ingestPayloadSchema } from '@/lib/ingest/competitor';

// ── 粉丝数为什么会「采到了却看不见」 ──
//
// 真机 2026-08-07（抖音）：竞对档案的粉丝数是 0、自有账号的粉丝数是空。而解析器本身没坏——
// 在真实 www.douyin.com/user/<sec_uid> 上跑 dyFollowers 拿得到 24.1万。数丢在解析之后的两段路上：
//
//   ① **竞对**：作品栅格没解析出来（虚拟列表回收/未登录/改版）时，采集流程会整包换成
//      `beaconFallbackParse()` 的结果，而兜底解析器**从不看统计栏、给不出 followers**。
//      于是粉丝数连同解析结果一起被扔掉。丢了是永久的：lib/ingest/competitor.ts 只在
//      `followers != null` 时更新档案，建档那次写的是 `?? 0`，档案便一直停在 0；
//      而竞对清单是 `followers > 0 ? 显示 : 不显示`，用户看到的就是「粉丝数没有」。
//
//   ② **自有**：主页解析出来的粉丝数在 `profile.followers` 里，但 /api/ingest/self 的
//      账号级 schema 只认 `dailyStats` —— profile 被 zod 静默剥掉，数一路走到服务端然后蒸发。
//
// 两条都是「采到了才丢」，比「没采到」更难发现：界面上没有任何报错，只是那一栏是空的。

const COMMON_SRC = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');
const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

// ── ① 竞对：兜底不许把已经采到的粉丝数一起扔掉 ──

type Collected = { ok: boolean; payload?: { platform: string; handle: string; profile?: { name?: string; followers?: number }; posts: unknown[] } };

/**
 * 跑一遍真实的采集流程（内容脚本的 `beacon-collect` 消息处理），站点解析器由参数给定。
 * 直接测 `__beaconMergeFallback` 只能证明合并函数对，证明不了采集流程真的用了它。
 */
function collect(siteParse: () => unknown): Promise<Collected> {
  const dom = new JSDOM('<html><body><h1>某抖音号</h1></body></html>', {
    url: 'https://www.douyin.com/user/MS4wLjABAAAAdemo',
  });
  let listener: ((m: unknown, s: unknown, r: (v: Collected) => void) => unknown) | undefined;
  const ctx = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    URL: dom.window.URL,
    console, setTimeout, clearTimeout,
    chrome: {
      runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
      storage: { sync: { get: () => Promise.resolve({}) } },
    },
  });
  vm.runInContext(COMMON_SRC, ctx);
  vm.runInContext(`globalThis.__beaconParse = ${siteParse.toString()};`, ctx);
  return new Promise((done) => { listener!({ type: 'beacon-collect' }, {}, done); });
}

const SITE_NO_POSTS = () => ({
  platform: 'douyin',
  handle: 'MS4wLjABAAAAdemo',
  profile: { name: '汀哥主要怕麻烦', followers: 241_000 },
  posts: [], // 栅格没渲染出来 —— 兜底就是被这个条件触发的
});

describe('竞对 · 兜底解析不许把站点解析器采到的粉丝数扔掉', () => {
  it('🔒 站点解析器只是没采到作品，粉丝数照样要回传（否则档案永远停在建档时的 0）', async () => {
    const r = await collect(SITE_NO_POSTS);
    expect(r.ok).toBe(true);
    expect(r.payload?.profile?.followers).toBe(241_000);
  });

  it('昵称同样保留：兜底那个是 og:title 猜的，站点解析器读的是主页上的昵称', async () => {
    const r = await collect(SITE_NO_POSTS);
    expect(r.payload?.profile?.name).toBe('汀哥主要怕麻烦');
  });

  it('兜底照旧补上「当前这一页」这条作品（合并的是 profile，不是把兜底关掉）', async () => {
    const r = await collect(SITE_NO_POSTS);
    expect(r.payload?.posts.length).toBe(1);
  });

  it('站点解析器整个失败（返回 null）时仍然纯走兜底，不炸', async () => {
    const r = await collect(() => null);
    expect(r.ok).toBe(true);
    expect(r.payload?.platform).toBe('douyin');
  });

  it('合并出来的包能过服务端的 zod（粉丝数带得上去才算数）', async () => {
    const r = await collect(SITE_NO_POSTS);
    const parsed = ingestPayloadSchema.safeParse(r.payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.profile?.followers).toBe(241_000);
  });

  // ── 「这个数是怎么读到的」也不许在合并时蒸发 ──
  //
  // followersVia 是插件降级的**唯一**上行信号（lib/ingest/parser-health.ts 按它告警）。
  // 而兜底被触发的条件是「作品栅格没解析出来」——页面刚改版时最先落空的正是它。
  // 合并时漏搬这个字段，降级告警就会在**最该响的那一次**静默：粉丝数还在，
  // 没有人知道它已经退到文本兜底了，而同一次降级落在别的页面结构上取出来的
  // 就是旁边那个「关注数」（差三个数量级、看着完全正常）。
  const SITE_DEGRADED = () => ({
    platform: 'douyin',
    handle: 'MS4wLjABAAAAdemo',
    profile: { name: '汀哥主要怕麻烦', followers: 241_000, followersVia: 'text' },
    posts: [],
  });

  it('🔒 followersVia 跟着一起保留（丢了 = 改版当天告警静默）', async () => {
    const r = await collect(SITE_DEGRADED);
    expect((r.payload?.profile as { followersVia?: string } | undefined)?.followersVia).toBe('text');
  });

  it('🔒 via=none（明确没读到）同样要带上去，不能退化成「没表态」', async () => {
    const r = await collect(() => ({
      platform: 'douyin',
      handle: 'MS4wLjABAAAAdemo',
      profile: { name: '汀哥主要怕麻烦', followersVia: 'none' },
      posts: [],
    }));
    expect((r.payload?.profile as { followersVia?: string } | undefined)?.followersVia).toBe('none');
  });

  it('via 能过服务端 zod（不在白名单里会被整包打回）', async () => {
    const r = await collect(SITE_DEGRADED);
    const parsed = ingestPayloadSchema.safeParse(r.payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.profile?.followersVia).toBe('text');
  });
});

// ── ② 自有：主页读到的粉丝数要折成当天一条快照 ──

function loadSw() {
  const noop = () => {};
  const listener = { addListener: noop };
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
      storage: {
        sync: { get: () => Promise.resolve({ host: 'https://h', token: 't' }), set: () => Promise.resolve() },
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
    fetch: (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, created: 1 }) });
    },
  });
  vm.runInContext(SW_SRC, context);
  return { ingestSelf: context.ingestSelf as (p: unknown) => Promise<unknown>, sent };
}

const HOME_PAYLOAD = {
  platform: 'douyin',
  handle: 'MS4wLjABAAAAdemo',
  profile: { name: '我的抖音号', followers: 241_000 },
  posts: [{ platformItemId: '7123456789012345678', metrics: { likes: 1200 } }],
};

// 本地日期（不是 UTC）：服务端容器跑 UTC，上午八点前回填交给它算会记到前一天。
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('自有 · 主页读到的粉丝数要落成 dailyStats', () => {
  it('🔒 profile.followers 折成当天一条 dailyStats（不折就会被服务端 zod 整块丢掉）', async () => {
    const sw = loadSw();
    await sw.ingestSelf(HOME_PAYLOAD);
    expect(sw.sent[0].body.dailyStats).toEqual([{ date: todayLocal(), followers: 241_000 }]);
  });

  it('🔒 日期按本地算（服务端容器是 UTC，交给它算会把早八点前的回填记到前一天）', async () => {
    const sw = loadSw();
    await sw.ingestSelf(HOME_PAYLOAD);
    const stats = sw.sent[0].body.dailyStats as { date: string }[];
    expect(stats[0].date).toBe(todayLocal());
  });

  it('🔒 后台已经给了 dailyStats 就不覆盖（「粉丝分析」页的日序列比主页那个瞬时数准）', async () => {
    const sw = loadSw();
    const backend = [{ date: '2026-08-01', followers: 100 }, { date: '2026-08-02', followers: 120 }];
    await sw.ingestSelf({ ...HOME_PAYLOAD, dailyStats: backend });
    expect(sw.sent[0].body.dailyStats).toEqual(backend);
  });

  it('没有粉丝数就不造一条空的（宁可少一项，不写 0 覆盖真值）', async () => {
    const sw = loadSw();
    await sw.ingestSelf({ ...HOME_PAYLOAD, profile: { name: '我的抖音号' } });
    expect(sw.sent[0].body).not.toHaveProperty('dailyStats');
  });

  it('粉丝数是脏值（NaN / 负数）时同样不造', async () => {
    for (const bad of [NaN, -1, '24.1万' as unknown as number]) {
      const sw = loadSw();
      await sw.ingestSelf({ ...HOME_PAYLOAD, profile: { name: 'x', followers: bad } });
      expect(sw.sent[0].body).not.toHaveProperty('dailyStats');
    }
  });
});

// 这两条是上面那一折的**理由**，直接钉在服务端真 schema 上：
// 哪天有人觉得「profile 里就有 followers，何必再折一遍」，删掉折叠会立刻在这里红。
describe('自有 · 服务端账号级 schema 的口径', () => {
  it('🔒 只带 profile.followers 的老形态 → 账号级 schema 认不出粉丝数（数就是这么蒸发的）', () => {
    const parsed = ownAccountIngestSchema.safeParse(HOME_PAYLOAD);
    expect(parsed.success).toBe(true); // 不报错，只是把 profile 悄悄剥掉 —— 所以现场没有任何报错可看
    expect(parsed.success && parsed.data.dailyStats).toBeUndefined();
  });

  it('折过之后 → 账号级 schema 收得到，且 /api/ingest/self 会走账号分支', async () => {
    const sw = loadSw();
    await sw.ingestSelf(HOME_PAYLOAD);
    const body = sw.sent[0].body;
    const parsed = ownAccountIngestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.dailyStats?.[0].followers).toBe(241_000);
    // 路由靠 `b.dailyStats !== undefined` 决定要不要跑账号级入库
    expect(body.dailyStats).toBeDefined();
  });
});
