import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 「带标签的统计数字」共用内核（common.js beaconReadStats）──
//
// 【它解决的问题】平台埋点是改版重灾区：抖音 2026-08-07 把 `user-fans` 改成 `user-info-fans`、
// `user-name` 直接删掉。埋点一失效，取数就退到「扫页面上含『粉丝』的短文本」——
// 这一步**能自修复，但很容易修出一个看着完全正常的错数字**，比取不到更毒。
//
// 【它替换掉了什么】此前五个站点各写各的，B站与小红书都写成
// `parseCount(t.replace('粉丝',''))` —— replace 只抠掉那两个字，
// 「关注 178 粉丝 328.3万」变成「关注 178  328.3万」，parseCount 取**第一个**数字 →
// 关注数被当成粉丝数（差三个数量级）。抖音 07-29 修过一次，这两家一直活着。
//
// 下面按三道闸组织：① 截断不是替换 ② 到下一个标签为止 ③ 同位判串台。

const COMMON = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');

type Stats = { values: Record<string, number>; via: Record<string, string | null> };
type Spec = { key: string; labels: string[]; e2e?: string };

function readStats(body: string, specs: Spec[], scopes: string[] = []): Stats {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url: 'https://www.douyin.com/user/x' });
  const ctx = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    console, setTimeout,
    chrome: { runtime: { onMessage: { addListener: () => {} } }, storage: { sync: { get: () => Promise.resolve({}) } } },
  });
  vm.runInContext(COMMON, ctx);
  return (ctx.__beaconReadStats as (s: Spec[], sc: string[]) => Stats)(specs, scopes);
}

const CN3: Spec[] = [
  { key: 'following', labels: ['关注'] },
  { key: 'followers', labels: ['粉丝'] },
  { key: 'likes', labels: ['获赞'] },
];

describe('闸① 截断而不是替换', () => {
  // 这一条就是 B站/小红书那个活了很久的 bug 的最小复现
  it('🔒 三个数字挨在一段文本里，粉丝取的是自己那个（不是前面的关注数）', () => {
    const r = readStats('<div>关注 178 粉丝 328.3万 获赞 3023.8万</div>', CN3);
    expect(r.values.followers).toBe(3_283_000);
    expect(r.values.following).toBe(178);
    expect(r.values.likes).toBe(30_238_000);
  });

  it('🔒 无空格紧挨着（真机抖音就是这个形态）也分得开', () => {
    const r = readStats('<div>关注250粉丝24.1万获赞110.4万</div>', CN3);
    expect(r.values).toEqual({ following: 250, followers: 241_000, likes: 1_104_000 });
  });

  it('只问粉丝一项时也不会拿到前面的关注数', () => {
    const r = readStats('<div>关注 178 粉丝 328.3万</div>', [{ key: 'followers', labels: ['粉丝'] }]);
    expect(r.values.followers).toBe(3_283_000);
  });
});

describe('闸② 到下一个标签为止 / 距离限制', () => {
  it('粉丝后面紧跟着的是获赞时，不会把获赞数吃进来', () => {
    const r = readStats('<div>粉丝 获赞 3023.8万</div>', CN3);
    expect(r.values.followers).toBeUndefined(); // 粉丝后面没有属于它的数字 → 不给
    expect(r.values.likes).toBe(30_238_000);
  });

  it('数字离标签太远（中间隔着一段字）判为不相干', () => {
    const r = readStats('<div>粉丝这个人很神秘什么都没有留下 123</div>', [{ key: 'followers', labels: ['粉丝'] }]);
    expect(r.values.followers).toBeUndefined();
  });

  it('「粉丝：  24.1万」这种带冒号空格的照样认', () => {
    const r = readStats('<div>粉丝：  24.1万</div>', [{ key: 'followers', labels: ['粉丝'] }]);
    expect(r.values.followers).toBe(241_000);
  });
});

