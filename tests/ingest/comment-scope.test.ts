import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 评论提问的**归属判定**（sw.js `collectComments`）。
//
// 这份用例钉的是一个静默错误：判「自有还是竞对」曾经写成 `globalThis.__beaconSelfOnly`，
// 而那个标记由 `content/self-backend.js` 写在**内容脚本的隔离世界**里——
// Service Worker 有自己的全局作用域，读到的永远是 undefined。
// 于是判定退化成 URL 正则 /creator|studio|manage|dashboard/，而作品详情页
// （www.douyin.com/video/xxx）一个词都不匹配 → **自己作品的读者提问全部记成竞对提问**。
// 不报错、不告警，只是记进了别人名下（同 2026-07-25 回填挂错账号那类事故的形状）。
//
// 修法：判据全部由页面那一侧（content/comments.js）随结果带上来——
//   · result.selfOnly  ← 创作者后台标记
//   · result.handle    ← 页面作者，与本工作区已绑定的账号比对
// 另外钉住 accountId 取的是 `a.id`（/api/ingest/self/accounts 回的字段），
// 不是 `a.accountId`——写错字段不会报错，只会静默变成「没绑定」。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

type Parsed = {
  ok: true;
  platform: string;
  handle?: string | null;
  selfOnly?: boolean;
  read: number;
  questions: { text: string; count: number; kind: string }[];
};

type Ctx = { collectComments: (tabId: number) => Promise<Record<string, unknown>> };

function loadSw(opts: {
  parsed: Parsed;
  tabUrl: string;
  selfAccounts?: { id: string; platform: string; handle: string }[];
  boundAccountId?: string;
  own?: boolean;
  rival?: boolean;
}) {
  const noop = () => {};
  const listener = { addListener: noop };
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const sync: Record<string, unknown> = {
    host: 'https://beacon.iyunci.cn',
    token: 't',
    commentCollectOwn: opts.own ?? true,
    commentCollectRival: opts.rival ?? true,
    selfAccountId: opts.boundAccountId ?? '',
  };
  const local: Record<string, unknown> = { selfAccounts: opts.selfAccounts ?? [] };
  const pick = (store: Record<string, unknown>, keys: unknown) => {
    const out: Record<string, unknown> = {};
    const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(store);
    for (const k of list as string[]) out[k] = store[k];
    return Promise.resolve(out);
  };
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, id: 'abcdef', getManifest: () => ({ version: '0.8.2' }) },
      management: { getSelf: () => Promise.resolve({ installType: 'development' }) },
      storage: {
        sync: { get: (k: unknown) => pick(sync, k), set: () => Promise.resolve() },
        local: { get: (k: unknown) => pick(local, k), set: () => Promise.resolve(), remove: () => Promise.resolve() },
        onChanged: listener,
      },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      scripting: { executeScript: () => Promise.resolve([{ result: opts.parsed }]) },
      tabs: {
        onRemoved: listener,
        onUpdated: listener,
        get: () => Promise.resolve({ id: 1, url: opts.tabUrl }),
        create: () => Promise.resolve({ id: 1 }),
        remove: noop,
        sendMessage: noop,
        query: () => Promise.resolve([{ id: 1, url: opts.tabUrl }]),
      },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: noop, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    URL,
    AbortController,
    fetch: (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, created: 1, updated: 0 }) });
    },
  });
  vm.runInContext(SW_SRC, context);
  return { ctx: context as unknown as Ctx, sent };
}

const parsed = (over: Partial<Parsed> = {}): Parsed => ({
  ok: true,
  platform: 'douyin',
  handle: 'MS4wLjABAAAA_me',
  selfOnly: false,
  read: 42,
  questions: [{ text: '这个工具怎么收费呢', count: 3, kind: 'question' }],
  ...over,
});

const MY_DOUYIN = { id: 'acc-1', platform: 'douyin', handle: 'MS4wLjABAAAA_me' };

