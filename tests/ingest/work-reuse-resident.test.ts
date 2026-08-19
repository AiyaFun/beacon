import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 「一键拆解」不再自己维护第三套选择器，改为**优先复用常驻解析器**（`globalThis.__beaconParse`）。
//
// 起因：work.js 的 RULES 是这个仓库里第三套选择器（主页一套、详情页一套、它一套），
// 而每轮真机校准都发生在详情页那一层，它从来没跟上过。2026-08-13 一次抓到三条：
// 抖音新埋点没跟、TikTok 分享数写了个线上不存在的选择器、YouTube/X 干脆 `metrics: {}`
// ——拆解报告里没有任何量级信息，模型只能凭标题和封面猜「这条为什么爆」。
//
// 与其再抄一套（抄完下一轮照样漂），不如用已经校准好的那套：这六个平台的作品页上
// `__beaconParse` 都是 manifest 声明式常驻的，work.js 走 executeScript 注入、同一个隔离世界，
// 读得到（comments.js:525 早就在这么用）。
//
// 这份用例守两条边界：
//   ① 必须确认是**同一条作品**——列表页的 __beaconParse 会返回一整页，拿错一条比没有更糟；
//   ② 只让常驻解析器赢**指标**，不让它赢标题/作者（详情页解析器在标题为空时会给
//      `[作品] #xxxx` 这类占位，让它盖掉一个真标题是倒退）。

const SRC = readFileSync(resolve(process.cwd(), 'extension/content/work.js'), 'utf8');

type Parsed = { platform: string; profile?: { name?: string } | null; posts: Record<string, unknown>[] };

async function run(url: string, html: string, residentParse?: () => Parsed | null) {
  const dom = new JSDOM(html, { url });
  const ctx: Record<string, unknown> = {
    location: dom.window.location,
    document: dom.window.document,
    fetch: () => Promise.reject(new Error('no network in test')),
    createImageBitmap: () => Promise.reject(new Error('no canvas in test')),
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, isFinite, parseFloat,
    console, setTimeout,
  };
  ctx.globalThis = ctx;
  if (residentParse) ctx.__beaconParse = residentParse;
  vm.createContext(ctx);
  return (await vm.runInContext(SRC, ctx)) as {
    metrics: Record<string, number>;
    author: string;
    title: string;
  };
}

// YouTube watch 页：work.js 自己的 RULES 对 YouTube 是 `metrics: {}`，
// 而 youtube.js 能从内联脚本拿到精确播放量、从 aria-label 拿到点赞。
const YT_HTML = '<body><h1 class="ytd-watch-metadata">视频标题</h1></body>';
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const ytParse = (over: Partial<Parsed> = {}): Parsed => ({
  platform: 'youtube',
  profile: { name: '某频道' },
  posts: [{
    platformItemId: 'dQw4w9WgXcQ',
    title: '视频标题',
    metrics: { views: 1_802_557_814, likes: 1_522_682, comments: 2_300_000 },
  }],
  ...over,
});

