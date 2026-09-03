import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// X 的自有数据通道。
//
// 【为什么 X 要单开一个文件】别的平台，「我的数据」和「竞对的数据」长在**不同的地方**：
// 自有数据在 creator.douyin.com / channels.weixin.qq.com 这类独立域名的创作者后台上（认域名就够），
// 竞对数据在公开主页上。X 两样都不是——浏览量在 X 上对所有人公开，
// x.com/<我> 和 x.com/<竞对> 是同一个域名、同一套 DOM、同一批 data-testid。
// 于是：
//   ① 「插件在 X 上没法取自有数据」不是平台限制，是 SELF_SUPPORTED 里少了一条规则；
//   ② 补上这条规则之后，唯一能分辨是谁的号的只剩「用户点了哪个按钮」——
//      点错不是「采得不准」，是竞对的 20 条推文被写成你自己的发布记录（污染看板/基线/学习样本）。
// 所以这个文件锁两件事：X 的自有页面认得出来；认不出是本人时**绝不**直接回填。

const X_SRC = readFileSync(resolve(process.cwd(), 'extension/content/x.js'), 'utf8');
const POPUP_SRC = readFileSync(resolve(process.cwd(), 'extension/popup.js'), 'utf8');
const SP_SRC = readFileSync(resolve(process.cwd(), 'extension/sidepanel.js'), 'utf8');
const SP_HTML = readFileSync(resolve(process.cwd(), 'extension/sidepanel.html'), 'utf8');

type XPost = { platformItemId: string; title: string; url: string; publishedAt?: string; metrics?: Record<string, number> };
type XPayload = { platform: string; handle: string; posts: XPost[]; isSelf?: boolean } | null;

// x.js 只依赖 document/location + common.js 的计数解析器
function parseX(url: string, body: string): XPayload {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    __beaconParseCount: (t: string) => {
      const n = Number(String(t).replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? Math.round(n) : undefined;
    },
    console,
  });
  vm.runInContext(X_SRC, context);
  return (context.__beaconParse as () => XPayload)();
}

const tweet = (id: string, opts: { analytics?: boolean; time?: string } = {}) => `
  <article data-testid="tweet">
    <a href="/me/status/${id}">链接</a>
    ${opts.time ? `<time datetime="${opts.time}"></time>` : ''}
    <div data-testid="tweetText">推文正文 ${id}</div>
    <div role="group" aria-label="3 replies, 5 reposts, 20 likes, 1,000 views"></div>
    ${opts.analytics ? `<a href="/me/status/${id}/analytics">查看帖子数据</a>` : ''}
  </article>`;

// ── 指标解析：真机 2026-07-27「认出了 6 条作品，但一个指标都没读到」──
//
// 原因是指标此前只从 [role=group] 的 aria-label 里按**英文词**抠（repl / like / view），
// 而那串是会被翻译的：中文界面上写的是「回复」「转帖」「喜欢」「查看」，一个都匹配不上，
// 于是 6 条推文全部 metrics={} → 后端按「一个指标都没读到」整批跳过 → 一条都没入库。
// 现在先读按钮（data-testid 不翻译），aria-label 只作兜底。
// 这里用 common.js 里**真正的**计数解析器，因为中文界面的大数字是「1.2万」。
const COMMON_SRC = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');

function parseXReal(url: string, body: string): XPayload {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    console, setTimeout,
  });
  vm.runInContext(COMMON_SRC, context); // 挂上真的 __beaconParseCount（认 万/亿/k/m）
  vm.runInContext(X_SRC, context);
  return (context.__beaconParse as () => XPayload)();
}

// 中文界面的推文：按钮上的 data-testid 不翻译，数字在按钮内部的计数容器里
const zhTweet = (id: string, counts: { reply: string; repost: string; like: string; views: string }) => `
  <article data-testid="tweet">
    <a href="/me/status/${id}">链接</a>
    <div data-testid="tweetText">推文正文</div>
    <div role="group" aria-label="${counts.reply} 条回复，${counts.repost} 次转帖，${counts.like} 个喜欢，${counts.views} 次查看">
      <button data-testid="reply"><span data-testid="app-text-transition-container">${counts.reply}</span></button>
      <button data-testid="retweet"><span data-testid="app-text-transition-container">${counts.repost}</span></button>
      <button data-testid="like"><span data-testid="app-text-transition-container">${counts.like}</span></button>
      <a href="/me/status/${id}/analytics"><span data-testid="app-text-transition-container">${counts.views}</span></a>
    </div>
  </article>`;

