import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { inspirationPayloadSchema } from '@/lib/ingest/inspiration';

// 「收进灵感箱」的入口。
//
// 【这个文件锁的是「够得着」和「真的存进去了」两件事】
// 灵感箱此前只有两个入口，两个都够不着：
//   ① 页内抽屉（sidebar.js）——悬浮胶囊在 Chrome 116+ 上打开的是 SidePanel，抽屉根本不展开；
//      而 SidePanel 与 popup 上**根本没有这个按钮**。
//   ② 右键菜单——payload 带 source:'context-menu'，而服务端 schema 只认
//      plugin|manual|comment|rival-comment，于是**每一次右键收藏都是 400**；
//      失败时又只在成功分支弹通知，用户完全看不出它从来没成功过。
// 所以下面既断言按钮在（且不随页面类型隐藏），也拿**服务端真正的 zod schema** 校 sw.js 发出去的包。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');
const SP_SRC = readFileSync(resolve(process.cwd(), 'extension/sidepanel.js'), 'utf8');
const SP_HTML = readFileSync(resolve(process.cwd(), 'extension/sidepanel.html'), 'utf8');
const POPUP_SRC = readFileSync(resolve(process.cwd(), 'extension/popup.js'), 'utf8');
const POPUP_HTML = readFileSync(resolve(process.cwd(), 'extension/popup.html'), 'utf8');

// ── sw.js：唯一的出口，三个入口都过它 ──
type Normalized = Record<string, unknown> | null;
function loadSw() {
  const noop = () => {};
  const listener = { addListener: noop };
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
      storage: { sync: { get: () => Promise.resolve({}) }, local: { get: () => Promise.resolve({}) }, onChanged: listener },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      tabs: { onRemoved: listener, create: noop, remove: noop, sendMessage: noop },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: noop, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: noop, Date, URL,
  });
  vm.runInContext(SW_SRC, context);
  return context.normalizeInspiration as (p: unknown) => Normalized;
}
const normalize = loadSw();

describe('🔒 sw.js · 发出去的包必须过服务端的 zod schema', () => {
  it('右键菜单的包（此前 source:context-menu，每次都 400）现在合法', () => {
    const p = normalize({
      url: 'https://example.com/post/1',
      title: '一篇好文章',
      note: '选中的那段话',
      source: 'plugin',
    });
    expect(inspirationPayloadSchema.safeParse(p).success).toBe(true);
  });

  it('未知 source 一律落回 plugin，而不是原样发上去被打回', () => {
    const p = normalize({ title: 't', url: 'https://a.com/', source: 'context-menu' });
    expect(p?.source).toBe('plugin');
    expect(inspirationPayloadSchema.safeParse(p).success).toBe(true);
  });

  it('合法的 source 保持原样（手动录入/评论挖掘不能被改写成 plugin）', () => {
    expect(normalize({ title: 't', source: 'manual' })?.source).toBe('manual');
    expect(normalize({ title: 't', source: 'rival-comment' })?.source).toBe('rival-comment');
  });

  it('空标题不发空串（schema 要求 min(1)）：退回选中文字，再退回链接', () => {
    const bySel = normalize({ title: '', note: '这段选中的话', url: 'https://a.com/x' });
    expect(bySel?.title).toBe('这段选中的话');
    expect(inspirationPayloadSchema.safeParse(bySel).success).toBe(true);

    const byUrl = normalize({ title: '', url: 'https://a.com/x' });
    expect(byUrl?.title).toBe('https://a.com/x');
    expect(inspirationPayloadSchema.safeParse(byUrl).success).toBe(true);
  });

  it('空链接不发空串（schema 要求是合法 URL），整块省掉', () => {
    const p = normalize({ title: '只有标题', url: '' });
    expect(p).not.toHaveProperty('url');
    expect(inspirationPayloadSchema.safeParse(p).success).toBe(true);
  });

  it('标题、备注、链接全空 → 直接不发（而不是发一个必定 400 的包）', () => {
    expect(normalize({ title: '', url: '', note: '' })).toBeNull();
  });

  // 灵感箱的 url 会存到服务器上，而创作者后台的每个地址都带着等同于登录态的 token=。
  // 页内侧栏一直有这层清洗，右键菜单直接用 tab.url——所以清洗必须搬到这个唯一出口里。
  it('🔒 抹掉等同于登录态的参数（token/sid/ticket…）', () => {
    const p = normalize({ title: 't', url: 'https://mp.weixin.qq.com/cgi-bin/home?token=987654&lang=zh_CN' });
    expect(p?.url).toContain('token=***');
    expect(p?.url).not.toContain('987654');
    expect(p?.url).toContain('lang=zh_CN'); // 无关参数不动
  });

  it('超长字段截断到 schema 上限之内', () => {
    const p = normalize({ title: 'x'.repeat(500), note: 'y'.repeat(500), url: 'https://a.com/' });
    expect((p?.title as string).length).toBe(200);
    expect((p?.note as string).length).toBe(300);
    expect(inspirationPayloadSchema.safeParse(p).success).toBe(true);
  });

  it('未知平台不硬塞（后端对未知平台整条打回，而「不认识的站点」正是收集箱最该收的）', () => {
    const p = normalize({ title: 't', url: 'https://a.com/', platform: undefined });
    expect(p).not.toHaveProperty('platform');
    expect(inspirationPayloadSchema.safeParse(p).success).toBe(true);
  });
});