describe('评论提问归属：自有 vs 竞对', () => {
  it('作品详情页 + handle 命中已绑定账号 → own（URL 里一个后台关键词都没有）', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed(),
      tabUrl: 'https://www.douyin.com/video/7412345678901234567',
      selfAccounts: [MY_DOUYIN],
    });
    const r = await ctx.collectComments(1);
    expect(r.ok).toBe(true);
    expect(sent[0].body.scope).toBe('own');
  });

  it('同一页面，handle 不在已绑定账号里 → rival', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ handle: 'MS4wLjABAAAA_someone_else' }),
      tabUrl: 'https://www.douyin.com/video/7412345678901234567',
      selfAccounts: [MY_DOUYIN],
    });
    await ctx.collectComments(1);
    expect(sent[0].body.scope).toBe('rival');
  });

  it('handle 比对忽略 @ 前缀与大小写（YouTube 的 @handle 与库里存的可能不同形）', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ platform: 'youtube', handle: '@MyChannel' }),
      tabUrl: 'https://www.youtube.com/watch?v=abc',
      selfAccounts: [{ id: 'acc-yt', platform: 'youtube', handle: 'mychannel' }],
    });
    await ctx.collectComments(1);
    expect(sent[0].body.scope).toBe('own');
    expect(sent[0].body.accountId).toBe('acc-yt');
  });

  it('平台不同但 handle 相同 → 不算命中（跨平台同名很常见）', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ platform: 'douyin', handle: 'same' }),
      tabUrl: 'https://www.douyin.com/video/7412345678901234567',
      selfAccounts: [{ id: 'acc-b', platform: 'bilibili', handle: 'same' }],
    });
    await ctx.collectComments(1);
    expect(sent[0].body.scope).toBe('rival');
  });

  it('创作者后台（selfOnly 由内容脚本带上来）→ own', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ selfOnly: true, handle: null }),
      tabUrl: 'https://creator.douyin.com/creator-micro/content/manage',
      selfAccounts: [MY_DOUYIN],
    });
    await ctx.collectComments(1);
    expect(sent[0].body.scope).toBe('own');
  });
});

describe('评论提问归属：accountId 挂到哪个号上', () => {
  it('取命中账号的 a.id（不是 a.accountId——那个字段不存在，会静默变成没绑定）', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed(),
      tabUrl: 'https://www.douyin.com/video/1',
      selfAccounts: [MY_DOUYIN],
    });
    await ctx.collectComments(1);
    expect(sent[0].body.accountId).toBe('acc-1');
  });

  it('后台页没有 handle 可比 → 退回用户显式绑定的账号', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ selfOnly: true, handle: null }),
      tabUrl: 'https://creator.douyin.com/creator-micro/content/manage',
      selfAccounts: [MY_DOUYIN, { id: 'acc-2', platform: 'douyin', handle: 'other' }],
      boundAccountId: 'acc-2',
    });
    await ctx.collectComments(1);
    expect(sent[0].body.accountId).toBe('acc-2');
  });

  it('没绑定、同平台有两个号 → 不猜，accountId 留空交给服务端', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ selfOnly: true, handle: null }),
      tabUrl: 'https://creator.douyin.com/creator-micro/content/manage',
      selfAccounts: [
        { id: 'acc-1', platform: 'douyin', handle: 'a' },
        { id: 'acc-2', platform: 'douyin', handle: 'b' },
      ],
    });
    await ctx.collectComments(1);
    expect(sent[0].body.accountId).toBeFalsy();
  });

  it('竞对提问不挂任何自有账号', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ handle: 'rival-guy' }),
      tabUrl: 'https://www.douyin.com/video/1',
      selfAccounts: [MY_DOUYIN],
      boundAccountId: 'acc-1',
    });
    await ctx.collectComments(1);
    expect(sent[0].body.scope).toBe('rival');
    expect(sent[0].body.accountId).toBeFalsy();
  });
});

describe('两个开关各管各的', () => {
  it('两个都关 → 直接拒绝，不注入脚本、不读任何评论', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed(),
      tabUrl: 'https://www.douyin.com/video/1',
      selfAccounts: [MY_DOUYIN],
      own: false,
      rival: false,
    });
    const r = await ctx.collectComments(1);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('只开自有：自己作品能采', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed(),
      tabUrl: 'https://www.douyin.com/video/1',
      selfAccounts: [MY_DOUYIN],
      own: true,
      rival: false,
    });
    const r = await ctx.collectComments(1);
    expect(r.ok).toBe(true);
    expect(sent[0].body.scope).toBe('own');
  });

  it('只开自有：竞对作品被拒，且没有任何数据发出去', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed({ handle: 'rival-guy' }),
      tabUrl: 'https://www.douyin.com/video/1',
      selfAccounts: [MY_DOUYIN],
      own: true,
      rival: false,
    });
    const r = await ctx.collectComments(1);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

