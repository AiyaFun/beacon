import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 页内侧栏（extension/content/sidebar.js）的自有作品回填。
//
// 【为什么补这个】侧栏此前只有一条「一键加为竞对并采集数据」。在**创作者后台**上它会
// 自己改名成「这是我的作品」（__beaconSelfOnly 分支，已有 sidebar-channel.test.ts 锁着），
// 但在**你自己的公开作品页**上——B站/抖音/小红书的作品页，以及 X 上你自己的主页——
// 没有 __beaconSelfOnly，于是侧栏只给得出「加为竞对」：自己的作品在这个入口上根本回填不了。
// 真机 2026-07-27：用户站在自己的 X 主页（@Aiyafun）上打开侧栏，只有「加为竞对」和「收进灵感箱」。
//
// X 还多一层：x.com/<我> 与 x.com/<竞对> 是同一种页面，点错就把竞对的推文写成自己的发布记录。

const SRC = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.js'), 'utf8');

type Sent = { type: string; payload?: Record<string, unknown>; accountId?: string };

function mount(url: string, opts: { parse?: () => unknown; accounts?: unknown; selfOnly?: boolean } = {}) {
  const dom = new JSDOM('<html><body></body></html>', { url });
  const sent: Sent[] = [];
  const reply: Record<string, unknown> = {
    'beacon-get-config': { host: 'https://beacon.iyunci.cn' },
    'open-sidepanel': { ok: false },
    'beacon-ingest': { ok: true, competitor: 'C', posts: 1 },
    'beacon-ingest-self': { ok: true, summary: '✓ 已回填：2 条作品', summaryOk: true },
    'beacon-get-accounts': opts.accounts ?? { ok: true, selfAccountId: 'a-2', accounts: [
      { id: 'a-1', name: '主号', platform: 'douyin', status: 'active' },
      { id: 'a-2', name: '<b>X 号', platform: 'x', status: 'active' },
    ] },
  };
  const chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: (msg: Sent, cb?: (r: unknown) => void) => {
        sent.push(msg);
        const r = reply[msg.type] ?? { ok: true };
        if (cb) { cb(r); return undefined; }
        return Promise.resolve(r);
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      sync: { get: (_k: string, cb: (r: unknown) => void) => cb({ showInPageAi: true }) },
      // storage 权限同时覆盖 local 与 sync，真机上两个都在；桩缺 local 会让侧栏初始化直接抛
      local: { get: (_k: string, cb: (r: unknown) => void) => cb({}), set: (_o: unknown, cb?: () => void) => cb?.() },
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
    ...(opts.selfOnly ? { __beaconSelfOnly: true } : {}),
    ...(opts.parse ? { __beaconParse: opts.parse } : {}),
  });
  vm.runInContext(SRC, context);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const click = async (id: string) => {
    dom.window.document.getElementById(id)!.dispatchEvent(new dom.window.Event('click'));
    await settle();
  };
  const el = (id: string) => dom.window.document.getElementById(id)!;
  return { dom, sent, click, settle, el };
}

const X_PAYLOAD = (isSelf?: boolean) => () => ({
  platform: 'x',
  handle: 'Aiyafun',
  posts: [
    { platformItemId: '111', title: '推文一', url: 'https://x.com/Aiyafun/status/111', metrics: { views: 1202 } },
    { platformItemId: '222', title: '推文二', url: 'https://x.com/Aiyafun/status/222', metrics: { views: 300 } },
  ],
  ...(isSelf ? { isSelf: true } : {}),
});

