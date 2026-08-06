import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 抖音公开页解析的口径锁定。盯的是三类「不是少采而是采错」的事故：
//   ① 作品页把**评论者/推荐位作者**当成作品作者 → 这条作品被挂到别人名下；
//   ② 主页把「你可能感兴趣」里的作品当成本账号的作品 → 竞对的作品混进这个号的作品库；
//   ③ 卡片里第一个 span 是时长（00:38）而不是计数 → 入库一个假的 0，把均值系统性拉低。
// 少采一项永远好过采错一项（同 lib/adapters/competitor-real.ts idOrNull 的铁律）。

const SRC = ['common.js', 'douyin.js', 'douyin-video.js'].map((f) =>
  readFileSync(resolve(process.cwd(), 'extension/content', f), 'utf8'),
);

type Post = { platformItemId: string; title: string; url: string; publishedAt?: string; metrics?: Record<string, number> };
type Payload = { platform: string; handle: string; profile?: { name?: string; followers?: number }; posts: Post[] } | null;

function run(url: string, body: string): Payload {
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
  for (const s of SRC) vm.runInContext(s, ctx);
  return (ctx.__beaconParse as () => Payload)();
}

const UID = 'MS4wLjABAAAAauthor';
const VID = '7123456789012345678';

describe('抖音作品页 · 作者归属', () => {
  it('🔒 评论区里的用户链接排在前面，也不能被当成作者', () => {
    const p = run(`https://www.douyin.com/video/${VID}`, `
      <div data-e2e="comment-list">
        <a href="/user/MS4wLjABAAAAcommenter">路过的评论者</a>
      </div>
      <div data-e2e="video-detail">
        <a href="/user/${UID}" title="正主">正主</a>
      </div>
      <div data-e2e="video-desc">正文</div>`)!;
    expect(p.handle).toBe(UID);
    expect(p.profile?.name).toBe('正主');
  });

  it('🔒 推荐位里的作者链接同样排掉', () => {
    const p = run(`https://www.douyin.com/video/${VID}`, `
      <div data-e2e="related-video-card"><a href="/user/MS4wLjABAAAAother">别人</a></div>
      <div data-e2e="video-detail"><a href="/user/${UID}">正主</a></div>`)!;
    expect(p.handle).toBe(UID);
  });

  it('没有作者容器时退回全页，但仍排掉评论区', () => {
    const p = run(`https://www.douyin.com/video/${VID}`, `
      <div data-e2e="comment-list"><a href="/user/MS4wLjABAAAAcommenter">评论者</a></div>
      <div><a href="/user/${UID}">正主</a></div>`)!;
    expect(p.handle).toBe(UID);
  });

  it('一个作者链接都没有 → 如实返回 null（宁可不采，也不挂到错的号上）', () => {
    expect(run(`https://www.douyin.com/video/${VID}`, '<div data-e2e="video-desc">正文</div>')).toBeNull();
  });
});

describe('抖音作品页 · 字段补全', () => {
  it('作者昵称入 profile.name（缺了它竞对清单里显示的是 55 位 sec_user_id）', () => {
    const p = run(`https://www.douyin.com/video/${VID}`, `
      <div data-e2e="video-detail"><a href="/user/${UID}">@某抖音号</a></div>`)!;
    expect(p.profile?.name).toBe('某抖音号'); // 前导 @ 剥掉
  });

  it('绝对日期解析成 publishedAt', () => {
    const p = run(`https://www.douyin.com/video/${VID}`, `
      <div data-e2e="video-detail"><a href="/user/${UID}">正主</a></div>
      <div><div data-e2e="video-desc">正文</div><span>2026-07-01</span></div>`)!;
    expect(p.posts[0].publishedAt?.slice(0, 4)).toBe('2026');
  });

  it('🔒 相对时间（3天前）不猜——精度不够的值比没有值更坏', () => {
    const p = run(`https://www.douyin.com/video/${VID}`, `
      <div data-e2e="video-detail"><a href="/user/${UID}">正主</a></div>
      <div><div data-e2e="video-desc">正文</div><span>3天前</span></div>`)!;
    expect(p.posts[0].publishedAt).toBeUndefined();
  });

  it('无文案作品也有能认出来的标题（空标题会被标题查重误判成重复内容）', () => {
    const p = run(`https://www.douyin.com/video/${VID}`, `
      <div data-e2e="video-detail"><a href="/user/${UID}">正主</a></div>`)!;
    expect(p.posts[0].title.length).toBeGreaterThan(0);
    expect(p.posts[0].title).toContain(VID.slice(-4));
  });
});

