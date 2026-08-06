import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCompetitorUrl, competitorHomeUrl } from '@/lib/competitor-url';
import { parsePublishUrl, publicItemUrl } from '@/lib/publish/parse-url';
import { PLATFORMS } from '@/lib/constants';
import { PLUGIN_COLLECTABLE } from '@/lib/ingest/competitor';

// TikTok 采集端到端的口径锁定。
//
// 这份测试盯的不是「能不能采到」，而是**采到的东西挂在谁名下、是不是同一个 handle 口径**——
// 这条链上历史事故全出在这儿：
//   · YouTube 把视频 ID 当频道 handle → 竞对库里凭空多出一个假频道（2026-07-28）；
//   · YouTube 中文 handle 双重编码 → 主页 404，什么都采不到（同一天）；
//   · 回填账号挂错平台 → 数据在看板上彻底看不见（2026-07-25）。
// TikTok 三处 handle 口径（lib/competitor-url、content/tiktok.js、content/common.js 兜底）
// 必须**逐字符一致**，否则「访问即采」按 platform+handle 比对会永远匹配不上已订阅的号。

const COMMON_SRC = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');
const TT_SRC = readFileSync(resolve(process.cwd(), 'extension/content/tiktok.js'), 'utf8');

type Payload = {
  platform: string;
  handle: string;
  profile?: { name?: string; followers?: number };
  posts: { platformItemId: string; title: string; url: string; publishedAt?: string; metrics?: Record<string, number> }[];
  isSelf?: boolean;
};

/** 在 JSDOM 里跑站点解析器。fallbackOnly=true 时只跑 common.js 的兜底解析。 */
function run(url: string, body: string, opts: { fallbackOnly?: boolean } = {}): Payload | null {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const ctx = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    URL: dom.window.URL,
    URLSearchParams: dom.window.URLSearchParams,
    console,
    setTimeout,
    chrome: {
      runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) },
      storage: { sync: { get: () => Promise.resolve({}) } },
    },
  });
  vm.runInContext(COMMON_SRC, ctx);
  if (!opts.fallbackOnly) vm.runInContext(TT_SRC, ctx);
  const fn = opts.fallbackOnly
    ? (ctx.beaconFallbackParse as () => Payload | null)
    : (ctx.__beaconParse as () => Payload | null);
  return fn();
}

/** 水合数据脚本标签（TikTok 线上就是这么埋的） */
function universal(data: unknown): string {
  return `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: data })}</script>`;
}

const VID = '7123456789012345678';

describe('TikTok · 平台已登记', () => {
  it('在 PLATFORMS 白名单里，且与抖音是两个独立平台', () => {
    expect(PLATFORMS.tiktok.name).toBe('TikTok');
    expect(PLATFORMS.tiktok.key).not.toBe(PLATFORMS.douyin.key);
  });

  it('插件可采（否则竞对清单里会标成「不可采」，用户点了也没反应）', () => {
    expect(PLUGIN_COLLECTABLE.has('tiktok')).toBe(true);
  });
});

describe('TikTok · handle 口径三处一致', () => {
  it('主页链接 → handle **不带 @**（与 X 同口径）', () => {
    expect(parseCompetitorUrl('https://www.tiktok.com/@mrbeast')).toEqual({ platform: 'tiktok', handle: 'mrbeast' });
    expect(parseCompetitorUrl('https://tiktok.com/@mrbeast/video/123')).toEqual({ platform: 'tiktok', handle: 'mrbeast' });
  });

  it('handle → 主页链接（@ 由拼接方补，不进库）', () => {
    expect(competitorHomeUrl('tiktok', 'mrbeast')).toBe('https://www.tiktok.com/@mrbeast');
    // 存量里混进带 @ 的旧值也不能拼出 /@@name
    expect(competitorHomeUrl('tiktok', '@mrbeast')).toBe('https://www.tiktok.com/@mrbeast');
  });

  it('往返一致：URL → handle → URL', () => {
    const p = parseCompetitorUrl('https://www.tiktok.com/@mrbeast')!;
    expect(competitorHomeUrl(p.platform, p.handle)).toBe('https://www.tiktok.com/@mrbeast');
  });

  it('🔒 站点解析器与 lib 给出同一个 handle（不一致 = 访问即采永远匹配不上已订阅的号）', () => {
    const p = run('https://www.tiktok.com/@mrbeast', '<div>x</div>')!;
    expect(p.handle).toBe(parseCompetitorUrl('https://www.tiktok.com/@mrbeast')!.handle);
  });

  it('🔒 兜底解析器也给同一个 handle', () => {
    const p = run('https://www.tiktok.com/@mrbeast', '<div>x</div>', { fallbackOnly: true })!;
    expect(p.platform).toBe('tiktok');
    expect(p.handle).toBe('mrbeast');
  });
});