// ── SidePanel / popup：按钮必须在，且不随页面类型隐藏 ──
function mount(src: string, html: string, tabUrl: string, collect?: unknown) {
  const dom = new JSDOM(html, { url: 'chrome-extension://test/panel.html' });
  const sent: { type: string; payload?: Record<string, unknown> }[] = [];
  const chrome = {
    runtime: {
      sendMessage: (msg: { type: string }) => {
        sent.push(msg);
        if (msg.type === 'beacon-get-config') return Promise.resolve({ host: 'https://beacon.iyunci.cn' });
        if (msg.type === 'beacon-get-competitors') return Promise.resolve({ ok: true, competitors: [] });
        if (msg.type === 'beacon-save-inspiration') return Promise.resolve({ ok: true, duplicate: false, total: 7 });
        return Promise.resolve({ ok: true });
      },
      openOptionsPage: () => {},
      onMessage: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: tabUrl, title: '一个普通网页' }]),
      sendMessage: (_id: number, msg: { type: string }) =>
        Promise.resolve(msg.type === 'beacon-collect' ? (collect ?? { ok: false }) : { ok: false }),
      create: () => {},
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    storage: { sync: { get: () => Promise.resolve({}) } },
    windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
    sidePanel: { open: () => Promise.resolve() },
  };
  const context = vm.createContext({
    document: dom.window.document,
    window: dom.window,
    navigator: dom.window.navigator,
    chrome, console, setTimeout, Date,
  });
  vm.runInContext(src, context);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const click = async (id: string) => {
    dom.window.document.getElementById(id)!.dispatchEvent(new dom.window.Event('click'));
    await settle();
  };
  const el = (id: string) => dom.window.document.getElementById(id)!;
  return { sent, click, settle, el };
}

const CASES: [string, string, string, { btn: string; note: string; out: string }][] = [
  ['SidePanel', SP_SRC, SP_HTML, { btn: 'spInspire', note: 'spInspireNote', out: 'spResult' }],
  ['popup', POPUP_SRC, POPUP_HTML, { btn: 'inspire', note: 'inspireNote', out: 'result' }],
];

describe.each(CASES)('%s · 收进灵感箱常驻', (_name, src, html, ids) => {
  // 「常驻」是这条需求的全部意义：竞对/自有两个按钮认平台，这一个必须在任何网页上都在——
  // 在 X 这类既没有创作者后台、又可能压根不是自己号的地方，「记一笔」常常是唯一能做的事。
  it.each([
    'https://example.com/some/blog/post',
    'https://x.com/someone/status/123',
    'https://mp.weixin.qq.com/cgi-bin/home?token=1',
    'https://www.douyin.com/video/7',
  ])('在 %s 上按钮都在', async (url) => {
    const p = mount(src, html, url);
    await p.settle();
    expect(p.el(ids.btn)).toBeTruthy();
    expect(p.el(ids.btn).style.display).not.toBe('none');
  });

  it('点一下 → 带标题/链接/备注走灵感箱通道，不碰竞对与自有通道', async () => {
    const p = mount(src, html, 'https://example.com/post/1');
    (p.el(ids.note) as HTMLInputElement).value = '这个开头钩子可以抄结构';
    await p.click(ids.btn);

    const saves = p.sent.filter((m) => m.type === 'beacon-save-inspiration');
    expect(saves).toHaveLength(1);
    expect(saves[0].payload).toMatchObject({
      url: 'https://example.com/post/1',
      note: '这个开头钩子可以抄结构',
      source: 'plugin',
    });
    expect(saves[0].payload?.title).toBeTruthy();
    expect(p.sent.some((m) => m.type === 'beacon-ingest' || m.type === 'beacon-ingest-self')).toBe(false);
    // 发出去的包本身就得过服务端 schema（经 sw.js 规整后更是）
    expect(inspirationPayloadSchema.safeParse(normalize(saves[0].payload)).success).toBe(true);
  });

  it('成功后清空备注框，并把「待用 N 条」讲给用户', async () => {
    const p = mount(src, html, 'https://example.com/post/1');
    (p.el(ids.note) as HTMLInputElement).value = '记一笔';
    await p.click(ids.btn);
    expect((p.el(ids.note) as HTMLInputElement).value).toBe('');
    expect(p.el(ids.out).textContent).toContain('7');
  });

  it('识别出平台时带上（未知站点则不带，否则后端整条打回）', async () => {
    const known = mount(src, html, 'https://x.com/someone/status/123', {
      ok: true,
      payload: { platform: 'x', handle: 'someone', posts: [{ platformItemId: '123', title: '一条推文' }] },
    });
    await known.click(ids.btn);
    expect(known.sent.find((m) => m.type === 'beacon-save-inspiration')?.payload).toMatchObject({
      platform: 'x',
      author: 'someone',
    });

    const unknown = mount(src, html, 'https://example.com/post/1');
    await unknown.click(ids.btn);
    // ⚠️ 先锚「这条消息真的发出去了」。只写 `find(...)?.payload?.platform` 是**恒真**的：
    //    压根没发这条消息（未知站点上功能整个坏掉）也会得到 undefined 而判绿——
    //    而下一条用例恰好证明「不发消息」是真实会发生的状态（烽火台自己的页面上就不发）。
    const msg = unknown.sent.find((m) => m.type === 'beacon-save-inspiration');
    expect(msg, '未知站点也该收进灵感箱，只是不带 platform').toBeTruthy();
    expect(msg?.payload?.platform).toBeUndefined();
  });

  it('烽火台自己的页面上不收（收自己的控制台没有意义）', async () => {
    const p = mount(src, html, 'https://beacon.iyunci.cn/inspiration');
    await p.click(ids.btn);
    expect(p.sent.some((m) => m.type === 'beacon-save-inspiration')).toBe(false);
  });
});