describe('🔒 X 指标解析 · 中文界面下必须读得到（真机：6 条全被跳过）', () => {
  it('中文界面：四项指标都读得到', () => {
    const p = parseXReal('https://x.com/me', zhTweet('1', { reply: '1', repost: '2', like: '2', views: '1202' }));
    expect(p!.posts[0].metrics).toEqual({ comments: 1, shares: 2, likes: 2, views: 1202 });
  });

  it('中文界面的「1.2万」按万折算，不是 1.2', () => {
    const p = parseXReal('https://x.com/me', zhTweet('1', { reply: '3', repost: '58', like: '1.2万', views: '35.6万' }));
    expect(p!.posts[0].metrics).toMatchObject({ likes: 12000, views: 356000 });
  });

  it('英文界面照旧（按钮层同样有效，没有回归）', () => {
    const en = `
      <article data-testid="tweet">
        <a href="/me/status/9">链接</a>
        <div data-testid="tweetText">t</div>
        <div role="group" aria-label="3 replies, 5 reposts, 20 likes, 1,000 views">
          <button data-testid="reply"><span data-testid="app-text-transition-container">3</span></button>
          <button data-testid="retweet"><span data-testid="app-text-transition-container">5</span></button>
          <button data-testid="like"><span data-testid="app-text-transition-container">20</span></button>
          <a href="/me/status/9/analytics"><span data-testid="app-text-transition-container">1,000</span></a>
        </div>
      </article>`;
    const p = parseXReal('https://x.com/me', en);
    expect(p!.posts[0].metrics).toEqual({ comments: 3, shares: 5, likes: 20, views: 1000 });
  });

  it('按钮层没有（X 改版删了 testid）→ 退回 aria-label，中英文都认', () => {
    const zhLabelOnly = `
      <article data-testid="tweet">
        <a href="/me/status/1">链接</a><div data-testid="tweetText">t</div>
        <div role="group" aria-label="7 条回复，8 次转帖，9 个喜欢，1234 次查看"></div>
      </article>`;
    expect(parseXReal('https://x.com/me', zhLabelOnly)!.posts[0].metrics)
      .toEqual({ comments: 7, shares: 8, likes: 9, views: 1234 });

    const enLabelOnly = `
      <article data-testid="tweet">
        <a href="/me/status/1">链接</a><div data-testid="tweetText">t</div>
        <div role="group" aria-label="3 replies, 5 reposts, 20 likes, 1,000 views"></div>
      </article>`;
    expect(parseXReal('https://x.com/me', enLabelOnly)!.posts[0].metrics)
      .toEqual({ comments: 3, shares: 5, likes: 20, views: 1000 });
  });

  it('转推按钮变成 unretweet / 已喜欢变成 unlike（自己转过赞过的推）也要读得到', () => {
    const body = `
      <article data-testid="tweet">
        <a href="/me/status/1">链接</a><div data-testid="tweetText">t</div>
        <div role="group">
          <button data-testid="unretweet"><span data-testid="app-text-transition-container">6</span></button>
          <button data-testid="unlike"><span data-testid="app-text-transition-container">11</span></button>
        </div>
      </article>`;
    expect(parseXReal('https://x.com/me', body)!.posts[0].metrics).toMatchObject({ shares: 6, likes: 11 });
  });

  it('数字为 0（按钮上不显示数字）时不硬造指标', () => {
    const body = `
      <article data-testid="tweet">
        <a href="/me/status/1">链接</a><div data-testid="tweetText">t</div>
        <div role="group">
          <button data-testid="reply"><span data-testid="app-text-transition-container"></span></button>
          <a href="/me/status/1/analytics"><span data-testid="app-text-transition-container">88</span></a>
        </div>
      </article>`;
    const m = parseXReal('https://x.com/me', body)!.posts[0].metrics!;
    expect(m.views).toBe(88);
    expect(m).not.toHaveProperty('comments');
  });
});

