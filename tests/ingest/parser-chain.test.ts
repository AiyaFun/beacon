import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 主页解析器不能被作品页脚本覆盖掉 ──
//
// 【这条测试为什么存在】2026-07-29 发现：抖音/B站/小红书的**主页解析器整个是死代码**。
//
// manifest 里这三家都是「主页 + 作品页」共用**一条** content_scripts 规则：
//   { matches: [".../user/*", ".../video/*"], js: ["common.js", "douyin.js", "douyin-video.js"] }
// js 数组按序执行，所以作品页脚本永远后跑。它当时直接写 `globalThis.__beaconParse = …`，
// 于是在 /user/ 主页上，最终生效的是**作品页解析器**——它一看路径不是 /video/ 就返回 null，
// common.js 随即退回 beaconFallbackParse，产出「1 条以 sec_user_id 当作品 ID、
// 零指标、作者名写着『小红书/社交创作者』的假作品」，后端因为没有任何指标直接跳过。
// 用户看到的现象就是「主页采不全 / 采到 0 条」，而日志里没有任何报错。
//
// 修法是接力（保存上一个 __beaconParse，路径不匹配时回落给它）。这条测试钉死的是**行为**：
// 同一条规则里的脚本按 manifest 顺序全部注入后，主页 URL 必须走到主页解析器。
// 不测「源码里有没有写 prev」——那种写法挡不住「写了但写错」。

type Payload = { platform: string; handle: string; posts: unknown[]; profile?: { name?: string } } | null;

function readManifestEntry(host: string): string[] {
  const mf = JSON.parse(readFileSync(resolve(process.cwd(), 'extension/manifest.json'), 'utf8'));
  const entry = mf.content_scripts.find((c: { matches: string[] }) => c.matches.some((m) => m.includes(host)));
  expect(entry, `manifest 里没有匹配 ${host} 的 content_scripts 规则`).toBeTruthy();
  return entry.js as string[];
}

/** 按 manifest 声明的顺序注入整条规则的脚本，再跑 __beaconParse —— 与浏览器里的真实情况一致 */
function parseWithManifestOrder(host: string, url: string, body: string): Payload {
  const files = readManifestEntry(host);
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
  for (const f of files) vm.runInContext(readFileSync(resolve(process.cwd(), 'extension', f), 'utf8'), ctx);
  return (ctx.__beaconParse as () => Payload)();
}

describe('🔒 同一条 content_scripts 规则里，作品页脚本不许吃掉主页解析器', () => {
  it('抖音主页：解析出真实作品，而不是退回兜底的假作品', () => {
    const p = parseWithManifestOrder('douyin.com', 'https://www.douyin.com/user/MS4wLjABAAAAdemo', `
      <div data-e2e="user-name">某抖音号</div>
      <ul data-e2e="user-post-list">
        <li><a href="https://www.douyin.com/video/7123456789012345678"><img alt="作品一" /></a><span>1.2万</span></li>
        <li><a href="https://www.douyin.com/video/7222222222222222222"><img alt="作品二" /></a><span>3400</span></li>
      </ul>`)!;
    expect(p.platform).toBe('douyin');
    expect(p.handle).toBe('MS4wLjABAAAAdemo');
    expect(p.profile?.name).toBe('某抖音号');
    expect(p.posts).toHaveLength(2);
    // 兜底解析的特征：作品 ID == 账号 handle、作者名是那句写死的兜底文案
    expect((p.posts[0] as { platformItemId: string }).platformItemId).not.toBe(p.handle);
    expect(p.profile?.name).not.toBe('小红书/社交创作者');
  });

  it('抖音作品页：仍然由作品页解析器接管（接力没有反过来吃掉后者）', () => {
    const p = parseWithManifestOrder('douyin.com', 'https://www.douyin.com/video/7123456789012345678', `
      <div data-e2e="video-detail"><a href="/user/MS4wLjABAAAAdemo">某抖音号</a></div>
      <div data-e2e="video-desc">正文文案</div>
      <span data-e2e="like-count">3.4万</span>`)!;
    expect(p.posts).toHaveLength(1);
    expect((p.posts[0] as { platformItemId: string }).platformItemId).toBe('7123456789012345678');
  });

  it('B站空间页：解析出 UP 主身份，而不是退回兜底', () => {
    const p = parseWithManifestOrder('space.bilibili.com', 'https://space.bilibili.com/12345678', `
      <div id="h-name">某UP主</div>`)!;
    expect(p.platform).toBe('bilibili');
    expect(p.handle).toBe('12345678');
    expect(p.profile?.name).toBe('某UP主');
  });

  it('B站视频页：仍然由视频页解析器接管', () => {
    const p = parseWithManifestOrder('bilibili.com', 'https://www.bilibili.com/video/BV1xx411c7mD', `
      <a class="up-name" href="https://space.bilibili.com/12345678">某UP主</a>
      <h1 class="video-title">标题</h1>`)!;
    expect((p.posts[0] as { platformItemId: string }).platformItemId).toBe('BV1xx411c7mD');
  });

  it('小红书主页：解析出用户身份，而不是退回兜底', () => {
    const p = parseWithManifestOrder('xiaohongshu.com', 'https://www.xiaohongshu.com/user/profile/5ff0a1b2000000000101abcd', `
      <div class="user-name">某博主</div>`)!;
    expect(p.platform).toBe('xiaohongshu');
    expect(p.handle).toBe('5ff0a1b2000000000101abcd');
  });

  it('小红书笔记页：仍然由笔记页解析器接管', () => {
    const p = parseWithManifestOrder('xiaohongshu.com', 'https://www.xiaohongshu.com/explore/64f1a2b3000000001203abcd', `
      <a href="/user/profile/5ff0a1b2000000000101abcd">某博主</a>
      <div id="detail-title">笔记标题</div>`)!;
    expect((p.posts[0] as { platformItemId: string }).platformItemId).toBe('64f1a2b3000000001203abcd');
  });
});
