import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 侧栏（extension/content/sidebar.js）注入在 <all_urls> 上，**包括你自己的创作者后台**。
//
// 这个文件锁的是一件合规级的事：两条回传通道绝不能走串。
//   · /api/ingest/competitor —— 竞对公开数据，落工作区共享的竞对库
//   · /api/ingest/self       —— 你自己的后台数据，落 PublishRecord（数据看板）
// self-backend.js 一加载就置 __beaconSelfOnly，common.js 的 beacon-collect 与「访问即采」
// 都按它分流；侧栏此前是唯一没读这个标记的地方——于是在公众号后台点「一键加为竞对并采集数据」，
// 会把你自己后台的数据从竞对通道传上去，还顺手 autoSubscribe 把 handle='self' 加成一个竞对。
//
// 用真 DOM 跑真脚本、断言真正发出去的那条消息，而不是对源码做字符串匹配——
// 字符串匹配挡不住「守卫还在但分支走不到」这类改动。

const SRC = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.js'), 'utf8');

type Sent = { type: string; payload?: Record<string, unknown> };

function mount(url: string, opts: { selfOnly?: boolean; parse?: () => unknown } = {}) {
  const dom = new JSDOM('<html><body></body></html>', { url });
  const sent: Sent[] = [];
  const reply: Record<string, unknown> = {
    'beacon-get-config': { host: 'https://beacon.iyunci.cn' },
    'open-sidepanel': { ok: false }, // 没有 sidePanel 时侧栏走抽屉，与真实降级一致
    'beacon-ingest': { ok: true, competitor: 'X', posts: 1 },
    'beacon-ingest-self': { ok: true, updated: 0, created: 2 },
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
      onChanged: { addListener: () => {} },
    },
  };

  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    window: dom.window,
    URL: dom.window.URL,
    chrome,
    console,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    setTimeout,
    // self-backend.js 在真实页面上会置这个标记；这里直接给，等价于「脚本已加载」
    ...(opts.selfOnly ? { __beaconSelfOnly: true } : {}),
    ...(opts.parse ? { __beaconParse: opts.parse } : {}),
  });
  vm.runInContext(SRC, context);

  const click = async (id: string) => {
    dom.window.document.getElementById(id)!.dispatchEvent(new dom.window.Event('click'));
    // 处理器是 async 的：让出几轮微/宏任务，等它把消息发完
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { dom, sent, click, doc: dom.window.document };
}

// 公众号后台上 __beaconParse 的真实产物形态（self-backend.js）：handle 恒为 'self'
const WECHAT_PAYLOAD = () => ({
  platform: 'wechat',
  handle: 'self',
  posts: [{ platformItemId: 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz', title: '文章', metrics: { views: 1234 } }],
});

describe('🔒 侧栏 · 自有创作者后台绝不走竞对通道', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&token=987654';

  it('公众号后台点采集 → 走 beacon-ingest-self，一条 beacon-ingest 都不许发', async () => {
    const { sent, click } = mount(url, { selfOnly: true, parse: WECHAT_PAYLOAD });
    await click('beacon-collect-btn');
    expect(sent.some((m) => m.type === 'beacon-ingest-self')).toBe(true);
    // 🔒 修复前这里发的是 beacon-ingest（→ /api/ingest/competitor，写共享竞对库）
    expect(sent.some((m) => m.type === 'beacon-ingest')).toBe(false);
  });

  it('🔒 更不许带 autoSubscribe —— 那会把 handle=self 加成一个竞对', async () => {
    const { sent, click } = mount(url, { selfOnly: true, parse: WECHAT_PAYLOAD });
    await click('beacon-collect-btn');
    for (const m of sent) expect(m.payload?.autoSubscribe).toBeUndefined();
  });

  it('后台页解析不出数据时不兜底：兜底会把公众号数据报成 B站', async () => {
    const { sent, click } = mount(url, { selfOnly: true, parse: () => null });
    await click('beacon-collect-btn');
    expect(sent.some((m) => m.type === 'beacon-ingest')).toBe(false);
    expect(sent.some((m) => m.type === 'beacon-ingest-self')).toBe(false);
  });

  it('按钮文案改成「回填数据看板」，不再叫「加为竞对」', () => {
    const { doc } = mount(url, { selfOnly: true, parse: WECHAT_PAYLOAD });
    const label = doc.getElementById('beacon-collect-btn')!.textContent ?? '';
    expect(label).toContain('回填数据看板');
    expect(label).not.toContain('竞对');
  });
});

describe('侧栏 · 竞对通道只在公开竞对站点上开', () => {
  it('B站主页照常走 beacon-ingest', async () => {
    const { sent, click } = mount('https://space.bilibili.com/123456', {
      parse: () => ({ platform: 'bilibili', handle: '123456', posts: [{ platformItemId: 'BV1', title: 't', metrics: {} }] }),
    });
    await click('beacon-collect-btn');
    expect(sent.some((m) => m.type === 'beacon-ingest')).toBe(true);
  });

  it('🔒 随便一个站点不许走竞对通道（兜底会默认 platform=bilibili 并瞎凑 handle）', async () => {
    const { sent, click } = mount('https://www.zhihu.com/question/123');
    await click('beacon-collect-btn');
    expect(sent.some((m) => m.type === 'beacon-ingest')).toBe(false);
  });
});

describe('🔒 侧栏 · 上传的链接不得带登录态参数', () => {
  it('灵感箱里的 url 抹掉 token（公众号后台每个地址都带它）', async () => {
    const { sent, click } = mount('https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&token=987654', {
      selfOnly: true,
      parse: WECHAT_PAYLOAD,
    });
    await click('beacon-inspire-btn');
    const inspire = sent.find((m) => m.type === 'beacon-save-inspiration');
    expect(inspire).toBeTruthy();
    expect(String(inspire!.payload!.url)).not.toContain('987654');
    expect(String(inspire!.payload!.url)).toContain('***');
  });
});