describe('X 解析 · 认出「这是我自己的号」', () => {
  it('主页有「编辑资料」→ isSelf', () => {
    const p = parseX(
      'https://x.com/me',
      `<div data-testid="primaryColumn">
         <button data-testid="editProfileButton">编辑资料</button>
         <div data-testid="UserName"><span><span>我</span></span></div>
         ${tweet('111')}
       </div>`,
    );
    expect(p?.isSelf).toBe(true);
    expect(p?.posts).toHaveLength(1);
  });

  it('推文里有「查看帖子数据」(/analytics) → isSelf（那个入口只有作者本人看得到）', () => {
    const p = parseX('https://x.com/me/status/111', `<div data-testid="primaryColumn">${tweet('111', { analytics: true })}</div>`);
    expect(p?.isSelf).toBe(true);
  });

  it('🔒 竞对主页（没有编辑资料、没有 analytics）→ 不带 isSelf', () => {
    const p = parseX(
      'https://x.com/rival',
      `<div data-testid="primaryColumn">
         <div data-testid="UserName"><span><span>竞对</span></span></div>
         <article data-testid="tweet">
           <a href="/rival/status/222">链接</a>
           <div data-testid="tweetText">竞对的推文</div>
           <div role="group" aria-label="1 reply, 2 reposts, 3 likes, 400 views"></div>
         </article>
       </div>`,
    );
    expect(p?.posts).toHaveLength(1);
    expect(p?.isSelf).toBeUndefined();
  });

  it('🔒 右栏「你可能感兴趣的人」不参与判断（只在主列里找）', () => {
    const p = parseX(
      'https://x.com/rival',
      `<div data-testid="sidebarColumn"><button data-testid="editProfileButton">编辑资料</button></div>
       <div data-testid="primaryColumn">
         <article data-testid="tweet">
           <a href="/rival/status/222">链接</a>
           <div data-testid="tweetText">竞对的推文</div>
         </article>
       </div>`,
    );
    // ⚠️ 先锚非空：x.js 的 __beaconParse 认不出路径时会 return null，
    //    那时 `p?.isSelf` 也是 undefined —— 断言恒真。同 describe 的 :191 有这个锚，这条没有。
    expect(p?.posts, '解析器整个没认出这一页，isSelf 的断言就失去意义了').toHaveLength(1);
    expect(p?.isSelf).toBeUndefined();
  });

  // publishedAt 不带的话，自有通道会把每条记录填成「回填当天」——
  // 发布时段分析按小时分组会全是回填那一刻的时辰（lib/ingest/own-post.ts 的 fillDate）。
  it('推文头部的 <time datetime> 作为 publishedAt 一起回传', () => {
    const p = parseX('https://x.com/me', `<div data-testid="primaryColumn">${tweet('111', { time: '2026-07-20T10:00:00.000Z' })}</div>`);
    expect(p?.posts[0].publishedAt).toBe('2026-07-20T10:00:00.000Z');
    expect(new Date(p!.posts[0].publishedAt!).getTime()).toBeGreaterThan(0);
  });

  it('没有 <time> 也不报错，只是不带这个字段（宁可少一项，不猜一个时间）', () => {
    const p = parseX('https://x.com/me', `<div data-testid="primaryColumn">${tweet('111')}</div>`);
    expect(p?.posts[0].publishedAt).toBeUndefined();
    expect(p?.posts[0].metrics?.views).toBe(1000);
  });
});

// ── 两份口径必须一致 ──
// popup 与 SidePanel 是同一个动作的两个入口。规则在一边改了另一边没改，
// 就会出现「在小窗里能回填、在侧边栏里说不支持」这种只有用户才撞得到的分裂。
function xSelfRegex(src: string): RegExp {
  const m = src.match(/const X_SELF_PAGE\s*=\s*\n?\s*(\/\^https[^\n]*\/);/);
  if (!m) throw new Error('没找到 X_SELF_PAGE');
  return new Function(`return ${m[1]}`)() as RegExp;
}

