import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// AI 助手能读到当前页面的**正文**。
//
// 【为什么补这个】助手此前拿到的「上下文」只有标题 + 几个数字（title/author/platform/metrics），
// 于是「爆款要点拆解」拆的其实是**一个标题**：用户满屏正文摆在眼前，助手在猜内容。
// 服务端 /api/ingest/assistant 一直支持 context.snippet（会拼成「正文/摘要: …」进 system），
// 但三个入口从来没有人往里塞过东西——这是一条接好了却没接上的线。
//
// 三条约束一起锁在这里：
//   ① 只在用户主动点「拆解/衍生/发送」时才取（不随页面加载上传任何东西）；
//   ② 有硬上限（整页文字动辄几万字，超上下文且淹没重点）；
//   ③ 跳过我们自己注入的侧栏，否则助手会把自己上一轮的回答当成页面内容。

const COMMON_SRC = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');
const SIDEBAR_SRC = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.js'), 'utf8');

function loadCommon(body: string, url = 'https://example.com/post') {
  const dom = new JSDOM(`<html><body>${body}</body></html>`, { url });
  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) }, storage: { sync: { get: () => Promise.resolve({}) } } },
    console, setTimeout,
  });
  vm.runInContext(COMMON_SRC, context);
  return context.beaconPageText as (cap?: number) => string;
}

describe('beaconPageText · 取当前页面正文', () => {
  it('普通网页取主区域文字', () => {
    const t = loadCommon('<nav>导航栏</nav><main><h1>标题</h1><p>这是正文第一段。</p></main>');
    expect(t()).toContain('这是正文第一段');
    expect(t()).not.toContain('导航栏'); // main 之外的不要
  });

  it('信息流站点按条取（X 的时间线：取 article，不是整页）', () => {
    const t = loadCommon(
      '<main><article data-testid="tweet">第一条推文正文</article>'
      + '<article data-testid="tweet">第二条推文正文</article></main>'
      + '<aside>你可能会喜欢 WorkBuddy</aside>',
    );
    expect(t()).toContain('第一条推文正文');
    expect(t()).toContain('第二条推文正文');
    expect(t()).not.toContain('你可能会喜欢'); // 右栏推荐不是正文
  });

  it('🔒 跳过我们自己注入的侧栏（否则助手会把上一轮回答当成页面内容）', () => {
    const t = loadCommon(
      '<main>页面真正的正文</main>'
      + '<div id="beacon-ai-root"><article>烽火台 AI 上一轮的回答</article></div>',
    );
    expect(t()).toContain('页面真正的正文');
    expect(t()).not.toContain('上一轮的回答');
  });

  it('🔒 有硬上限（整页几万字会超上下文，还会把真正相关的部分淹掉）', () => {
    const t = loadCommon(`<main>${'字'.repeat(20000)}</main>`);
    expect(t().length).toBe(4000);
    expect(t(100).length).toBe(100);
  });

  it('取不到正文时返回空串，不抛', () => {
    expect(loadCommon('')()).toBe('');
  });
});

// ── 页内侧栏：点「拆解」时把正文带上 ──
function mountSidebar(pageBody: string, url = 'https://x.com/Aiyafun') {
  const dom = new JSDOM(`<html><body>${pageBody}</body></html>`, { url });
  const sent: { type: string; payload?: { context?: Record<string, unknown> } }[] = [];
  const chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: (msg: { type: string }, cb?: (r: unknown) => void) => {
        sent.push(msg);
        const r = msg.type === 'beacon-ai-chat' ? { ok: true, answer: '回答' } : { ok: true };
        if (cb) { cb(r); return undefined; }
        return Promise.resolve(r);
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      sync: { get: (_k: string, cb: (r: unknown) => void) => cb({ showInPageAi: true }) },
      onChanged: { addListener: () => {} },
    },
  };
  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    window: dom.window,
    URL: dom.window.URL,
    chrome, console,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    setTimeout,
  });
  // 真实页面上 common.js 先于 sidebar.js 执行，beaconPageText 由它挂到 globalThis
  vm.runInContext(COMMON_SRC, context);
  vm.runInContext(SIDEBAR_SRC, context);
  const click = async (id: string) => {
    dom.window.document.getElementById(id)!.dispatchEvent(new dom.window.Event('click'));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { sent, click };
}

