import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { parseCompetitorUrl, competitorHomeUrl } from '@/lib/competitor-url';

// 「采 YouTube 时没采到对应 youtuber 的账号」——真机 2026-07-28。
//
// 三个独立缺陷叠在一起，表现都是「账号不对/没有」：
//   ① 兜底解析把 handle 的 @ 去掉了（'MrBeast'），而网页端加竞对存的是 '@MrBeast'
//      （lib/competitor-url.ts）。同一个频道被建成两个账号，「访问即采」也再匹配不上。
//   ② 兜底解析在 /watch 页把**视频 ID** 当成频道 handle —— 竞对库里凭空多出一个
//      以视频 ID 命名的"频道"。这不是采得不准，是造账号。
//   ③ 视频页的解析结果**不带 profile.name**，而服务端建档是
//      `name: profile?.name || handle`，于是竞对清单里显示的是 @xxx 而不是频道名。

const COMMON = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');
const YT = readFileSync(resolve(process.cwd(), 'extension/content/youtube.js'), 'utf8');

type Payload = {
  platform: string; handle: string;
  profile?: { name?: string; followers?: number };
  posts: { platformItemId: string; title: string; metrics?: Record<string, number> }[];
} | null;

function run(url: string, body: string, opts: { fallbackOnly?: boolean } = {}): Payload {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    URLSearchParams: dom.window.URLSearchParams, // youtube.js 在 /watch 页用它取 v=
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    console, setTimeout,
  });
  vm.runInContext(COMMON, context);
  if (!opts.fallbackOnly) vm.runInContext(YT, context);
  const fn = opts.fallbackOnly
    ? (context.beaconFallbackParse as () => Payload)
    : (context.__beaconParse as () => Payload);
  return fn();
}

const WATCH_BODY = (opts: { owner?: boolean; name?: string } = {}) => `
  <h1 class="ytd-watch-metadata">一个几乎没人用的技巧</h1>
  <ytd-video-owner-renderer>
    ${opts.owner === false ? '' : `<a href="/@MrBeast">MrBeast</a>`}
    <ytd-channel-name><div id="channel-name"><div id="text">${opts.name ?? 'MrBeast'}</div></div></ytd-channel-name>
  </ytd-video-owner-renderer>
  <ytd-watch-metadata><span>1,234,567 次观看</span></ytd-watch-metadata>`;

describe('🔒 YouTube handle 必须与网页端加竞对的口径一致（带 @）', () => {
  it('网页端解析 URL 得到的是带 @ 的 handle —— 这是唯一正确的口径', () => {
    expect(parseCompetitorUrl('https://www.youtube.com/@MrBeast')).toEqual({ platform: 'youtube', handle: '@MrBeast' });
    expect(parseCompetitorUrl('https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA'))
      .toEqual({ platform: 'youtube', handle: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });
  });

  it('频道页：插件采到的 handle 与它一字不差', () => {
    const p = run('https://www.youtube.com/@MrBeast/videos', '<h1>MrBeast</h1>');
    expect(p!.handle).toBe('@MrBeast');
  });

  it('🔒 兜底解析也必须带 @（去掉 @ 会把同一个频道建成两个竞对）', () => {
    const p = run('https://www.youtube.com/@MrBeast/shorts', '<div>x</div>', { fallbackOnly: true });
    expect(p!.handle).toBe('@MrBeast');
    expect(p!.handle).not.toBe('MrBeast');
  });

  it('兜底解析认 /channel/<id>', () => {
    const p = run('https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA', '<div>x</div>', { fallbackOnly: true });
    expect(p!.handle).toBe('UCX6OQ3DkcsbYNE6H8uQQuVA');
  });
});

describe('🔒 认不出频道时不许凭空造一个账号', () => {
  it('/watch 页：绝不把视频 ID 当频道 handle', () => {
    const p = run('https://www.youtube.com/watch?v=dQw4w9WgXcQ', '<div>没有 owner 区块</div>', { fallbackOnly: true });
    expect(p).toBeNull(); // 修复前：handle = 'dQw4w9WgXcQ'（视频 ID）
  });

  it.each([
    ['搜索结果页', 'https://www.youtube.com/results?search_query=abc'],
    ['订阅页', 'https://www.youtube.com/feed/subscriptions'],
    ['首页', 'https://www.youtube.com/'],
  ])('%s 不产生竞对账号', (_why, url) => {
    expect(run(url, '<div>x</div>', { fallbackOnly: true })).toBeNull();
  });

  it('视频页 owner 区块缺失 → 站点解析器如实返回 null，不交给兜底去猜', () => {
    expect(run('https://www.youtube.com/watch?v=dQw4w9WgXcQ', WATCH_BODY({ owner: false }))).toBeNull();
  });
});