describe('X 自有页面白名单 · popup 与 SidePanel 同一份', () => {
  const popup = xSelfRegex(POPUP_SRC);
  const sp = xSelfRegex(SP_SRC);

  it('两边一字不差', () => {
    expect(popup.source).toBe(sp.source);
  });

  it.each([
    'https://x.com/myhandle',
    'https://x.com/myhandle/status/1234567890',
    'https://x.com/myhandle/with_replies',
    'https://twitter.com/myhandle',
    'https://x.com/myhandle?foo=1',
  ])('认自有页面：%s', (url) => {
    expect(popup.test(url)).toBe(true);
    expect(sp.test(url)).toBe(true);
  });

  // 保留路径必须排掉：刷首页/私信/通知时冒出一个「这是我的作品」按钮，
  // 点下去只会把信息流里别人的推文回填成自己的。
  it.each([
    'https://x.com/home',
    'https://x.com/explore',
    'https://x.com/notifications',
    'https://x.com/messages',
    'https://x.com/settings/profile',
    'https://x.com/i/account_analytics',
    'https://x.com/search?q=abc',
    'https://x.com/compose/post',
  ])('🔒 排除保留路径：%s', (url) => {
    expect(popup.test(url)).toBe(false);
    expect(sp.test(url)).toBe(false);
  });

  // 保留字**前缀**的正常用户名不能被误伤（"i" 是保留段，"iamcool" 不是）
  it.each(['https://x.com/iamcool', 'https://x.com/homer', 'https://x.com/settings_guy'])(
    '保留字前缀的用户名照收：%s',
    (url) => {
      expect(popup.test(url)).toBe(true);
      expect(sp.test(url)).toBe(true);
    },
  );
});

// ── SidePanel 上的真实点击 ──
function mountSp(tabUrl: string, collect: unknown) {
  const dom = new JSDOM(SP_HTML, { url: 'chrome-extension://test/sidepanel.html' });
  const sent: { type: string; payload?: Record<string, unknown> }[] = [];
  const chrome = {
    runtime: {
      sendMessage: (msg: { type: string }) => {
        sent.push(msg);
        if (msg.type === 'beacon-get-config') return Promise.resolve({ host: 'https://beacon.iyunci.cn' });
        if (msg.type === 'beacon-get-competitors') return Promise.resolve({ ok: true, competitors: [] });
        if (msg.type === 'beacon-ingest-self') {
          return Promise.resolve({ ok: true, updated: 0, created: 2, summary: '✓ 已回填：2 条作品', summaryOk: true });
        }
        return Promise.resolve({ ok: true });
      },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: tabUrl, title: 't' }]),
      sendMessage: (_id: number, msg: { type: string }) =>
        Promise.resolve(msg.type === 'beacon-collect' ? collect : { ok: false, reason: 'n/a' }),
      create: () => {},
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    // sidepanel.js 顶层要读设置；缺了它整份脚本停在第一处 chrome.storage 上（见 sidepanel-channel.test.ts 同处注释）
    storage: {
      sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  };
  const context = vm.createContext({ document: dom.window.document, window: dom.window, chrome, console, setTimeout, Date });
  vm.runInContext(SP_SRC, context);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const click = async (id: string) => {
    dom.window.document.getElementById(id)!.dispatchEvent(new dom.window.Event('click'));
    await settle();
  };
  const el = (id: string) => dom.window.document.getElementById(id)!;
  return { sent, click, settle, el };
}

const X_SELF_COLLECT = (isSelf?: boolean) => ({
  ok: true,
  payload: {
    platform: 'x',
    handle: 'myhandle',
    posts: [{ platformItemId: '111', title: '推文', url: 'https://x.com/myhandle/status/111', metrics: { views: 1000 } }],
    ...(isSelf ? { isSelf: true } : {}),
  },
});

