import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 翻页采集（滚动加载更多作品）──
//
// 这些站点的作品栅格是懒加载的：首屏只渲染 18–20 张卡片，剩下的要往下滚才请求。
// 于是「采集本页」一直只采到首屏那点东西——一个 478 条作品的抖音号也只采到 20 条。
//
// 这份测试盯四件事：
//   ① 真的会翻页，直到够 50 条 / 不再长 / 超预算；
//   ② **50 是硬上限**——服务端 `posts.max(50)`，超一条是整批被打回而不是多的被丢；
//   ③ 虚拟列表把卡片回收掉、条数暂时变少时，不能拿它覆盖已经采到的；
//   ④ 采完把滚动位置还回去，且**不滚用户正在看的页面**（只在 deep 或后台标签页时滚）。

const COMMON_SRC = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');
const DOUYIN_SRC = readFileSync(resolve(process.cwd(), 'extension/content/douyin.js'), 'utf8');

const UID = 'MS4wLjABAAAAdemo';

// ⚠️ 作品 ID 必须**当字符串拼**：抖音的 aweme_id 是 19 位，远超 Number.MAX_SAFE_INTEGER，
// 用 `7000000000000000000 + i` 算出来的相邻若干个 i 会得到**同一个数**，
// 于是所有卡片撞成一个 ID、被解析器按去重折成 1 条——测试自己造出一个假象。
function card(i: number): string {
  const id = `7${String(i).padStart(18, '0')}`;
  return `<li><a href="/video/${id}"><img alt="作品${i}" /></a><span>${i}00</span></li>`;
}

type Harness = {
  ctx: vm.Context;
  win: JSDOM['window'];
  /** 当前渲染出来的卡片数 */
  rendered: () => number;
};

/**
 * 造一个「往下滚就多渲染一屏」的页面。
 * `pool` 是这个号总共有多少作品，`perScreen` 是每次加载多少张。
 */
function harness(pool: number, perScreen = 18, opts: { hidden?: boolean } = {}): Harness {
  const dom = new JSDOM(
    `<html><body><div data-e2e="user-name">某抖音号</div><ul data-e2e="user-post-list"></ul></body></html>`,
    { url: `https://www.douyin.com/user/${UID}`, pretendToBeVisual: true },
  );
  const { window: win } = dom;
  const list = win.document.querySelector('[data-e2e="user-post-list"]')!;
  let shown = 0;
  const render = (n: number) => {
    const next = Math.min(pool, shown + n);
    for (let i = shown; i < next; i++) list.insertAdjacentHTML('beforeend', card(i));
    shown = next;
  };
  render(perScreen); // 首屏

  // jsdom 没有真实布局：scrollIntoView / scrollBy 都是空实现。
  // 这里把它们接上「再渲染一屏」，模拟真实页面的懒加载。
  win.Element.prototype.scrollIntoView = function scrollIntoView() { render(perScreen); };
  Object.defineProperty(win.document, 'hidden', { get: () => opts.hidden === true, configurable: true });

  const ctx = vm.createContext({
    document: win.document,
    location: win.location,
    window: win,
    CSS: win.CSS ?? { escape: (s: string) => s },
    URL: win.URL,
    URLSearchParams: win.URLSearchParams,
    console,
    setTimeout,
    chrome: {
      runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) },
      storage: { sync: { get: () => Promise.resolve({}) } },
    },
  });
  vm.runInContext(COMMON_SRC, ctx);
  vm.runInContext(DOUYIN_SRC, ctx);
  return { ctx, win, rendered: () => shown };
}

type Payload = { posts: { platformItemId: string }[] };
const deepCollect = (h: Harness) =>
  (h.ctx.__beaconCollectDeep as (p: () => Payload) => Promise<Payload>)(h.ctx.__beaconParse as () => Payload);

