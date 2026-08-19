import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// work.js（「一键拆解这条作品」）的取数**必须能限定作用域**。
//
// 2026-08-13 查出来的问题：它的 pick() 一直是裸的 `document.querySelector`，而 08-08 那轮
// 小红书真机校准的核心结论恰恰相反——explore modal 打开时背景瀑布流仍在 DOM 里，
// 全局取 `.like-wrapper .count` 命中的是**背景卡片**（xhs-note.js 文件头记的实测：取到 4，
// 真值 159）；作者链接全局第一条是左侧栏「我」，取到的是用户自己。
//
// 这条坏得很隐蔽：不报错，数字本身也完全正常。而 lib/video/analyze.ts:187 会把这些数
// 拼成「页面上的公开数据：…」喂给模型——**拆解报告会引用另一条笔记的数据下结论**。
// 「采不到」只是少一块信息，「采到隔壁那条的数」是拿错数据当证据，性质不同。
//
// 所以这份用例搭的是**真实的串台 DOM**（背景卡片 + 侧栏「我」 + 前景笔记），
// 验的是取数结果，而不是「源码里有没有出现某个字符串」。

const SRC = readFileSync(resolve(process.cwd(), 'extension/content/work.js'), 'utf8');

// 小红书 explore modal 的最小复现：背景瀑布流的一张卡（赞 4）+ 左侧栏「我」+ 前景笔记（赞 159）
const XHS_HTML = `
<body>
  <div class="feeds-container">
    <a class="note-item" href="/explore/aaa">
      <div class="like-wrapper"><span class="count">4</span></div>
    </a>
  </div>
  <div class="side-bar">
    <a href="/user/profile/me0000">我</a>
    <div class="author-wrapper"><span class="name">我自己</span></div>
  </div>
  <div class="note-detail-mask">
    <div id="noteContainer">
      <a href="/user/profile/rival999">竞对作者</a>
      <div class="author-wrapper"><span class="name">竞对作者</span></div>
      <div id="detail-title">这是前景那条笔记</div>
      <div class="note-content">正文</div>
      <div class="engage-bar">
        <div class="like-wrapper"><span class="count">159</span></div>
        <div class="collect-wrapper"><span class="count">34</span></div>
        <div class="chat-wrapper"><span class="count">122</span></div>
      </div>
    </div>
  </div>
</body>`;

async function run(url: string, html: string) {
  const dom = new JSDOM(html, { url });
  const ctx: Record<string, unknown> = {
    location: dom.window.location,
    document: dom.window.document,
    // 封面那条路要网络与 canvas，测试里一律让它降级成 null（拆解本来就允许无封面档）
    fetch: () => Promise.reject(new Error('no network in test')),
    createImageBitmap: () => Promise.reject(new Error('no canvas in test')),
    URL, URLSearchParams, Math, Date, JSON, Number, String, Array, Object, isFinite, parseFloat,
    console, setTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // work.js 是个 async IIFE，返回值就是解析结果
  return (await vm.runInContext(SRC, ctx)) as {
    metrics: Record<string, number>;
    author: string;
    title: string;
  };
}

describe('work.js · 小红书 explore modal 的串台防护', () => {
  it('🔒 指标取前景笔记的（159/34/122），不是背景卡片的 4', async () => {
    const r = await run('https://www.xiaohongshu.com/explore/note123', XHS_HTML);
    expect(r.metrics.likes, '取到 4 就是命中了背景瀑布流那张卡').toBe(159);
    expect(r.metrics.collects).toBe(34);
    expect(r.metrics.comments).toBe(122);
  });

  it('🔒 作者取前景笔记的，不是左侧栏那个「我」', async () => {
    const r = await run('https://www.xiaohongshu.com/explore/note123', XHS_HTML);
    expect(r.author, '取到「我自己」= 把竞对笔记记到用户自己名下').toBe('竞对作者');
  });

  it('🔒 声明了作用域却找不到那个容器 → 一个指标都不取，绝不退回全局', async () => {
    // 页面形态变了（engage-bar 没了）时，宁可少一块信息，也不能把背景卡片的数当成这条的
    const noBar = XHS_HTML.replace(/<div class="engage-bar">[\s\S]*?<\/div>\s*<\/div>/, '</div>');
    const r = await run('https://www.xiaohongshu.com/explore/note123', noBar);
    expect(Object.keys(r.metrics)).toHaveLength(0);
  });

  it('没有声明作用域的平台照常全局取（不影响 B站/抖音那几家）', async () => {
    const bili = '<body><h1 class="video-title">标题</h1><div class="view item">1.2万</div>'
      + '<a class="up-name">UP主</a></body>';
    const r = await run('https://www.bilibili.com/video/BV1xx', bili);
    expect(r.metrics.views).toBe(12000);
    expect(r.title).toBe('标题');
  });
});