describe('抖音主页 · 作品栅格', () => {
  it('只采本账号栅格里的作品，不采「你可能感兴趣」', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, `
      <div data-e2e="user-name">某抖音号</div>
      <ul data-e2e="user-post-list">
        <li><a href="/video/${VID}"><img alt="我的作品" /></a><span>1.2万</span></li>
      </ul>
      <ul data-e2e="user-recommend">
        <li><a href="/video/7999999999999999999"><img alt="别人的作品" /></a><span>9.9万</span></li>
      </ul>`)!;
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0].platformItemId).toBe(VID);
  });

  it('🔒 时长（00:38）不会被当成计数写进指标', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, `
      <ul data-e2e="user-post-list">
        <li><a href="/video/${VID}"><img alt="作品" /></a><span>00:38</span><span>1.2万</span></li>
      </ul>`)!;
    expect(Object.values(p.posts[0].metrics ?? {})).toEqual([12000]);
  });

  it('一个数字都读不到时不写指标（而不是写 0 覆盖真值）', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, `
      <ul data-e2e="user-post-list">
        <li><a href="/video/${VID}"><img alt="作品" /></a><span>00:38</span></li>
      </ul>`)!;
    expect(p.posts[0].metrics).toBeUndefined();
  });

  // ── 按 2026-07-29 真机截图复刻的页面结构 ──
  // 截图上能核对的事实：昵称「贾二宇」，关注 178 / 粉丝 328.3万 / 获赞 3023.8万，
  // 卡片角标是 **♡ 点赞**（9.7万 / 15.7万 / 6746），**文案在封面下方**（不在 img alt 里），
  // 前两张带「置顶」角标。
  const REAL_PAGE = `
    <h1 data-e2e="user-name">贾二宇</h1>
    <div class="stats">
      <div>关注 178</div><div>粉丝 328.3万</div><div>获赞 3023.8万</div>
    </div>
    <p>抖音号：117847840 IP属地：辽宁</p>
    <p>感谢支持。卫RY6688789 看啥呢 不关注我?</p>
    <ul data-e2e="user-post-list">
      <li>
        <a href="/video/7667149063540973962">
          <div><span>置顶</span></div><img alt="" /><span>9.7万</span>
        </a>
        <div>小时候的离奇事件 全 #悬疑#…</div>
      </li>
      <li>
        <a href="/video/7667149063540973963"><img alt="" /><span>6746</span></a>
        <div>人面熊传说#悬疑#恐怖#剧情…</div>
      </li>
    </ul>`;

  it('真机结构：昵称 / 粉丝数 / 点赞角标 / 封面下方文案都取得到', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, REAL_PAGE)!;
    expect(p.profile?.name).toBe('贾二宇');
    expect(p.profile?.followers).toBe(3_283_000);
    expect(p.posts).toHaveLength(2);
    expect(p.posts[0].title).toBe('小时候的离奇事件 全 #悬疑#…');
    expect(p.posts[0].metrics).toEqual({ likes: 97_000 });
    expect(p.posts[1].title).toBe('人面熊传说#悬疑#恐怖#剧情…');
    expect(p.posts[1].metrics).toEqual({ likes: 6746 });
  });

  it('🔒 「关注 178」绝不能被当成粉丝数（三个数字挨着，取错差三个数量级）', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, REAL_PAGE)!;
    expect(p.profile?.followers).not.toBe(178);
  });

  it('🔒 「置顶」角标不会被当成标题，也不会被当成计数', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, REAL_PAGE)!;
    expect(p.posts[0].title).not.toBe('置顶');
    expect(p.posts[0].metrics?.likes).toBe(97_000);
  });

  it('🔒 栅格不用 <li>（div 卡片）时照样逐条采，而不是只采到第一条', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, `
      <div data-e2e="user-post-list">
        <div><a href="/video/7111111111111111111"><span>1.1万</span></a><div>作品一</div></div>
        <div><a href="/video/7222222222222222222"><span>2.2万</span></a><div>作品二</div></div>
        <div><a href="/video/7333333333333333333"><span>3.3万</span></a><div>作品三</div></div>
      </div>`)!;
    expect(p.posts.map((x) => x.platformItemId)).toEqual([
      '7111111111111111111', '7222222222222222222', '7333333333333333333',
    ]);
  });

  it('🔒 中间多包一层壳也能拆开（容器被当成行 = 一屏作品只入库第一条）', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, `
      <div data-e2e="user-post-list">
        <div class="wrap">
          <div><a href="/video/7111111111111111111"><span>1.1万</span></a><div>作品一</div></div>
          <div><a href="/video/7222222222222222222"><span>2.2万</span></a><div>作品二</div></div>
        </div>
      </div>`)!;
    expect(p.posts).toHaveLength(2);
  });

  it('同一条作品在栅格里出现两次也只入一次', () => {
    const p = run(`https://www.douyin.com/user/${UID}`, `
      <ul data-e2e="user-post-list">
        <li><a href="/video/${VID}"><img alt="作品" /></a><span>1.2万</span></li>
        <li><a href="/video/${VID}?modal_id=1"><img alt="作品" /></a><span>1.2万</span></li>
      </ul>`)!;
    expect(p.posts).toHaveLength(1);
  });
});