// 探针（extension/tools/comments-probe.js）是真机校准的唯一工具：粘进控制台，
// 告诉你现行选择器命中了什么、两道闸为什么拒发。它内嵌了一份 PLATFORM_RULES 副本——
// 副本一旦漂移，探针会说「选择器没问题」而插件用的是另一套，比没有探针更坏。
describe('探针与采集器的选择器规则不许漂移', () => {
  const rulesOf = (file: string) => {
    const src = readFileSync(resolve(process.cwd(), file), 'utf8');
    const m = src.match(/const PLATFORM_RULES = (\{[\s\S]*?\n {2}\});/);
    if (!m) throw new Error(`没能从 ${file} 里取出 PLATFORM_RULES`);
    return vm.runInNewContext(`(${m[1]})`) as Record<string, unknown>;
  };

  it('comments-probe.js 的副本与 comments.js 完全一致', () => {
    expect(rulesOf('extension/tools/comments-probe.js')).toEqual(rulesOf('extension/content/comments.js'));
  });

  it('六个平台一个不少', () => {
    expect(Object.keys(rulesOf('extension/content/comments.js')).sort())
      .toEqual(['bilibili', 'douyin', 'tiktok', 'x', 'xiaohongshu', 'youtube']);
  });
});

// ── 2026-08-08 真机校准的五个结论，每条都是当天在真实页面上踩实的，不许静默回退 ──
//
// 校准现场（用户真实 Chrome，登录态）：B站 BV1vRuJ6zEro / 抖音 modal 7654911185317317934 /
// 小红书 explore 6a6ffb83… / X status 2086052018897203505。改这里的任何断言，
// 必须先重跑 tools/comments-probe.js 拿到新的真机证据。
describe('真机校准结论不许回退（2026-08-08）', () => {
  const rules = () => {
    const src = readFileSync(resolve(process.cwd(), 'extension/content/comments.js'), 'utf8');
    const m = src.match(/const PLATFORM_RULES = (\{[\s\S]*?\n {2}\});/);
    if (!m) throw new Error('没能取出 PLATFORM_RULES');
    return vm.runInNewContext(`(${m[1]})`) as Record<string, {
      containers: string[]; items: string[]; textInItem?: string[];
      shadowChain?: string[]; textStrategy?: string;
    }>;
  };

  it('B站走四层 shadow 链（单层 shadowRoot 里什么都取不到，read 恒为 0）', () => {
    expect(rules().bilibili.shadowChain).toEqual(['bili-comment-renderer', 'bili-rich-text', '#contents']);
  });

  it('抖音走时间行锚点（正文没有 data-e2e，类名是编译期哈希，选择器写死必坏）', () => {
    expect(rules().douyin.textStrategy).toBe('time-anchor');
  });

  it('小红书条目排除楼中楼（不排除则 read 虚高一倍、子回复被当独立评论）', () => {
    expect(rules().xiaohongshu.items.some((s) => s.includes(':not(.comment-item-sub)'))).toBe(true);
  });

  it('X 条目排除主推文（主推文也是 article[data-testid="tweet"]，不排除则作者的话被当读者评论）', () => {
    for (const s of rules().x.items) {
      expect(s).toContain('[tabindex="0"]');
    }
  });

  it('🔒 extractText 没有「整条 item 的 textContent」兜底（那是昵称/时间/IP 混进正文的唯一通道）', () => {
    // 2026-08-08 小红书真机：纯表情评论 .content 空串，旧兜底把「昵称+3天前+广东+赞数」
    // 当正文捞上来，形状闸整批拒发——一条脏数据毁掉整页。命中即定局、落空即 null。
    const src = readFileSync(resolve(process.cwd(), 'extension/content/comments.js'), 'utf8');
    const fn = src.match(/function extractText\([\s\S]*?\n {2}\}/);
    if (!fn) throw new Error('没找到 extractText');
    expect(fn[0]).not.toContain('root.textContent');
  });
});

describe('回传结构里没有评论者身份字段', () => {
  it('payload 只有提问文本与作品信息（这条是披露里写死的承诺）', async () => {
    const { ctx, sent } = loadSw({
      parsed: parsed(),
      tabUrl: 'https://www.douyin.com/video/1',
      selfAccounts: [MY_DOUYIN],
    });
    await ctx.collectComments(1);
    const body = sent[0].body as Record<string, unknown>;
    for (const forbidden of ['author', 'authorName', 'nickname', 'userId', 'avatar', 'ipLocation', 'commentedAt', 'likes']) {
      expect(body).not.toHaveProperty(forbidden);
    }
    const q = (body.questions as Record<string, unknown>[])[0];
    expect(Object.keys(q).sort()).toEqual(['count', 'kind', 'text']);
  });
});