describe('work.js · 优先复用常驻解析器的指标', () => {
  it('🔒 YouTube：本地一个指标都没有，复用后拿到精确播放量/点赞', async () => {
    const before = await run(YT_URL, YT_HTML);
    expect(before.metrics, '前提变了：work.js 现在自己能采 YouTube 指标了？那这条用例要重写')
      .toEqual({});

    const after = await run(YT_URL, YT_HTML, () => ytParse());
    expect(after.metrics.views).toBe(1_802_557_814);
    expect(after.metrics.likes).toBe(1_522_682);
  });

  it('🔒 认不出是哪一条就整个放弃——列表页返回一整页时绝不拿第一条', async () => {
    const many: Parsed = {
      platform: 'youtube',
      profile: { name: '某频道' },
      posts: [
        { platformItemId: 'aaaaaaaaaaa', title: '别的视频', metrics: { views: 11 } },
        { platformItemId: 'bbbbbbbbbbb', title: '又一个', metrics: { views: 22 } },
      ],
    };
    const r = await run(YT_URL, YT_HTML, () => many);
    expect(r.metrics, '当前地址是 dQw4w9WgXcQ，两条都对不上，一个数都不该拿').toEqual({});
  });

  // ⚠️ 上一条走的是「URL 里有 ID → find 比对」那条分支。**没有 ID 时的兜底是另一条分支**，
  //    而它正是最容易被写成「先凑合拿第一条」的地方（mutation 验过：只测上一条的话，
  //    把兜底改成 posts[0] 照样全绿）。频道页/主页这类地址就没有作品 ID。
  it('🔒 URL 里根本没有作品 ID + 常驻返回多条 → 同样整个放弃，不拿第一条', async () => {
    const many: Parsed = {
      platform: 'youtube',
      profile: { name: '某频道' },
      posts: [
        { platformItemId: 'aaaaaaaaaaa', title: '视频一', metrics: { views: 11 } },
        { platformItemId: 'bbbbbbbbbbb', title: '视频二', metrics: { views: 22 } },
      ],
    };
    const r = await run('https://www.youtube.com/@someone', '<body><h1 class="title">频道</h1></body>', () => many);
    expect(r.metrics, '认不出是哪一条，一个数都不该拿').toEqual({});
  });

  it('URL 没有作品 ID 但常驻只返回一条 → 那就是它，可以用', async () => {
    const one: Parsed = {
      platform: 'youtube',
      profile: { name: '某频道' },
      posts: [{ platformItemId: 'aaaaaaaaaaa', title: '就这一条', metrics: { views: 42 } }],
    };
    const r = await run('https://www.youtube.com/@someone', '<body><h1 class="title">频道</h1></body>', () => one);
    expect(r.metrics.views).toBe(42);
  });

  it('列表页里**有**当前这一条时，按 ID 精确挑出它', async () => {
    const mixed: Parsed = {
      platform: 'youtube',
      profile: { name: '某频道' },
      posts: [
        { platformItemId: 'aaaaaaaaaaa', title: '别的视频', metrics: { views: 11 } },
        { platformItemId: 'dQw4w9WgXcQ', title: '视频标题', metrics: { views: 999 } },
      ],
    };
    const r = await run(YT_URL, YT_HTML, () => mixed);
    expect(r.metrics.views).toBe(999);
  });

  it('逐键合并：常驻解析器没给的键，用本地那套补上', async () => {
    // B站：work.js 本地能从 .view.item 读到播放量；常驻解析器只给点赞
    const bili = '<body><h1 class="video-title">标题</h1><div class="view item">1.2万</div></body>';
    const r = await run('https://www.bilibili.com/video/BV1xx411c7mD', bili, () => ({
      platform: 'bilibili',
      posts: [{ platformItemId: 'BV1xx411c7mD', title: '标题', metrics: { likes: 777 } }],
    }));
    expect(r.metrics.likes, '常驻解析器给的').toBe(777);
    expect(r.metrics.views, '常驻没给，本地补上的').toBe(12000);
  });

  it('🔒 标题/作者本地取得到就用本地的，不让占位标题盖掉真标题', async () => {
    const r = await run(YT_URL, YT_HTML, () => ytParse({
      profile: { name: '常驻给的频道名' },
      posts: [{ platformItemId: 'dQw4w9WgXcQ', title: '[作品] #cXcQ', metrics: { views: 5 } }],
    }));
    expect(r.title, '本地 h1 有真标题，不该被占位串盖掉').toBe('视频标题');
  });

  it('本地取不到作者时才退给常驻解析器（抖音第三层兜底就靠这条）', async () => {
    const r = await run(YT_URL, YT_HTML, () => ytParse());
    expect(r.author, 'work.js 的 youtube 作者选择器在这份 DOM 上取不到 → 用常驻的').toBe('某频道');
  });

  it('常驻解析器不在、返回 null、或自己抛异常 → 一律安静退回本地那套，不拖垮拆解', async () => {
    for (const parse of [undefined, () => null, () => { throw new Error('boom'); }]) {
      const bili = '<body><h1 class="video-title">标题</h1><div class="view item">1.2万</div></body>';
      const r = await run('https://www.bilibili.com/video/BV1xx411c7mD', bili, parse as never);
      expect(r.metrics.views).toBe(12000);
      expect(r.title).toBe('标题');
    }
  });
});