describe('翻页采集', () => {
  it('首屏只有 18 条时，浅采就是 18 条（没翻页前的现状）', () => {
    const h = harness(200);
    expect((h.ctx.__beaconParse as () => Payload)().posts).toHaveLength(18);
  });

  it('翻页后采到 50 条（服务端单次上限）', async () => {
    const h = harness(200);
    const p = await deepCollect(h);
    expect(p.posts).toHaveLength(50);
    expect(new Set(p.posts.map((x) => x.platformItemId)).size).toBe(50); // 无重复
  }, 20000);

  it('🔒 绝不超过 50 条——服务端 posts.max(50)，超一条是**整批**被 zod 打回', async () => {
    const h = harness(500, 40);
    const p = await deepCollect(h);
    expect(p.posts.length).toBeLessThanOrEqual(50);
  }, 20000);

  it('作品总数不足 50 时，翻到底就停（不空转到超时）', async () => {
    const h = harness(25);
    const started = Date.now();
    const p = await deepCollect(h);
    expect(p.posts).toHaveLength(25);
    expect(Date.now() - started).toBeLessThan(20000); // 连着两轮不长就收手，不会耗满 30 秒预算
  }, 25000);

  it('页面根本不加载更多时也会停，并保留首屏采到的', async () => {
    const h = harness(18, 18);
    const p = await deepCollect(h);
    expect(p.posts).toHaveLength(18);
  }, 25000);

  it('🔒 虚拟列表把卡片回收掉、条数变少时，不拿它覆盖已经采到的', async () => {
    const h = harness(60);
    // 翻两轮之后把列表清空，模拟虚拟列表回收
    let calls = 0;
    const shrinking = () => {
      calls += 1;
      const p = (h.ctx.__beaconParse as () => Payload)();
      if (calls === 3) h.win.document.querySelector('[data-e2e="user-post-list"]')!.innerHTML = '';
      return p;
    };
    const p = await (h.ctx.__beaconCollectDeep as (f: () => Payload) => Promise<Payload>)(shrinking);
    expect(p.posts.length).toBeGreaterThan(0);
  }, 25000);

  it('🔒 采完把滚动位置还回去（用户切回来还在原地）', async () => {
    const h = harness(200);
    // jsdom 不实现 scrollingElement，common.js 会退到 documentElement（`|| document.documentElement`）
    const el = (h.win.document.scrollingElement ?? h.win.document.documentElement) as HTMLElement;
    el.scrollTop = 640;
    await deepCollect(h);
    expect(el.scrollTop).toBe(640);
  }, 20000);
});

describe('翻页采集的触发条件', () => {
  // beaconRunCollect 是 module 级函数，这里直接验消息层的判据：
  // deep 只在「用户显式点了采集」或「页面在后台标签页里」时为真。
  it('🔒 用户正看着的页面不主动滚——只有 deep:true 或 document.hidden 才翻页', () => {
    const m = COMMON_SRC.match(/const deep = ([^;]+);/);
    expect(m, 'common.js 里应有 deep 判据').toBeTruthy();
    expect(m![1]).toContain('msg.deep === true');
    expect(m![1]).toContain('document.hidden');
  });

  it('🔒 创作者后台不翻页（那儿是分页按钮，且 self-backend 解析一次要扫整张表）', () => {
    expect(COMMON_SRC).toMatch(/deep && !globalThis\.__beaconSelfOnly/);
  });

  it('🔒 消息处理器 return true，否则异步 sendResponse 发不出去（按钮永远停在「采集中…」）', () => {
    const branch = COMMON_SRC.slice(COMMON_SRC.indexOf("if (msg?.type !== 'beacon-collect')"));
    expect(branch.slice(0, 800)).toMatch(/return true;/);
  });
});

describe('作品条数上限', () => {
  it('🔒 插件的上限与服务端 posts.max(50) 一致（各解析器不许各写各的数字）', () => {
    const server = readFileSync(resolve(process.cwd(), 'lib/ingest/competitor.ts'), 'utf8');
    const self = readFileSync(resolve(process.cwd(), 'lib/ingest/own-post.ts'), 'utf8');
    const serverMax = Number(server.match(/posts: z\.array\(postSchema\)[^\n]*?\.max\((\d+)\)/)![1]);
    const selfMax = Number(self.match(/posts: z\.array\(postSchema\)[^\n]*?\.max\((\d+)\)/)![1]);
    const pluginCap = Number(COMMON_SRC.match(/const BEACON_POST_CAP = (\d+);/)![1]);
    expect(pluginCap).toBeLessThanOrEqual(serverMax);
    expect(pluginCap).toBeLessThanOrEqual(selfMax);
  });

  it('🔒 每个站点解析器都用共享上限，没有写死的数字', () => {
    for (const f of ['bilibili.js', 'douyin.js', 'x.js', 'tiktok.js', 'youtube.js', 'xhs.js']) {
      const src = readFileSync(resolve(process.cwd(), 'extension/content', f), 'utf8');
      const caps = src.match(/posts\.length >= [^\n]+/g) ?? [];
      expect(caps.length, `${f} 应该有作品条数上限`).toBeGreaterThan(0);
      for (const c of caps) expect(c, `${f} 的上限应走 __beaconPostCap`).toContain('__beaconPostCap');
    }
  });
});