describe('SidePanel · X 上的「这是我的作品」', () => {
  it('X 用户主页上按钮露出来（此前 SELF_SUPPORTED 里没有 X，永远是隐藏的）', async () => {
    const p = mountSp('https://x.com/myhandle', X_SELF_COLLECT(true));
    await p.settle();
    expect(p.el('spCollectSelf').style.display).not.toBe('none');
  });

  it('🔍 自检按钮不露出来（自检只有创作者后台实现，X 上点它永远只回一句「不是受支持的后台」）', async () => {
    const p = mountSp('https://x.com/myhandle', X_SELF_COLLECT(true));
    await p.settle();
    expect(p.el('spDiagnoseSelf').style.display).toBe('none');
  });

  it('x.js 认出是本人（isSelf）→ 一次点击直接走自有通道', async () => {
    const p = mountSp('https://x.com/myhandle', X_SELF_COLLECT(true));
    await p.click('spCollectSelf');
    expect(p.sent.filter((m) => m.type === 'beacon-ingest-self')).toHaveLength(1);
    expect(p.sent.some((m) => m.type === 'beacon-ingest')).toBe(false); // 竞对通道一条都不许发
  });

  it('🔒 认不出是本人 → 第一次点击只警告，绝不回填', async () => {
    const p = mountSp('https://x.com/rival', X_SELF_COLLECT(false));
    await p.click('spCollectSelf');
    expect(p.sent.some((m) => m.type === 'beacon-ingest-self')).toBe(false);
    expect(p.el('spResult').textContent).toContain('是你自己的号吗');
    expect(p.el('spResult').textContent).toContain('@myhandle');
  });

  it('确认后（同一地址再点一次）才回填', async () => {
    const p = mountSp('https://x.com/rival', X_SELF_COLLECT(false));
    await p.click('spCollectSelf');
    await p.click('spCollectSelf');
    expect(p.sent.filter((m) => m.type === 'beacon-ingest-self')).toHaveLength(1);
  });

  it('非 X 平台不受这道确认影响（创作者后台照旧一次点击回填）', async () => {
    const p = mountSp('https://creator.douyin.com/creator-micro/content/manage', {
      ok: true,
      payload: { platform: 'douyin', handle: 'self', posts: [{ platformItemId: 'a', metrics: { views: 1 } }] },
    });
    await p.click('spCollectSelf');
    expect(p.sent.filter((m) => m.type === 'beacon-ingest-self')).toHaveLength(1);
  });
});

