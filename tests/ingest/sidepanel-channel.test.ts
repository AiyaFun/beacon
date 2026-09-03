import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// Chrome SidePanel（extension/sidepanel.html + sidepanel.js）。
//
// 这个文件为什么必须存在：页内侧栏的悬浮胶囊点下去，**打开的其实是 SidePanel** ——
// sidebar.js 的 trigger 先发 open-sidepanel，Chrome 116+ 上这一步会成功，页内抽屉根本不展开。
// 也就是说用户日常看到的「侧边栏」是这个文件，不是 sidebar.js。它此前：
//   ① 完全没有「回填我的作品」按钮 —— 自有数据回填在这个入口上够不着；
//   ② spCollect 不分流 —— 在创作者后台点它，会把你自己的后台数据经 /api/ingest/competitor
//      写进工作区共享的竞对库（与 sidebar.js 修掉的是同一个洞）。

const HTML = readFileSync(resolve(process.cwd(), 'extension/sidepanel.html'), 'utf8');
const SRC = readFileSync(resolve(process.cwd(), 'extension/sidepanel.js'), 'utf8');

type Sent = { type: string; payload?: Record<string, unknown> };

function mount(
  tabUrl: string,
  opts: { collect?: unknown; ingestSelf?: Record<string, unknown>; settings?: Record<string, unknown> } = {},
) {
  const dom = new JSDOM(HTML, { url: 'chrome-extension://test/sidepanel.html' });
  const sent: Sent[] = [];
  const toTab: Sent[] = [];

  const chrome = {
    runtime: {
      sendMessage: (msg: Sent) => {
        sent.push(msg);
        if (msg.type === 'beacon-get-config') return Promise.resolve({ host: 'https://beacon.iyunci.cn' });
        if (msg.type === 'beacon-get-competitors') return Promise.resolve({ ok: true, competitors: [] });
        if (msg.type === 'beacon-ingest') return Promise.resolve({ ok: true, competitor: 'X', posts: 1 });
        if (msg.type === 'beacon-ingest-self') {
          return Promise.resolve(opts.ingestSelf ?? { ok: true, updated: 0, created: 2, summary: '✓ 已回填：2 条作品', summaryOk: true });
        }
        return Promise.resolve({ ok: true });
      },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, url: tabUrl, title: 't' }]),
      sendMessage: (_id: number, msg: Sent) => {
        toTab.push(msg);
        if (msg.type === 'beacon-collect') {
          return Promise.resolve(opts.collect ?? { ok: true, payload: { platform: 'wechat', handle: 'self', posts: [{ platformItemId: 'x', metrics: { views: 1 } }] } });
        }
        return Promise.resolve({ ok: false, reason: '自检：这一页多半没有作品数据表' });
      },
      create: () => {},
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    // sidepanel.js 顶层会读设置（评论按钮显隐、绑定的账号）。少了它整份脚本会停在第一处
    // chrome.storage 上——表现是「侧栏一片死」，而用例只会看到一句 reading 'sync' of undefined。
    storage: {
      sync: {
        get: () => Promise.resolve(opts.settings ?? {}),
        set: () => Promise.resolve(),
      },
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: { addListener: () => {} },
    },
  };

  const context = vm.createContext({
    document: dom.window.document,
    window: dom.window,
    chrome,
    console,
    setTimeout,
    Date,
  });
  vm.runInContext(SRC, context);

  const click = async (id: string) => {
    dom.window.document.getElementById(id)!.dispatchEvent(new dom.window.Event('click'));
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  const el = (id: string) => dom.window.document.getElementById(id)!;
  return { sent, toTab, click, settle, el };
}

// 视频号后台：插件仍支持的创作者后台之一（公众号那条 2026-09-03 已整条移除）
const SELF_BACKEND = 'https://channels.weixin.qq.com/platform/post/list';

describe('🔒 SidePanel · 自有作品回填按钮（此前根本不存在）', () => {
  it('创作者后台上按钮露出来', async () => {
    const p = mount(SELF_BACKEND);
    await p.settle();
    expect(p.el('spCollectSelf').style.display).not.toBe('none');
  });

  it('普通网页上不露（那儿没有你自己的作品数据）', async () => {
    const p = mount('https://www.zhihu.com/question/123');
    await p.settle();
    expect(p.el('spCollectSelf').style.display).toBe('none');
  });

  it('自己的抖音作品页也算自有作品页', async () => {
    const p = mount('https://www.douyin.com/video/7065264218437717285');
    await p.settle();
    expect(p.el('spCollectSelf').style.display).not.toBe('none');
  });

  it('点它走 beacon-ingest-self，绝不走竞对通道', async () => {
    const p = mount(SELF_BACKEND);
    await p.settle();
    await p.click('spCollectSelf');
    expect(p.sent.some((m) => m.type === 'beacon-ingest-self')).toBe(true);
    expect(p.sent.some((m) => m.type === 'beacon-ingest')).toBe(false);
  });
});

describe('🔒 SidePanel · 竞对按钮不得把自有后台数据写进竞对库', () => {
  it('在创作者后台点「加为竞对」→ 直接挡下，并指路到回填按钮', async () => {
    const p = mount(SELF_BACKEND);
    await p.settle();
    // 面板为了显示页面标题本来就会解析一次（只在本地读，不上传）——
    // 这里量的是**点击之后**有没有再去采一次，而不是有没有采过。
    const before = p.toTab.filter((m) => m.type === 'beacon-collect').length;
    await p.click('spCollect');
    expect(p.sent.some((m) => m.type === 'beacon-ingest')).toBe(false);
    // 内容脚本此时照样会返回 payload（common.js 的 __beaconSelfOnly 分支），
    // 所以必须在**发出去之前**挡住，而不是指望解析失败
    expect(p.toTab.filter((m) => m.type === 'beacon-collect').length).toBe(before);
    expect(p.el('spResult').textContent).toContain('回填数据看板');
  });

  it('随便一个站点也不许走竞对通道（兜底会默认 platform=bilibili）', async () => {
    const p = mount('https://www.zhihu.com/question/123');
    await p.settle();
    await p.click('spCollect');
    expect(p.sent.some((m) => m.type === 'beacon-ingest')).toBe(false);
  });

  it('B站主页照常走竞对通道', async () => {
    const p = mount('https://space.bilibili.com/123456', {
      collect: { ok: true, payload: { platform: 'bilibili', handle: '123456', posts: [] } },
    });
    await p.settle();
    await p.click('spCollect');
    expect(p.sent.some((m) => m.type === 'beacon-ingest')).toBe(true);
  });
});

// 后端对「一个指标都没读到」的作品直接跳过（不建空记录污染基线），
// 于是 200 + {updated:0,created:0,skipped:9} 是个**完全正常的成功响应**。
// 三个入口此前都只看 updated+created，0 条时统一报「✓ 已回填到数据看板」——
// 用户看到勾，去数据看板一看什么都没有。
describe('🔒 SidePanel · 一条都没入库时不许报成功', () => {
  it('skipped>0 而 updated+created=0 → 报警告并带上自检', async () => {
    const p = mount(SELF_BACKEND, {
      ingestSelf: {
        ok: true, updated: 0, created: 0, skipped: 9,
        summary: '认出了 9 条作品，但一个指标都没读到，因此一条都没入库。',
        summaryOk: false,
      },
    });
    await p.settle();
    await p.click('spCollectSelf');
    const out = p.el('spResult').textContent ?? '';
    expect(out).toContain('⚠️');
    expect(out).toContain('一个指标都没读到');
    expect(out).not.toContain('✓');
    expect(p.el('spResult').style.color).toBe('var(--red)');
  });
});