describe('侧栏 · 「这是我的作品 · 回填数据看板」按钮', () => {
  it('X 自己的主页上露出来（真机上这里此前只有「加为竞对」）', async () => {
    const p = mount('https://x.com/Aiyafun', { parse: X_PAYLOAD(true) });
    await p.settle();
    expect(p.el('beacon-self-btn').style.display).not.toBe('none');
  });

  it.each([
    'https://www.bilibili.com/video/BV1xx',
    'https://www.douyin.com/video/7123',
    'https://www.xiaohongshu.com/explore/abc123',
    'https://x.com/Aiyafun/status/111',
  ])('自己的公开作品页上也露出来：%s', async (url) => {
    const p = mount(url, { parse: X_PAYLOAD(true) });
    await p.settle();
    expect(p.el('beacon-self-btn').style.display).not.toBe('none');
  });

  // ⚠️ space.bilibili.com 曾在这张「不该出现」的名单里——2026-07-28 起它是**自己的空间**，
  // 与 X/小红书主页同类，理应能回填（点错的防线是 isSelf + 二次确认）。
  // 这里留下的是真正不该出现的：站内功能页、普通网页、平台首页。
  it.each([
    'https://x.com/home',
    'https://example.com/blog',
    'https://www.bilibili.com/',
    'https://www.douyin.com/',
    'https://www.youtube.com/results?search_query=abc',
  ])('不该出现的地方不出现：%s', async (url) => {
    const p = mount(url);
    await p.settle();
    expect(p.el('beacon-self-btn').style.display).toBe('none');
  });

  it.each([
    ['B站空间', 'https://space.bilibili.com/12345678'],
    ['抖音主页', 'https://www.douyin.com/user/MS4wLjABAAAA-demo'],
    ['YouTube 频道', 'https://www.youtube.com/@MrBeast'],
    ['小红书主页', 'https://www.xiaohongshu.com/user/profile/5f3a2b1c000000000101'],
  ])('自己的%s上露出来', async (_n, url) => {
    const p = mount(url, { parse: X_PAYLOAD(true) });
    await p.settle();
    expect(p.el('beacon-self-btn').style.display).not.toBe('none');
  });

  it('创作者后台上不重复给按钮（那儿是采集按钮自己变成「这是我的作品」）', async () => {
    const p = mount('https://mp.weixin.qq.com/cgi-bin/appmsgpublish?token=1', { selfOnly: true });
    await p.settle();
    expect(p.el('beacon-self-btn').style.display).toBe('none');
    expect(p.el('beacon-collect-btn').textContent).toContain('回填数据看板');
  });

  it('🔒 点它走自有通道，一条竞对回传都不许发', async () => {
    const p = mount('https://x.com/Aiyafun', { parse: X_PAYLOAD(true) });
    await p.click('beacon-self-btn');
    const self = p.sent.filter((m) => m.type === 'beacon-ingest-self');
    expect(self).toHaveLength(1);
    expect(self[0].payload?.posts).toHaveLength(2); // 一键把这一页的作品都带上
    expect(p.sent.some((m) => m.type === 'beacon-ingest')).toBe(false);
    // 🔒 更不许带 autoSubscribe——那会把自己加成一个竞对
    for (const m of p.sent) expect(m.payload?.autoSubscribe).toBeUndefined();
  });

  it('解析不出作品时不发请求（兜底解析会把 X 的推文报成 B站）', async () => {
    const p = mount('https://x.com/Aiyafun', { parse: () => null });
    await p.click('beacon-self-btn');
    expect(p.sent.some((m) => m.type === 'beacon-ingest-self')).toBe(false);
  });

  it('🔒 X 上认不出是本人 → 第一次点击只警告，再点一次才回填', async () => {
    const p = mount('https://x.com/SomeoneElse', { parse: X_PAYLOAD(false) });
    await p.click('beacon-self-btn');
    expect(p.sent.some((m) => m.type === 'beacon-ingest-self')).toBe(false);
    await p.click('beacon-self-btn');
    expect(p.sent.filter((m) => m.type === 'beacon-ingest-self')).toHaveLength(1);
  });
});

describe('侧栏 · 回填到哪个账号', () => {
  it('能回填的页面上才显示，并选中已绑定的账号', async () => {
    const p = mount('https://x.com/Aiyafun', { parse: X_PAYLOAD(true) });
    await p.settle();
    expect(p.el('beacon-account-row').style.display).toBe('flex');
    const sel = p.el('beacon-account-sel') as HTMLSelectElement;
    expect(sel.options.length).toBe(3); // （自动匹配）+ 2 个账号
    expect(sel.value).toBe('a-2');
    // 账号名是用户自己填的，可能带 < >：必须按文本插入
    expect(Array.from(sel.options).find((o) => o.value === 'a-2')!.textContent).toContain('<b>X 号');
    expect(sel.querySelector('b')).toBeNull();
  });

  it('普通网页上不显示（那儿这个下拉框没有意义）', async () => {
    const p = mount('https://example.com/blog');
    await p.settle();
    expect(p.el('beacon-account-row').style.display).toBe('none');
  });

  it('创作者后台上显示（那儿的回填走采集按钮，归属同样要选对）', async () => {
    const p = mount('https://mp.weixin.qq.com/cgi-bin/appmsgpublish?token=1', { selfOnly: true });
    await p.settle();
    expect(p.el('beacon-account-row').style.display).toBe('flex');
  });

  it('改选后写回绑定', async () => {
    const p = mount('https://x.com/Aiyafun', { parse: X_PAYLOAD(true) });
    await p.settle();
    const sel = p.el('beacon-account-sel') as HTMLSelectElement;
    sel.value = 'a-1';
    sel.dispatchEvent(new p.dom.window.Event('change'));
    await p.settle();
    expect(p.sent.filter((m) => m.type === 'beacon-set-account').at(-1)).toMatchObject({ accountId: 'a-1' });
  });
});
