import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 「页面上显示的数」和「真实的数」不是一回事 —— 2026-08-10 四平台真机抽验。
//
// 各平台在正文里印的都是**四舍五入后的展示值**：
//   · YouTube「18亿次观看」→ 存成 1,800,000,000，真值 1,802,557,814（差 255 万）
//   · B站「1.0亿」→ 存成 100,000,000，真值 102,372,046（差 237 万）
//   · X「217万」→ 但 X 的 aria-label 里给的是精确的 2174478
// 误差本身还不是最要命的，最要命的是**它不动**：一个停在「18亿」的数字，
// 两次采集之间永远相等，趋势/增速那一整套就等于废了（小号更狠，
// 「1.2万次观看」的真值可能是 12000~12999，天然 8% 误差）。
//
// 能不能拿到精确值**逐平台不同**，必须逐平台真机确认，不能想当然：
//   · YouTube ✅ `"viewCount":"1802557814"` 就在内联 <script> 里 → document.scripts 能读，
//     而内容脚本读 DOM 不受隔离世界限制（读的是脚本标签的文本，不是页面 JS 变量）
//   · B站   ❌ 精确值只在 `window.__INITIAL_STATE__` 这个**页面上下文变量**里，
//     内联脚本里正则不出来（实测 84KB 脚本内无 "view": 数字），
//     内容脚本读不到 —— 见 [[beacon-extension-isolated-world]]。只能拿展示值，这是真实限制。
//   · X      ✅ 本来就从 aria-label 取精确值，是唯一一直做对的

const COMMON = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');
const YT = readFileSync(resolve(process.cwd(), 'extension/content/youtube.js'), 'utf8');
const X = readFileSync(resolve(process.cwd(), 'extension/content/x.js'), 'utf8');
const BILI_VIDEO = readFileSync(resolve(process.cwd(), 'extension/content/bili-video.js'), 'utf8');

type Payload = {
  platform: string;
  posts: { platformItemId: string; metrics?: Record<string, number> }[];
} | null;

function run(src: string, url: string, body: string): Payload {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    URLSearchParams: dom.window.URLSearchParams,
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    console, setTimeout,
  });
  vm.runInContext(COMMON, context);
  vm.runInContext(src, context);
  return (context.__beaconParse as () => Payload)();
}

// ── YouTube：真机 dQw4w9WgXcQ 的形态 ──
// 正文里印「18亿次观看」，而内联脚本里有精确的 1802557814
const YT_BODY = (opts: { script?: boolean } = {}) => `
  <h1 class="ytd-watch-metadata">Never Gonna Give You Up</h1>
  <ytd-video-owner-renderer><a href="/@RickAstleyYT">Rick Astley</a></ytd-video-owner-renderer>
  <ytd-watch-metadata>
    <ytd-watch-info-text><span>18亿次观看</span></ytd-watch-info-text>
  </ytd-watch-metadata>
  <like-button-view-model><button aria-label="与另外 19,325,834 人一起顶此视频"></button></like-button-view-model>
  ${opts.script === false ? '' : `<script>var ytInitialPlayerResponse = {"videoDetails":{"viewCount":"1802557814"},"likeCount":"19325834"};</script>`}
`;