describe('清洗：不是计数的东西一律不收', () => {
  it('🔒 时长（00:38）不会被当成粉丝数', () => {
    const r = readStats('<div>粉丝 00:38</div>', [{ key: 'followers', labels: ['粉丝'] }]);
    expect(r.values.followers).toBeUndefined();
  });

  it('🔒 占比（12%）不会被当成粉丝数', () => {
    const r = readStats('<div>粉丝 12%</div>', [{ key: 'followers', labels: ['粉丝'] }]);
    expect(r.values.followers).toBeUndefined();
  });

  it('🔒 一大段正文里出现「粉丝」二字不参与（长文本直接跳过）', () => {
    const bio = '感谢每一位粉丝的支持，我们已经一起走过 365 天，接下来会更新更多内容，敬请期待';
    const r = readStats(`<div>${bio}</div>`, [{ key: 'followers', labels: ['粉丝'] }]);
    expect(r.values.followers).toBeUndefined();
  });
});

describe('闸③ 同位判串台', () => {
  // 这是一道**兜底闸**，防的是「两个统计项最后指向同一个数字」——最常见的成因是标签互为子串
  // （某平台把「关注」写成「关注数」，而另一项的标签恰好能在同一处命中）。
  // 按**位置**判而不是按数值相等判：「关注 100 粉丝 100」是可能的巧合，位置撞了才是真串台。
  it('两项落在同一段文本的同一个下标上 → 两项一起作废（宁可不给，不给错的）', () => {
    const r = readStats('<div>关注 250</div>', [
      { key: 'a', labels: ['关注'] },
      { key: 'b', labels: ['注'] }, // 「注」是「关注」的子串，两者会指向同一个 250
    ]);
    expect(r.values.a).toBeUndefined();
    expect(r.values.b).toBeUndefined();
  });

  // 闸②（到下一个标签为止）先兜住了大部分情况：粉丝后面紧跟着别的标签时，它根本不给值
  it('标签紧挨着时，后一项拿不到数字而不是抢前一项的', () => {
    const r = readStats('<div>粉丝关注 250</div>', [
      { key: 'following', labels: ['关注'] },
      { key: 'followers', labels: ['粉丝'] },
    ]);
    expect(r.values.followers).toBeUndefined(); // 「粉丝」后面直接是「关注」，没有属于它的数字
    expect(r.values.following).toBe(250);
  });

  it('数值碰巧相同但位置不同 → 都保留（关注 100 粉丝 100 是可能的）', () => {
    const r = readStats('<div>关注 100 粉丝 100</div>', CN3);
    expect(r.values.following).toBe(100);
    expect(r.values.followers).toBe(100);
  });
});

describe('容器约束：别吃页面别处「你自己的」粉丝数', () => {
  const PAGE = `
    <div id="topbar"><span>粉丝 12</span></div>
    <div data-e2e="user-info"><div>关注250粉丝24.1万获赞110.4万</div></div>`;

  it('🔒 限定容器后，顶部登录态里自己的「粉丝 12」不参与', () => {
    const r = readStats(PAGE, CN3, ['[data-e2e="user-info"]']);
    expect(r.values.followers).toBe(241_000);
  });

  it('容器一个都认不出来时退回全页（宁可退化，不要空手）', () => {
    const r = readStats(PAGE, CN3, ['[data-e2e="container-gone"]']);
    expect(r.values.followers).toBeDefined();
  });

  // 容器选择器是各平台各写一套的猜测。写错时最坏的形态不是「没 narrow 住」，
  // 而是**选中了一个不含统计栏的元素** → 扫出空 → 粉丝数变空。
  // 那正是这轮要修的那个 bug，绝不能由防串台的措施自己再造一个出来。
  it('🔒 容器选错了（选中一个不含统计栏的元素）→ 全页兜底，不能因此变空', () => {
    const clean = '<div data-e2e="user-info"><div>关注250粉丝24.1万获赞110.4万</div></div>';
    const r = readStats(`<div id="wrong-box">这里什么统计都没有</div>${clean}`, CN3, ['#wrong-box']);
    expect(r.values.followers).toBe(241_000);
    expect(r.via.followers).toBe('text');
  });

  // 兜底不能把「容器约束」的作用抵消掉：整页有两个不同的「粉丝 N」时说不清哪个是这个号的，
  // 而错值会被写进全局共享的竞对档案且没有一键撤销，空值下游还有侧栏提示 + 降级告警接着
  it('🔒 容器选错 + 整页有两个不同的粉丝数 → 不猜，宁可空', () => {
    const r = readStats(`<div id="wrong-box">没有统计</div>${PAGE}`, CN3, ['#wrong-box']);
    expect(r.values.followers).toBeUndefined();
    expect(r.via.followers).toBeNull();
  });

  it('🔒 兜底路径上闸③（同位串台）同样生效，不能因为"只收集不判定"就漏掉', () => {
    const r = readStats('<div id="wrong-box">没有统计</div><div>关注 250</div>', ['关注', '注'].map((l, i) => ({
      key: ['a', 'b'][i], labels: [l],
    })), ['#wrong-box']);
    expect(r.values.a).toBeUndefined();
    expect(r.values.b).toBeUndefined();
  });

  // 判据必须是「一项都没取到」而不是「有项没取到」——否则容器明明是对的，
  // 只是某一项页面没展示，就会跑去全页把顶部**你自己的**粉丝数捞进来
  it('🔒 容器给出了任何一项，就不再全页兜底（否则容器保护等于白做）', () => {
    const r = readStats(
      `<div id="topbar"><span>粉丝 12</span></div>
       <div data-e2e="user-info"><div>关注 250</div></div>`, // 容器里只有关注，没有粉丝
      CN3,
      ['[data-e2e="user-info"]'],
    );
    expect(r.values.following).toBe(250);
    expect(r.values.followers).toBeUndefined(); // 宁可空，也不要顶部那个 12
  });
});