// ── 「绝不凭空建账号」──
// YouTube 上真出过：/watch 页拿视频 ID 当频道 handle、/results 页拿 'results' 当 handle，
// 于是工作区共享的竞对库里多出几个不存在的频道。TikTok 靠「必须以 @ 开头」这一条挡住全部功能页。
describe('TikTok · 功能页一律不建账号', () => {
  it.each([
    ['推荐流', 'https://www.tiktok.com/foryou'],
    ['探索页', 'https://www.tiktok.com/explore'],
    ['话题页', 'https://www.tiktok.com/tag/fyp'],
    ['音乐页', 'https://www.tiktok.com/music/original-sound-123'],
    ['直播页', 'https://www.tiktok.com/live'],
    ['创作者后台', 'https://www.tiktok.com/tiktokstudio/content'],
    ['短链中转', 'https://www.tiktok.com/t/ZTabcdef'],
    ['首页', 'https://www.tiktok.com/'],
  ])('%s 解析为 null（站点解析器与兜底都是）', (_n, url) => {
    expect(run(url, '<h1>TikTok</h1>')).toBeNull();
    expect(run(url, '<h1>TikTok</h1>', { fallbackOnly: true })).toBeNull();
  });

  it('🔒 竞对链接解析同样不认功能页', () => {
    for (const u of ['https://www.tiktok.com/foryou', 'https://www.tiktok.com/tag/fyp', 'https://vm.tiktok.com/ZTabcdef']) {
      expect(parseCompetitorUrl(u)).toBeNull();
    }
  });
});

describe('TikTok · 主页采集', () => {
  const GRID = `
    <div data-e2e="user-post-item">
      <a href="https://www.tiktok.com/@mrbeast/video/${VID}"><img alt="I gave away a house" /></a>
      <strong data-e2e="video-views">1.2M</strong>
    </div>
    <div data-e2e="user-post-item">
      <a href="https://www.tiktok.com/@mrbeast/video/7222222222222222222"><img alt="second one" /></a>
      <strong data-e2e="video-views">340K</strong>
    </div>`;

  it('昵称 + 粉丝数 + 九宫格作品（含播放量）', () => {
    const p = run('https://www.tiktok.com/@mrbeast', `
      <h2 data-e2e="user-subtitle">MrBeast</h2>
      <strong data-e2e="followers-count">120.5M</strong>
      ${GRID}`)!;
    expect(p.platform).toBe('tiktok');
    expect(p.profile?.name).toBe('MrBeast');
    expect(p.profile?.followers).toBe(120_500_000);
    expect(p.posts).toHaveLength(2);
    expect(p.posts[0]).toMatchObject({
      platformItemId: VID,
      title: 'I gave away a house',
      url: `https://www.tiktok.com/@mrbeast/video/${VID}`,
      metrics: { views: 1_200_000 },
    });
  });

  it('同一条作品只入一次（九宫格里同 id 出现多次不重复计数）', () => {
    const p = run('https://www.tiktok.com/@mrbeast', GRID + GRID)!;
    expect(p.posts).toHaveLength(2);
  });

  it('水合数据在时补齐完整指标与发布时间（DOM 上只有播放量）', () => {
    const p = run('https://www.tiktok.com/@mrbeast', universal({
      'webapp.user-detail': { userInfo: { user: { nickname: '野兽先生' }, stats: { followerCount: 120500000 } } },
      ItemModule: {
        [VID]: { id: VID, desc: '完整文案', createTime: 1753000000, stats: { playCount: 1200000, diggCount: 90000, commentCount: 800, shareCount: 5000, collectCount: 300 } },
      },
    }) + GRID)!;
    expect(p.profile?.name).toBe('野兽先生');
    expect(p.posts[0].title).toBe('完整文案');
    expect(p.posts[0].metrics).toEqual({ views: 1_200_000, likes: 90_000, comments: 800, shares: 5_000, collects: 300 });
    expect(p.posts[0].publishedAt).toBe(new Date(1753000000 * 1000).toISOString());
  });

  it('🔒 水合数据说的是别的作品时**当没有**（否则 A 的播放量会写进 B 的记录）', () => {
    const p = run('https://www.tiktok.com/@mrbeast', universal({
      ItemModule: { '9999999999999999999': { id: '9999999999999999999', desc: '别人的作品', stats: { playCount: 999 } } },
    }) + GRID)!;
    expect(p.posts[0].title).toBe('I gave away a house');
    expect(p.posts[0].metrics).toEqual({ views: 1_200_000 }); // 只有 DOM 上那一项，没被串台
  });

  it('🔒 采不到指标也不报错，少几项照常回传', () => {
    const p = run('https://www.tiktok.com/@mrbeast', `
      <div data-e2e="user-post-item"><a href="/@mrbeast/video/${VID}"><img alt="no metrics" /></a></div>`)!;
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0].metrics).toBeUndefined();
  });
});