describe('🔒 YouTube · 播放量要取精确值，不要页面上那个四舍五入的', () => {
  it('内联脚本里有 viewCount 时以它为准（18亿 → 1,802,557,814）', () => {
    const p = run(YT, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', YT_BODY());
    expect(p?.posts?.[0]?.metrics?.views).toBe(1802557814);
  });

  it('🔒 绝不能是 1800000000（那是把「18亿」当真值）', () => {
    const p = run(YT, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', YT_BODY());
    expect(p?.posts?.[0]?.metrics?.views).not.toBe(1800000000);
  });

  it('脚本里没有时退回页面展示值，不是整项丢掉', () => {
    const p = run(YT, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', YT_BODY({ script: false }));
    expect(p?.posts?.[0]?.metrics?.views).toBe(1800000000);
  });

  it('点赞照旧从 aria-label 取精确值', () => {
    const p = run(YT, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', YT_BODY());
    expect(p?.posts?.[0]?.metrics?.likes).toBe(19325834);
  });
});

// ── X：真机推文的操作栏形态。aria-label 里是精确值，可见文本是「12万」这种缩写 ──
const X_BODY = `
  <article data-testid="tweet" tabindex="-1">
    <div data-testid="User-Name"><a href="/elonmusk"><span>@elonmusk</span></a></div>
    <div data-testid="tweetText">the bird is freed</div>
    <a href="https://x.com/elonmusk/status/1585841080431321088"><time datetime="2022-10-28T03:49:00.000Z"></time></a>
    <div role="group" aria-label="121721 回复、346200 次转帖、2174478 喜欢、8249 书签">
      <button data-testid="reply" aria-label="121721 回复。回复">12万</button>
      <button data-testid="retweet" aria-label="346200 次转帖。转帖">34万</button>
      <button data-testid="like" aria-label="2174478 喜欢次数。喜欢">217万</button>
      <button data-testid="bookmark" aria-label="8249 书签。加入书签">8,249</button>
    </div>
  </article>
`;

describe('X · 从 aria-label 取精确值（一直做对的那个）', () => {
  const m = () => run(X, 'https://x.com/elonmusk/status/1585841080431321088', X_BODY)?.posts?.[0]?.metrics ?? {};

  it('回复/转帖/点赞都是精确值，不是可见文本里的「12万」', () => {
    expect(m().comments).toBe(121721);
    expect(m().shares).toBe(346200);
    expect(m().likes).toBe(2174478);
  });

  it('🔒 点赞不许是 2170000（那是把「217万」当真值）', () => {
    expect(m().likes).not.toBe(2170000);
  });

  it('书签数要采（映射到收藏）——页面上有，此前整项没采', () => {
    expect(m().collects).toBe(8249);
  });

  it('🔒 浏览量拿不到时是「没有这一项」，不是 0', () => {
    // 真机实测：X 详情页页脚只有 回复/转帖/喜欢/书签，浏览量已不显示，
    // 且 a[href*="/analytics"] 不存在。缺席必须表现为「键不存在」，
    // 让下游的 hasViews() 判定成「不知道」而不是「零次浏览」。
    expect(m().views).toBeUndefined();
  });
});

// ── B站：能拿到的只有展示值，这是真实限制，测试把它钉成「已知且刻意」──
const BILI_BODY = `
  <h1 class="video-title">Never Gonna Give You Up</h1>
  <div class="up-info"><a href="//space.bilibili.com/703679656">Rick Astley</a></div>
  <div class="video-info-detail">
    <div class="view item">1.0亿</div><div class="dm item">14.6万</div>
  </div>
  <div class="video-toolbar-left">
    <div class="video-like-info">283.5万</div>
    <div class="video-coin-info">123.8万</div>
    <div class="video-fav-info">149.2万</div>
    <div class="video-share-info-text">47.4万</div>
  </div>
`;

describe('B站 · 六项指标解析（真机 BV1GJ411x7h7 校准）', () => {
  const m = () => run(BILI_VIDEO, 'https://www.bilibili.com/video/BV1GJ411x7h7', BILI_BODY)?.posts?.[0]?.metrics ?? {};

  it('六项全部命中', () => {
    expect(m()).toMatchObject({
      views: 100000000, danmaku: 146000, likes: 2835000,
      coins: 1238000, collects: 1492000, shares: 474000,
    });
  });

  it('⚠️ 已知限制：拿到的是展示值（真值 102,372,046 只在页面 JS 变量里，内容脚本读不到）', () => {
    // 这条不是「测对了」，是把限制写下来：哪天有人以为播放量是精确的，先看这里。
    // 要精确值只能走 B站 公开 API，那是另一个决定（需要 host 权限 + 合规评估）。
    expect(m().views).toBe(100000000);
    expect(m().views).not.toBe(102372046);
  });

  it('🔒 评论数选择器不许再只认已经消失的 bili-comments-header-renderer', () => {
    // 真机实测：bili-comments 的 shadowRoot 里只有 #spinner-container / #title /
    // bili-comments-spinner / #continuations，那个 header-renderer 元素**已经不存在**，
    // 于是这条路径恒取不到。改成多路径尝试，能多拿一条是一条。
    // 规则是「不能**只有**那一条」，不是「不许出现」——旧路径留作兜底是对的。
    // 判据：必须存在「直接在 shadowRoot 上取 #count」这条不依赖 header-renderer 的路径。
    expect(BILI_VIDEO).toMatch(/sr\.querySelector\('#count'\)/);
    expect(BILI_VIDEO).toContain('#title');
  });
});