describe('🔒 视频页要带上频道名（否则竞对清单里显示的是 @xxx）', () => {
  it('采到 handle 与频道显示名', () => {
    const p = run('https://www.youtube.com/watch?v=dQw4w9WgXcQ', WATCH_BODY());
    expect(p!.handle).toBe('@MrBeast');
    expect(p!.profile?.name).toBe('MrBeast'); // 修复前：profile 整个不存在
    expect(p!.posts[0].platformItemId).toBe('dQw4w9WgXcQ');
  });

  it('服务端按 `profile?.name || handle` 建档 —— 有名字就不会退化成 @handle', () => {
    const p = run('https://www.youtube.com/watch?v=dQw4w9WgXcQ', WATCH_BODY({ name: '野兽先生' }));
    const nameUsed = p!.profile?.name || p!.handle;
    expect(nameUsed).toBe('野兽先生');
    expect(nameUsed).not.toBe('@MrBeast');
  });

  it('频道页照旧带名字与订阅数', () => {
    const p = run('https://www.youtube.com/@MrBeast/videos', `
      <ytd-channel-name><div id="text">MrBeast</div></ytd-channel-name>
      <span>4.21亿位订阅者</span>
      <ytd-rich-item-renderer>
        <a href="/watch?v=abc123XYZ">我把一座岛送给了粉丝</a>
        <span>1.2亿次观看</span>
      </ytd-rich-item-renderer>`);
    expect(p!.handle).toBe('@MrBeast');
    expect(p!.profile?.name).toBe('MrBeast');
    expect(p!.profile?.followers).toBe(421000000);
    expect(p!.posts[0].platformItemId).toBe('abc123XYZ');
    expect(p!.posts[0].metrics?.views).toBe(120000000);
  });
});

// ── 中文 handle：真机 2026-07-28 的 https://www.youtube.com/@傑少JAY ──
//
// pathname 是百分号编码的 `/@%E5%82%91%E5%B0%91JAY`。旧代码把**编码后**的串当 handle 存库，
// competitorHomeUrl 再 encodeURIComponent 一次 → `%25E5%2582%2591…` 双重编码 → 打开是 404。
// 于是「打开采集」和批量采集打开的都是空页面，用户看到的就是「采不到这个 youtuber 的账号」。
// 纯英文 handle 完全无感，所以这个 bug 一直藏着。
describe('🔒 中文 / 非 ASCII 频道 handle', () => {
  const ZH = '@傑少JAY';
  const ENCODED_URL = 'https://www.youtube.com/@%E5%82%91%E5%B0%91JAY';

  it('解析 URL 得到人读得懂的原文，不是 %E5%82%91…', () => {
    expect(parseCompetitorUrl(ENCODED_URL)).toEqual({ platform: 'youtube', handle: ZH });
    // 用户直接粘中文地址也是同一个结果
    expect(parseCompetitorUrl('https://www.youtube.com/@傑少JAY')).toEqual({ platform: 'youtube', handle: ZH });
  });

  it('🔒 拼回主页地址只编码一次，打开是真页面而不是 404', () => {
    expect(competitorHomeUrl('youtube', ZH)).toBe(ENCODED_URL);
    expect(competitorHomeUrl('youtube', ZH)).not.toContain('%25'); // %25 = 双重编码的特征
  });

  it('🔒 存量的编码旧值也要能拼出正确地址（decode→encode 幂等）', () => {
    expect(competitorHomeUrl('youtube', '@%E5%82%91%E5%B0%91JAY')).toBe(ENCODED_URL);
  });

  it('插件在该频道页采到的 handle 与库里存的一字不差', () => {
    const p = run(ENCODED_URL, '<h1>傑少JAY</h1>');
    expect(p!.handle).toBe(ZH);
    expect(p!.handle).toBe(parseCompetitorUrl(ENCODED_URL)!.handle);
  });

  it('兜底解析也解码', () => {
    const p = run(ENCODED_URL + '/shorts', '<div>x</div>', { fallbackOnly: true });
    expect(p!.handle).toBe(ZH);
  });

  it('handle 里真的带 % 时不崩（decodeURIComponent 遇非法序列会抛）', () => {
    expect(parseCompetitorUrl('https://www.youtube.com/@100%off')).toEqual({ platform: 'youtube', handle: '@100%off' });
    expect(() => competitorHomeUrl('youtube', '@100%off')).not.toThrow();
  });
});