describe('TikTok · 作品详情页采集', () => {
  it('从水合数据读指标 + 作者昵称（昵称缺了竞对清单里显示的就是一串用户名）', () => {
    const p = run(`https://www.tiktok.com/@mrbeast/video/${VID}`, universal({
      'webapp.video-detail': {
        itemInfo: {
          itemStruct: {
            id: VID, desc: 'I gave away a house', createTime: 1753000000,
            author: { nickname: 'MrBeast' },
            stats: { playCount: 1200000, diggCount: 90000, commentCount: 800, shareCount: 5000 },
          },
        },
      },
    }))!;
    expect(p.handle).toBe('mrbeast');
    expect(p.profile?.name).toBe('MrBeast');
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0].metrics).toMatchObject({ likes: 90_000, comments: 800, shares: 5_000 });
    expect(p.posts[0].publishedAt).toBe(new Date(1753000000 * 1000).toISOString());
  });

  it('水合数据过期时退回 DOM（undefined-count 就是分享数，不是笔误）', () => {
    const p = run(`https://www.tiktok.com/@mrbeast/video/${VID}`, `
      <h1 data-e2e="browse-video-desc">DOM 上的文案</h1>
      <strong data-e2e="browse-like-count">90.1K</strong>
      <strong data-e2e="browse-comment-count">812</strong>
      <strong data-e2e="undefined-count">5,001</strong>`)!;
    expect(p.posts[0].title).toBe('DOM 上的文案');
    expect(p.posts[0].metrics).toMatchObject({ likes: 90_100, comments: 812, shares: 5_001 });
  });

  it('🔒 无文案作品的标题互不相同（一整列「(无文案)」会被标题查重误判成重复内容）', () => {
    const a = run('https://www.tiktok.com/@mrbeast/video/7111111111111111111', '<div>x</div>')!;
    const b = run('https://www.tiktok.com/@mrbeast/video/7222222222222222222', '<div>x</div>')!;
    expect(a.posts[0].title).not.toBe(b.posts[0].title);
    expect(a.posts[0].title.length).toBeGreaterThan(0);
  });
});

// ── isSelf：唯一挡住「把竞对的作品当成自己作品回填」的信号 ──
describe('TikTok · isSelf 只认阳性信号', () => {
  it('中英文界面的「编辑资料 / Edit profile」都认', () => {
    for (const label of ['编辑资料', 'Edit profile']) {
      const p = run('https://www.tiktok.com/@me', `<main><button>${label}</button></main>`)!;
      expect(p.isSelf).toBe(true);
    }
  });

  it('🔒 认不出时是 undefined 而不是 false（平台改版不该把功能变成打不开的门）', () => {
    const p = run('https://www.tiktok.com/@mrbeast', '<main><button>关注</button></main>')!;
    expect(p.isSelf).toBeUndefined();
  });
});

describe('TikTok · 发布链接解析', () => {
  it('作品页 → platformItemId', () => {
    const r = parsePublishUrl(`https://www.tiktok.com/@mrbeast/video/${VID}`);
    expect(r).toMatchObject({ ok: true, platform: 'tiktok', platformItemId: VID });
  });

  it.each([
    ['图文（photo）', `https://www.tiktok.com/@mrbeast/photo/${VID}`],
    ['带追踪参数', `https://www.tiktok.com/@mrbeast/video/${VID}?is_from_webapp=1&sender_device=pc`],
    ['嵌入页', `https://www.tiktok.com/embed/v2/${VID}`],
    ['旧版 m 站', `https://m.tiktok.com/v/${VID}.html`],
  ])('%s 也认得出同一个 ID', (_n, url) => {
    const r = parsePublishUrl(url);
    expect(r).toMatchObject({ ok: true, platform: 'tiktok', platformItemId: VID });
  });

  it('短链诚实降级（不跟随跳转），并且认得出是 TikTok', () => {
    const r = parsePublishUrl('https://vm.tiktok.com/ZTabcdef/');
    expect(r).toMatchObject({ ok: false, reason: 'shortlink', platform: 'tiktok' });
  });

  it('个人主页链接里没有作品 ID → 如实失败，不猜', () => {
    expect(parsePublishUrl('https://www.tiktok.com/@mrbeast')).toMatchObject({ ok: false, reason: 'no-item-id', platform: 'tiktok' });
  });

  it('publicItemUrl 只由 ID 决定，且形态过不了校验就返回 null', () => {
    expect(publicItemUrl('tiktok', VID)).toBe(`https://www.tiktok.com/embed/v2/${VID}`);
    expect(publicItemUrl('tiktok', 'not-a-number')).toBeNull();
    expect(publicItemUrl('tiktok', '')).toBeNull();
  });

  it('🔒 抖音链接绝不会被解析成 TikTok（ID 形态一样，全靠域名分）', () => {
    const r = parsePublishUrl(`https://www.douyin.com/video/${VID}`);
    expect(r).toMatchObject({ ok: true, platform: 'douyin' });
  });
});