describe('埋点只是加速器，不是依赖', () => {
  const PAGE = `
    <div data-e2e="user-info">
      <div data-e2e="user-info-follow">关注250</div>
      <div data-e2e="user-info-fans">粉丝24.1万</div>
    </div>`;
  const WITH_E2E: Spec[] = [
    { key: 'following', labels: ['关注'], e2e: '[data-e2e="user-info-follow"]' },
    { key: 'followers', labels: ['粉丝'], e2e: '[data-e2e="user-info-fans"]' },
  ];

  it('埋点命中 → via 记 e2e', () => {
    const r = readStats(PAGE, WITH_E2E, ['[data-e2e="user-info"]']);
    expect(r.values.followers).toBe(241_000);
    expect(r.via.followers).toBe('e2e');
  });

  // 这条是整套设计的意义所在：平台把埋点改名，数字不能跟着丢
  it('🔒 埋点全部改名（模拟改版）→ 数字照样对，via 记 text', () => {
    const renamed = WITH_E2E.map((s) => ({ ...s, e2e: `[data-e2e="gone-${s.key}"]` }));
    const r = readStats(PAGE, renamed, ['[data-e2e="user-info"]']);
    expect(r.values.followers).toBe(241_000);
    expect(r.via.followers).toBe('text');
  });

  it('埋点挂在纯数字上（文本里没有标签）也读得到', () => {
    const r = readStats(
      '<div data-e2e="user-info"><span data-e2e="fans">241000</span></div>',
      [{ key: 'followers', labels: ['粉丝'], e2e: '[data-e2e="fans"]' }],
      ['[data-e2e="user-info"]'],
    );
    expect(r.values.followers).toBe(241_000);
    expect(r.via.followers).toBe('e2e');
  });

  it('一个都读不到时 via 是 null（「没读到」要能和「读到了」区分开）', () => {
    const r = readStats('<div>这一页什么统计都没有</div>', CN3);
    expect(r.values.followers).toBeUndefined();
    expect(r.via.followers).toBeNull();
  });
});

describe('数字在前的版式（YouTube / X / TikTok）', () => {
  it('中文「1.2万位订阅者」', () => {
    const r = readStats('<div>1.2万位订阅者</div>', [{ key: 'followers', labels: ['位订阅者', '订阅者', '订阅'] }]);
    expect(r.values.followers).toBe(12_000);
  });

  it('英文「1.2M subscribers」', () => {
    const r = readStats('<div>1.2M subscribers</div>', [{ key: 'followers', labels: ['subscribers', 'subscriber'] }]);
    expect(r.values.followers).toBe(1_200_000);
  });

  it('🔒 一行里拼了多项时各取各的（@handle · 1.2M subscribers · 500 videos）', () => {
    const r = readStats('<div>@who · 1.2M subscribers · 500 videos</div>', [
      { key: 'followers', labels: ['subscribers'] },
      { key: 'videos', labels: ['videos'] },
    ]);
    expect(r.values.followers).toBe(1_200_000);
    expect(r.values.videos).toBe(500);
  });

  it('「1,234 Followers」带千分位', () => {
    const r = readStats('<div>1,234 Followers</div>', [{ key: 'followers', labels: ['Followers'] }]);
    expect(r.values.followers).toBe(1234);
  });
});