describe('页内侧栏 · AI 请求带上页面正文', () => {
  // 2026-07-31：原先挂在「爆款要点拆解」按钮上，那颗按钮已删——它只是把页面文字丢给模型聊两句，
  // 与竖条上走 /api/ingest/analyze 的「拆解这条作品」重名却弱得多，摆在一起只会让用户点错。
  // **这条用例守的不是那颗按钮，是「AI 请求必须带上页面真正的正文」这个不变量**，
  // 所以改挂到还在的触发点（衍生选题）上，覆盖的东西一点没少。
  it('点 AI 动作 → context.snippet 里有页面真正的文字', async () => {
    const p = mountSidebar('<main><article data-testid="tweet">一个几乎没人用的技巧：走 Bonjour 主机名</article></main>');
    await p.click('beacon-ai-ideas');
    const ai = p.sent.find((m) => m.type === 'beacon-ai-chat');
    expect(ai?.payload?.context?.snippet).toContain('Bonjour 主机名');
  });

  it('🔒 只在点击时才取：光加载侧栏不产生任何 AI 请求', async () => {
    const p = mountSidebar('<main>正文</main>');
    expect(p.sent.some((m) => m.type === 'beacon-ai-chat')).toBe(false);
  });
});

// ── popup / SidePanel：扩展页面够不到 DOM，得向内容脚本要 ──
const PANELS: [string, string, string][] = [
  ['SidePanel', 'extension/sidepanel.js', 'extension/sidepanel.html'],
  ['popup', 'extension/popup.js', 'extension/popup.html'],
];

describe.each(PANELS)('%s · AI 上下文里带页面正文', (_name, jsPath, htmlPath) => {
  function mount(pageTextReply: unknown) {
    const dom = new JSDOM(readFileSync(resolve(process.cwd(), htmlPath), 'utf8'), {
      url: 'chrome-extension://test/panel.html',
    });
    const sent: { type: string; payload?: { context?: Record<string, unknown> } }[] = [];
    const chrome = {
      runtime: {
        sendMessage: (msg: { type: string }) => {
          sent.push(msg);
          if (msg.type === 'beacon-get-config') return Promise.resolve({ host: 'https://h' });
          if (msg.type === 'beacon-get-competitors') return Promise.resolve({ ok: true, competitors: [] });
          if (msg.type === 'beacon-ai-chat') return Promise.resolve({ ok: true, answer: '回答' });
          return Promise.resolve({ ok: true });
        },
        openOptionsPage: () => {},
        onMessage: { addListener: () => {} },
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1, url: 'https://x.com/Aiyafun', title: '标题' }]),
        sendMessage: (_id: number, msg: { type: string }) => {
          if (msg.type === 'beacon-page-text') return Promise.resolve(pageTextReply);
          return Promise.resolve({ ok: true, payload: { platform: 'x', handle: 'Aiyafun', posts: [{ title: '推文' }] } });
        },
        create: () => {},
        onActivated: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
      },
      storage: { sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, local: { get: () => Promise.resolve({}) } },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      sidePanel: { open: () => Promise.resolve() },
    };
    const context = vm.createContext({
      document: dom.window.document,
      window: dom.window,
      navigator: dom.window.navigator,
      chrome, console, setTimeout, Date,
    });
    vm.runInContext(readFileSync(resolve(process.cwd(), jsPath), 'utf8'), context);
    const clickChip = async () => {
      const chip = dom.window.document.querySelector('[data-action="analyze"]') as HTMLElement;
      chip.dispatchEvent(new dom.window.Event('click'));
      for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    };
    return { sent, clickChip };
  }

  it('向内容脚本要一次正文，并放进 context.snippet', async () => {
    const p = mount({ ok: true, text: '这一页真正的正文内容' });
    await p.clickChip();
    const ai = p.sent.find((m) => m.type === 'beacon-ai-chat');
    expect(ai?.payload?.context?.snippet).toBe('这一页真正的正文内容');
  });

  it('内容脚本没就绪（普通网页/刚装完插件）→ 少一块上下文，但请求照发', async () => {
    const p = mount(Promise.reject(new Error('no receiver')));
    await p.clickChip();
    const ai = p.sent.find((m) => m.type === 'beacon-ai-chat');
    expect(ai).toBeTruthy();
    expect(ai?.payload?.context?.snippet).toBe('');
  });
});
