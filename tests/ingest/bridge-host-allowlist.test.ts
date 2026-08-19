import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// `config-token` 写的是**采集回传的目的地**，它不属于 bridge.js 文件头说的那类「无害动作」。
//
// 2026-08-13 查出来的问题：manifest 里给 bridge.js 配的 `http://localhost/*`，
// **Chrome 的 match pattern 不认端口**——覆盖的是本机任意端口上的任意页面，不只是本项目的
// dev server。用户本机随便跑起来的一个网页（或它上面的一个 XSS）都能拿到这条桥，
// 把 host 改到攻击者的服务器上，此后每一批采集数据都会规规矩矩 POST 过去，界面上一切正常。
//
// 端口在 manifest 层拦不住（match pattern 语法里就没有端口），只能在脚本里拦：
// **host 只允许「这个页面自己的源」或写死的生产地址**。
// 这份用例钉的就是这条白名单——正常的两条路（线上、本地 dev）必须照常работать，
// 而任何页面都不能把插件指向第三方域名。

const BRIDGE_SRC = readFileSync(resolve(process.cwd(), 'extension/content/bridge.js'), 'utf8');
const PROD = 'https://beacon.iyunci.cn';

type Store = Record<string, unknown>;

function mount(pageUrl: string) {
  const dom = new JSDOM('<html><body></body></html>', { url: pageUrl });
  const written: Store[] = [];
  const replies: string[] = [];

  // 页面侧监听插件的回话（done / rejected）
  dom.window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { __beacon?: string };
    if (d && typeof d.__beacon === 'string') replies.push(d.__beacon);
  });

  const context = vm.createContext({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location, // hostAllowed 拿它比对页面自己的源
    URL,
    chrome: {
      runtime: { sendMessage: () => Promise.resolve({ ok: true }), onMessage: { addListener: () => {} } },
      storage: { sync: { set: (o: Store, cb?: () => void) => { written.push(o); if (cb) cb(); } } },
    },
    console, setTimeout,
  });
  vm.runInContext(BRIDGE_SRC, context);

  const post = async (data: unknown) => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: dom.window } as never));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { written, replies, post };
}

const TOKEN = 'bcn_0123456789abcdef0123456789abcdef0123456789abcdef';

describe('bridge.js · config-token 的 host 白名单', () => {
  it('线上：页面在生产域、host 也是生产域 → 正常写入', async () => {
    const b = mount(`${PROD}/extension`);
    await b.post({ __beacon: 'config-token', host: PROD, token: TOKEN });
    expect(b.written).toEqual([{ host: PROD, token: TOKEN }]);
    expect(b.replies).toContain('config-token-done');
  });

  it('本地开发：页面在 localhost:3000、host 也是它自己 → 正常写入', async () => {
    const b = mount('http://localhost:3000/extension');
    await b.post({ __beacon: 'config-token', host: 'http://localhost:3000', token: TOKEN });
    expect(b.written).toHaveLength(1);
  });

  // NEXT_PUBLIC_APP_URL 没设时，app/(app)/extension/page.tsx 会回退成生产地址，
  // 于是本地页面递上来的 host 是生产域。这条路必须留着，否则 dev 环境一配就报错。
  it('本地开发但 NEXT_PUBLIC_APP_URL 未设（递上来的是生产地址）→ 仍然放行', async () => {
    const b = mount('http://localhost:3000/extension');
    await b.post({ __beacon: 'config-token', host: PROD, token: TOKEN });
    expect(b.written).toHaveLength(1);
  });

  it('🔒 本机任意端口上的野页面想把 host 指到第三方域名 → 拒绝，且一个字节都不写', async () => {
    const b = mount('http://localhost:9999/evil.html');
    await b.post({ __beacon: 'config-token', host: 'https://evil.example.com', token: TOKEN });
    expect(b.written).toHaveLength(0);
    expect(b.replies).toContain('config-token-rejected');
    expect(b.replies).not.toContain('config-token-done');
  });

  it.each([
    ['协议不同（http 冒充 https）', 'http://beacon.iyunci.cn'],
    ['端口不同', 'https://beacon.iyunci.cn:8443'],
    ['子域名', 'https://evil.beacon.iyunci.cn'],
    ['同名后缀', 'https://beacon.iyunci.cn.evil.com'],
    ['不是合法 URL', 'not a url'],
    ['javascript 伪协议', 'javascript:alert(1)'],
  ])('🔒 %s → 拒绝', async (_why, host) => {
    const b = mount(`${PROD}/extension`);
    await b.post({ __beacon: 'config-token', host, token: TOKEN });
    expect(b.written).toHaveLength(0);
  });

  it.each([
    ['空令牌', ''],
    ['太短', 'abc'],
    ['带空格（多半是粘贴串了行）', 'bcn_xxxx yyyy zzzz'],
    ['不是字符串', 12345678],
  ])('🔒 令牌形状不对（%s）→ 拒绝', async (_why, token) => {
    const b = mount(`${PROD}/extension`);
    await b.post({ __beacon: 'config-token', host: PROD, token });
    expect(b.written).toHaveLength(0);
  });

  // 白名单的锚不能自己是可变的：PROD_HOST 一旦能被页面改写，这道闸等于不存在。
  it('🔒 生产地址在脚本里是写死的常量，不从页面取', () => {
    expect(BRIDGE_SRC).toMatch(/const PROD_HOST = 'https:\/\/beacon\.iyunci\.cn'/);
  });
});