// ── 各平台接线：确认真的用上了内核，而且老 bug 真的死了 ──

function parseSite(file: string, url: string, body: string) {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const ctx = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    URL: dom.window.URL,
    URLSearchParams: dom.window.URLSearchParams,
    console, setTimeout,
    chrome: { runtime: { onMessage: { addListener: () => {} } }, storage: { sync: { get: () => Promise.resolve({}) } } },
  });
  vm.runInContext(COMMON, ctx);
  vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/content', file), 'utf8'), ctx);
  return (ctx.__beaconParse as () => { profile?: { followers?: number; followersVia?: string } } | null)();
}

describe('B站 · 关注数不得被当成粉丝数（老代码 replace 的活 bug）', () => {
  const SPACE = `
    <div id="h-name">某UP主</div>
    <div class="upinfo"><div class="n-data">关注数 178 粉丝数 32.8万 获赞数 500.1万</div></div>`;

  it('🔒 粉丝数是 32.8万，不是关注数 178', () => {
    const p = parseSite('bilibili.js', 'https://space.bilibili.com/123456', SPACE);
    expect(p?.profile?.followers).toBe(328_000);
    expect(p?.profile?.followers).not.toBe(178);
  });

  it('followersVia 一起带上（服务端据此发现埋点/结构失效）', () => {
    const p = parseSite('bilibili.js', 'https://space.bilibili.com/123456', SPACE);
    expect(p?.profile?.followersVia).toBe('text');
  });

  it('老版 .n-fs[title] 有精确值时用精确值（同一个数，精度更高）', () => {
    const p = parseSite(
      'bilibili.js',
      'https://space.bilibili.com/123456',
      `<div id="h-name">某UP主</div>
       <div class="upinfo"><div>关注数 178 粉丝数 32.8万</div><span class="n-fs" title="328123">32.8万</span></div>`,
    );
    expect(p?.profile?.followers).toBe(328_123);
  });
});

describe('小红书 · 同一个 replace 坑', () => {
  const XHS = `
    <div class="user-name">某博主</div>
    <div class="user-interactions"><div>关注 12</div><div>粉丝 3.4万</div><div>获赞与收藏 56.7万</div></div>`;

  it('🔒 粉丝数是 3.4万，不是关注数 12', () => {
    const p = parseSite('xhs.js', 'https://www.xiaohongshu.com/user/profile/abc123', XHS);
    expect(p?.profile?.followers).toBe(34_000);
    expect(p?.profile?.followers).not.toBe(12);
  });

  // 老代码写成 `.user-interactions div, …, div, span`，看着是容器优先，
  // 但 querySelectorAll 按**文档序**返回而不是按 selector 顺序——容器根本没起作用
  it('🔒 页面顶部登录态里自己的「粉丝 9」不参与（容器约束真的生效）', () => {
    const p = parseSite(
      'xhs.js',
      'https://www.xiaohongshu.com/user/profile/abc123',
      `<div class="header"><span>粉丝 9</span></div>${XHS}`,
    );
    expect(p?.profile?.followers).toBe(34_000);
  });
});

describe('抖音 · 接线后仍然满足原有口径', () => {
  it('埋点改名 + 顶部有自己的「粉丝 12」→ 仍然取到 24.1万，via=text', () => {
    const p = parseSite(
      'douyin.js',
      'https://www.douyin.com/user/MS4wLjABAAAAdemo',
      `<div id="panel"><span>粉丝 12</span></div>
       <div data-e2e="user-detail"><div data-e2e="user-info">
         <h1>汀哥主要怕麻烦</h1>
         <div><div data-e2e="user-info-follow-renamed">关注250</div><div>粉丝24.1万</div><div>获赞110.4万</div></div>
       </div></div>`,
    );
    expect(p?.profile?.followers).toBe(241_000);
    expect(p?.profile?.followersVia).toBe('text');
  });
});