// ── 小红书：与 X 同一类问题（真机 2026-07-28「小红书我的页面打开，无法识别自我账号」）──
//
// `xiaohongshu.com/user/profile/<id>` 上，我的主页和竞对主页也是**同一种页面**。
// 此前它只在 SUPPORTED（竞对）里，不在 SELF_SUPPORTED 里 —— 于是站在自己主页上
// 只给得出「加为竞对」，自有回填在这个页面上根本够不着。
describe('🔒 小红书 · 自己的主页要能回填', () => {
  const XHS_PROFILE = 'https://www.xiaohongshu.com/user/profile/5f3a2b1c000000000101';
  const XHS_NOTE = 'https://www.xiaohongshu.com/explore/64f1a2b3000000001203';

  it.each([
    ['popup', POPUP_SRC],
    ['SidePanel', SP_SRC],
  ])('%s 的自有白名单收了小红书主页', (_n, src) => {
    const m = src.match(/const SELF_SUPPORTED = \[([\s\S]*?)\n\];/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain('xiaohongshu\\.com\\/user\\/profile');
  });

  it('xhs.js 认出「编辑资料」→ isSelf:true', () => {
    const dom = new JSDOM(
      `<html><body><div class="user-info"><div class="user-name">我的号</div>
       <button>编辑资料</button></div></body></html>`,
      { url: XHS_PROFILE },
    );
    const ctx = vm.createContext({
      document: dom.window.document, location: dom.window.location,
      __beaconParseCount: (t: string) => { const n = Number(String(t).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : undefined; },
      console, setTimeout,
      chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    });
    vm.runInContext(COMMON_SRC, ctx); // 共享的 beaconLooksLikeSelf（真实环境里 manifest 保证 common.js 先加载）
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/content/xhs.js'), 'utf8'), ctx);
    const p = (ctx.__beaconParse as () => { isSelf?: boolean; handle: string })();
    expect(p.isSelf).toBe(true);
    expect(p.handle).toBe('5f3a2b1c000000000101');
  });

  it('🔒 别人的主页（只有「关注」）不带 isSelf —— 认不出时是 undefined，不是 false', () => {
    const dom = new JSDOM(
      `<html><body><div class="user-info"><div class="user-name">某竞对</div>
       <button>关注</button><button>发私信</button></div></body></html>`,
      { url: XHS_PROFILE },
    );
    const ctx = vm.createContext({
      document: dom.window.document, location: dom.window.location,
      __beaconParseCount: () => undefined, console, setTimeout,
      chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    });
    vm.runInContext(COMMON_SRC, ctx); // 不加载它的话，这条会因为 helper 不存在而假绿
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/content/xhs.js'), 'utf8'), ctx);
    const p = (ctx.__beaconParse as () => Record<string, unknown>)();
    expect(p.isSelf).toBeUndefined();
  });

  it('🔒 主页要确认两次，单篇笔记页不加这道摩擦（既有行为不受影响）', () => {
    for (const src of [POPUP_SRC, SP_SRC]) {
      const m = src.match(/const AMBIGUOUS_PROFILE = \[([^\]]*)\]/);
      expect(m).toBeTruthy();
      expect(m![1]).toContain('XHS_SELF_PROFILE');
      expect(m![1]).toContain('X_SELF_PAGE');
      // 笔记页不在这张表里
      expect(/explore/.test(m![1])).toBe(false);
    }
    expect(XHS_NOTE).not.toMatch(/\/user\/profile\//);
  });
});

// ── 其余平台的「自己主页」：B站空间 / 抖音主页 / YouTube 频道 ──
//
// 与 X、小红书完全同一个问题：我的主页和竞对主页是同一种页面，页面本身分不出是谁的。
// 此前这三个只在 SUPPORTED（竞对）里，站在自己主页上只给得出「加为竞对」。
//
// 这里**把源码里的正则取出来真求值**，而不是对源码做字符串匹配——
// 后者既挡不住「规则还在但写错了」，也会被转义形式绊倒（源码里是 `space\.bilibili`）。
function evalConsts(src: string, arrayName: string): RegExp[] {
  const consts = src.match(
    /const (?:X_SELF_PAGE|XHS_SELF_PROFILE|BILI_SELF_SPACE|DY_SELF_PROFILE|YT_SELF_CHANNEL|TT_SELF_PROFILE|TT_SELF_VIDEO) =[\s\S]*?;/g,
  )!.join('\n');
  // 数组可能是多行也可能一行，别要求结尾前有换行；`];` 只在数组末尾出现（正则里的 `]` 后面跟的是 + 或 /）
  const arr = src.match(new RegExp(`const ${arrayName} = \\[[\\s\\S]*?\\];`))![0];
  return new Function(`${consts}\n${arr}\nreturn ${arrayName};`)() as RegExp[];
}

describe('🔒 全平台「自己的主页」都能回填', () => {
  const PROFILES: [string, string][] = [
    ['B站空间', 'https://space.bilibili.com/12345678'],
    ['抖音主页', 'https://www.douyin.com/user/MS4wLjABAAAA-demo'],
    ['YouTube 频道', 'https://www.youtube.com/@MrBeast'],
    ['小红书主页', 'https://www.xiaohongshu.com/user/profile/5f3a2b1c000000000101'],
    ['X 主页', 'https://x.com/Aiyafun'],
    ['TikTok 主页', 'https://www.tiktok.com/@mrbeast'],
  ];

  it.each(PROFILES)('%s 能走自有通道（popup 与 SidePanel 同步）', (_n, url) => {
    for (const src of [POPUP_SRC, SP_SRC]) {
      expect(evalConsts(src, 'SELF_SUPPORTED').some((re) => re.test(url))).toBe(true);
    }
  });

  it.each(PROFILES)('%s 属于「分不出是谁的号」，要走二次确认', (_n, url) => {
    for (const src of [POPUP_SRC, SP_SRC]) {
      expect(evalConsts(src, 'AMBIGUOUS_PROFILE').some((re) => re.test(url))).toBe(true);
    }
  });

  it.each([
    ['B站视频页', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ['抖音视频页', 'https://www.douyin.com/video/7123456789'],
    ['小红书笔记页', 'https://www.xiaohongshu.com/explore/64f1a2b3000000001203'],
    ['TikTok 作品页', 'https://www.tiktok.com/@mrbeast/video/7123456789012345678'],
  ])('🔒 %s 仍可回填，但**不**加二次确认（既有行为，不加摩擦）', (_n, url) => {
    for (const src of [POPUP_SRC, SP_SRC]) {
      expect(evalConsts(src, 'SELF_SUPPORTED').some((re) => re.test(url))).toBe(true);
      expect(evalConsts(src, 'AMBIGUOUS_PROFILE').some((re) => re.test(url))).toBe(false);
    }
  });

  it.each([
    ['B站首页', 'https://www.bilibili.com/'],
    ['抖音首页', 'https://www.douyin.com/'],
    ['YouTube 首页', 'https://www.youtube.com/'],
    ['YouTube 搜索页', 'https://www.youtube.com/results?search_query=abc'],
    // TikTok 的功能页一律不带 @ —— 这是「只认 @ 开头」这条规则的价值所在
    ['TikTok 推荐流', 'https://www.tiktok.com/foryou'],
    ['TikTok 首页', 'https://www.tiktok.com/'],
    ['TikTok 话题页', 'https://www.tiktok.com/tag/fyp'],
    ['TikTok 直播页', 'https://www.tiktok.com/live'],
  ])('🔒 %s 不该冒出「这是我的作品」', (_n, url) => {
    for (const src of [POPUP_SRC, SP_SRC]) {
      expect(evalConsts(src, 'SELF_SUPPORTED').some((re) => re.test(url))).toBe(false);
    }
  });

  it.each([
    ['B站', 'extension/content/bilibili.js', 'https://space.bilibili.com/123', '编辑资料'],
    ['抖音', 'extension/content/douyin.js', 'https://www.douyin.com/user/MS4wdemo', '编辑资料'],
    ['YouTube', 'extension/content/youtube.js', 'https://www.youtube.com/@MrBeast', '自定义频道'],
    ['小红书', 'extension/content/xhs.js', 'https://www.xiaohongshu.com/user/profile/abc123', '编辑资料'],
    ['TikTok', 'extension/content/tiktok.js', 'https://www.tiktok.com/@mrbeast', '编辑资料'],
  ])('%s 解析器认出只有本人可见的入口「%s」→ isSelf', (_n, file, url, label) => {
    const dom = new JSDOM(`<html><body><div id="app"><button>${label}</button></div></body></html>`, { url });
    const ctx = vm.createContext({
      document: dom.window.document, location: dom.window.location,
      URLSearchParams: dom.window.URLSearchParams, console, setTimeout,
      chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    });
    vm.runInContext(COMMON_SRC, ctx); // 提供共享的 beaconLooksLikeSelf
    vm.runInContext(readFileSync(resolve(process.cwd(), file), 'utf8'), ctx);
    expect((ctx.__beaconParse as () => { isSelf?: boolean })().isSelf).toBe(true);
  });

  it('🔒 认不出时是 undefined 而不是 false（平台改版不该把功能变成打不开的门）', () => {
    const dom = new JSDOM('<html><body><div id="app"><button>关注</button></div></body></html>', {
      url: 'https://space.bilibili.com/123',
    });
    const ctx = vm.createContext({
      document: dom.window.document, location: dom.window.location, console, setTimeout,
      chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    });
    vm.runInContext(COMMON_SRC, ctx);
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/content/bilibili.js'), 'utf8'), ctx);
    expect((ctx.__beaconParse as () => Record<string, unknown>)().isSelf).toBeUndefined();
  });

  it('🔒 长句子里含「编辑资料」不算命中（避免把说明文案当按钮）', () => {
    const dom = new JSDOM(
      '<html><body><div id="app"><a>点这里可以编辑资料和头像设置</a></div></body></html>',
      { url: 'https://space.bilibili.com/123' },
    );
    const ctx = vm.createContext({
      document: dom.window.document, location: dom.window.location, console, setTimeout,
      chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    });
    vm.runInContext(COMMON_SRC, ctx);
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/content/bilibili.js'), 'utf8'), ctx);
    expect((ctx.__beaconParse as () => Record<string, unknown>)().isSelf).toBeUndefined();
  });
});
