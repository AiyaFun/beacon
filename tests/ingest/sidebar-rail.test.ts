import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

// 悬浮竖条（extension/content/sidebar.js 的 #beacon-rail）三件事的回归锁：
//
// ① **评论采集按钮的显隐选择器**。按钮是 `b.dataset.act = a.id` 建的（→ data-act），
//    而控制显隐的代码一度查的是 `[data-action="comments"]` —— 差一个词，永不命中。
//    后果不是「按钮没了」而是更隐蔽的一种坏：开关**从来没生效过**，按钮一直亮着，
//    用户点下去只回一句「未开启」，既不知道去哪开、也不知道为什么。用真 DOM 断言
//    真实属性，字符串匹配挡不住这类「代码还在但选择器落空」。
// ② **关闭时是锁定不是隐藏**。隐藏 = 用户根本找不到这个功能（真机上用户正是问
//    「有没有评论一键采集按钮」被这个坑到）；本文件 RAIL_ACTIONS 上方早就立过
//    「不可用置灰而不是消失」的规矩，显隐那段是自己违反了自己的规矩。
// ③ **快捷键**要真能按、且在输入框里绝不抢键（否则用户在微博打字打不出字）。

const SRC = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.js'), 'utf8');

type Sent = { type: string; payload?: Record<string, unknown> };
type Sync = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(url: string, sync: Sync = {}) {
  const dom = new JSDOM('<html><body></body></html>', { url });
  const sent: Sent[] = [];
  const store: Sync = { showInPageAi: true, ...sync };
  const changeListeners: Array<(c: Record<string, { newValue: unknown }>, area: string) => void> = [];

  const chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: (msg: Sent, cb?: (r: unknown) => void) => {
        sent.push(msg);
        const r: Record<string, unknown> = msg.type === 'beacon-get-config'
          ? { host: 'https://beacon.iyunci.cn' }
          : msg.type === 'open-sidepanel'
            ? { ok: false }
            : { ok: true, read: 10, created: 2, updated: 0 };
        if (cb) { cb(r); return undefined; }
        return Promise.resolve(r);
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      sync: {
        get: (_k: unknown, cb: (r: Sync) => void) => cb(store),
        set: (v: Sync) => Object.assign(store, v),
      },
      local: { get: (_k: unknown, cb: (r: Sync) => void) => cb({}), set: () => {} },
      onChanged: {
        addListener: (fn: (c: Record<string, { newValue: unknown }>, area: string) => void) => {
          changeListeners.push(fn);
        },
      },
    },
  };

  const context = vm.createContext({
    document: dom.window.document,
    location: dom.window.location,
    window: dom.window,
    navigator: dom.window.navigator,
    URL: dom.window.URL,
    KeyboardEvent: dom.window.KeyboardEvent,
    chrome,
    console,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(SRC, context);

  const doc = dom.window.document;
  const railBtn = (act: string) => doc.querySelector(`.beacon-rail-btn[data-act="${act}"]`) as HTMLElement | null;

  const clickRail = async (act: string) => {
    railBtn(act)!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 5; i++) await sleep(0);
  };

  /** 模拟用户在设置页改了开关（chrome.storage.onChanged 广播到每个页面的侧栏） */
  const changeSetting = async (patch: Sync) => {
    Object.assign(store, patch);
    const changes: Record<string, { newValue: unknown }> = {};
    for (const [k, v] of Object.entries(patch)) changes[k] = { newValue: v };
    for (const fn of changeListeners) fn(changes, 'sync');
    for (let i = 0; i < 5; i++) await sleep(0);
  };

  const press = async (code: string, opts: { alt?: boolean; target?: Element } = {}) => {
    const ev = new dom.window.KeyboardEvent('keydown', {
      code,
      altKey: opts.alt !== false,
      bubbles: true,
      cancelable: true,
    });
    (opts.target || doc.body).dispatchEvent(ev);
    for (let i = 0; i < 5; i++) await sleep(0);
    return ev;
  };

  return { dom, doc, sent, railBtn, clickRail, changeSetting, press, window: dom.window };
}

const ON = { commentCollectOwn: true, commentCollectRival: true };

describe('🔒 侧栏 · 顶层不许有能整份炸掉的语句', () => {
  it('宿主环境没有 navigator 时照样把竖条建起来', () => {
    // 侧栏注入在 <all_urls> 上，顶层抛一次 ReferenceError = 后面所有按钮一个都不绑定，
    // 表现是「侧栏整个死掉」而不是「少了个提示文案」。加快捷键那次就是这样炸的。
    const dom = new JSDOM('<html><body></body></html>', { url: 'https://example.com/' });
    const ctx = vm.createContext({
      document: dom.window.document,
      location: dom.window.location,
      window: dom.window,
      URL: dom.window.URL,
      chrome: {
        runtime: { getURL: (p: string) => p, sendMessage: () => Promise.resolve({ ok: true }), onMessage: { addListener: () => {} } },
        storage: {
          sync: { get: (_k: unknown, cb: (r: Sync) => void) => cb({ showInPageAi: true }) },
          local: { get: (_k: unknown, cb: (r: Sync) => void) => cb({}), set: () => {} },
          onChanged: { addListener: () => {} },
        },
      },
      console, setTimeout, clearTimeout,
      requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
      // 故意不给 navigator
    });
    expect(() => vm.runInContext(SRC, ctx)).not.toThrow();
    expect(dom.window.document.querySelectorAll('.beacon-rail-btn').length).toBe(8);
  });
});

describe('🔒 竖条 · 评论采集按钮的显隐选择器必须命中真实属性', () => {
  it('按钮挂的是 data-act，不是 data-action（选择器打错=开关整个失效）', () => {
    const { railBtn, doc } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    expect(railBtn('comments')).not.toBeNull();
    // 🔒 修复前源码里查的是 [data-action=…]，在真 DOM 上永远是 null
    expect(doc.querySelector('[data-action="comments"]')).toBeNull();
  });

  it('🔒 源码里不许再出现 data-action 选择器', () => {
    // 只看代码，不看注释——注释里正引用着当年写错的那个选择器当反面教材，
    // 连注释一起断言的话，这条守卫会被自己的说明文字钉死。
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('data-action=');
  });
});

describe('竖条 · 采集开关关闭时是「锁定」不是「消失」', () => {
  it('两个开关都关：按钮仍在原位，不许 display:none', () => {
    const { railBtn } = mount('https://www.douyin.com/video/7300000000000000000', {
      commentCollectOwn: false,
      commentCollectRival: false,
    });
    const b = railBtn('comments')!;
    expect(b).not.toBeNull();
    // 🔒 消失会让下面所有图标位置跳动，且用户永远发现不了这个功能
    expect(b.style.display).not.toBe('none');
    expect(b.classList.contains('locked')).toBe(true);
  });

  it('锁定态点一下 → 送去设置页，绝不发起采集（发了也只会被后台回一句「未开启」）', async () => {
    const { clickRail, sent } = mount('https://www.douyin.com/video/7300000000000000000', {
      commentCollectOwn: false,
      commentCollectRival: false,
    });
    await clickRail('comments');
    expect(sent.some((m) => m.type === 'beacon-open-options')).toBe(true);
    expect(sent.some((m) => m.type === 'beacon-collect-comments')).toBe(false);
  });

  it('锁定态的气泡要说清楚「没开」和「点了会怎样」，不能只写功能名', () => {
    const { railBtn } = mount('https://www.douyin.com/video/7300000000000000000', {
      commentCollectOwn: false,
      commentCollectRival: false,
    });
    const tip = railBtn('comments')!.querySelector('.beacon-rail-tip')!.textContent || '';
    expect(tip).toMatch(/未开启|没开启/);
    expect(tip).toMatch(/设置/);
  });

  it('开着任意一个开关 → 解锁，点击真的发起采集', async () => {
    const { clickRail, sent, railBtn } = mount('https://www.douyin.com/video/7300000000000000000', {
      commentCollectOwn: true,
      commentCollectRival: false,
    });
    expect(railBtn('comments')!.classList.contains('locked')).toBe(false);
    await clickRail('comments');
    expect(sent.some((m) => m.type === 'beacon-collect-comments')).toBe(true);
  });

  it('用户在设置页当场打开开关 → 本页竖条立刻解锁，不用刷新', async () => {
    const { railBtn, changeSetting } = mount('https://www.douyin.com/video/7300000000000000000', {
      commentCollectOwn: false,
      commentCollectRival: false,
    });
    expect(railBtn('comments')!.classList.contains('locked')).toBe(true);
    await changeSetting({ commentCollectRival: true });
    expect(railBtn('comments')!.classList.contains('locked')).toBe(false);
  });
});

describe('竖条 · 每颗按钮都要讲清楚自己是干嘛的', () => {
  it('所有按钮都有标题 + 一句人话说明（悬停即可看懂，不用猜图标）', () => {
    const { doc } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    const btns = [...doc.querySelectorAll('.beacon-rail-btn')] as HTMLElement[];
    expect(btns.length).toBeGreaterThanOrEqual(6);
    for (const b of btns) {
      const tip = b.querySelector('.beacon-rail-tip');
      expect(tip, `${b.dataset.act} 少了气泡`).not.toBeNull();
      expect(tip!.querySelector('b')?.textContent?.trim(), `${b.dataset.act} 少了标题`).toBeTruthy();
      expect(tip!.querySelector('i')?.textContent?.trim(), `${b.dataset.act} 少了说明`).toBeTruthy();
    }
  });

  it('气泡里带快捷键提示（截图里那种 Opt + N 的样子）', () => {
    const { railBtn } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    const kbd = railBtn('comments')!.querySelector('.beacon-rail-tip kbd');
    expect(kbd).not.toBeNull();
    expect(kbd!.textContent).toMatch(/\d/);
  });
});

describe('竖条 · 快捷键', () => {
  it('Alt/Opt + 数字 直接触发对应动作（不用先展开竖条）', async () => {
    const { press, sent } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    await press('Digit3');
    expect(sent.some((m) => m.type === 'beacon-collect-comments')).toBe(true);
  });

  it('🔒 光标在输入框里时绝不抢键——否则用户在微博发帖打不出字', async () => {
    const { press, sent, doc } = mount('https://weibo.com/', ON);
    const input = doc.createElement('input');
    doc.body.appendChild(input);
    const ev = await press('Digit3', { target: input });
    expect(sent.some((m) => m.type === 'beacon-collect-comments')).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('🔒 没按 Alt 的纯数字键不许触发', async () => {
    const { press, sent } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    await press('Digit3', { alt: false });
    expect(sent.some((m) => m.type === 'beacon-collect-comments')).toBe(false);
  });
});

describe('🔒 竖条 · 提示气泡不许被自己的容器裁掉', () => {
  // 真机实测（1100px 视口）：气泡盒 855–1036，而 #beacon-rail-items 盒 1040–1090，
  // 两者零重叠 —— 容器上那句 overflow:hidden（折叠动画要用）把气泡裁得一个像素不剩。
  // 从竖条上线（0.8.1）到 0.8.4 之间，**悬停提示从来没显示过**，用户看到的一直是「移上去没反应」。
  const CSS = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.css'), 'utf8');

  it('CSS 里必须有一条「展开后放开裁剪」的规则', () => {
    expect(CSS).toMatch(/#beacon-rail-items\.spread\s*\{[^}]*overflow:\s*visible/);
  });

  it('折叠态仍然要裁剪（否则收起动画里图标会漏在外面）', () => {
    expect(CSS).toMatch(/#beacon-rail-items\s*\{[^}]*overflow:\s*hidden/);
  });

  it('展开后 JS 会给容器加上 spread（气泡这才逃得出容器）', async () => {
    const { doc, window } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    const items = doc.getElementById('beacon-rail-items')!;
    const logo = doc.getElementById('beacon-rail-logo')!;
    expect(items.classList.contains('spread')).toBe(false);
    logo.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true }));
    logo.dispatchEvent(new window.PointerEvent('pointerup', { button: 0, bubbles: true }));
    await sleep(400); // 等展开动画 + SPREAD_DELAY
    expect(items.classList.contains('spread')).toBe(true);
  });

  it('收起时立刻恢复裁剪，不等动画', async () => {
    const { doc, window } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    const items = doc.getElementById('beacon-rail-items')!;
    const logo = doc.getElementById('beacon-rail-logo')!;
    const clickLogo = () => {
      logo.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true }));
      logo.dispatchEvent(new window.PointerEvent('pointerup', { button: 0, bubbles: true }));
    };
    clickLogo();
    await sleep(400);
    expect(items.classList.contains('spread')).toBe(true);
    clickLogo(); // 再点一次 = 取消固定并收起
    expect(items.classList.contains('spread')).toBe(false); // 不给它等动画的机会
  });
});

describe('🔒 评论采集入口 · 四处都不许把功能藏死', () => {
  // 用户找不到功能时不会去翻设置，只会认为「这个产品没有这个功能」。
  // 四个入口（竖条 / popup / 侧边栏 / 右键菜单）里，前三个此前都是「开关没开就整个隐藏」。
  const POPUP_HTML = readFileSync(resolve(process.cwd(), 'extension/popup.html'), 'utf8');
  const SP_HTML = readFileSync(resolve(process.cwd(), 'extension/sidepanel.html'), 'utf8');
  const POPUP_JS = readFileSync(resolve(process.cwd(), 'extension/popup.js'), 'utf8');
  const SP_JS = readFileSync(resolve(process.cwd(), 'extension/sidepanel.js'), 'utf8');

  const btnTag = (html: string, id: string) =>
    new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';

  it('popup 的评论按钮不带 display:none', () => {
    expect(btnTag(POPUP_HTML, 'collectComments')).not.toMatch(/display:\s*none/);
  });

  it('侧边栏的评论按钮不带 display:none', () => {
    expect(btnTag(SP_HTML, 'spCollectComments')).not.toMatch(/display:\s*none/);
  });

  it('popup / 侧边栏点锁定态时都走设置页，而不是发起注定失败的采集', () => {
    for (const [name, js] of [['popup', POPUP_JS], ['sidepanel', SP_JS]] as const) {
      expect(js, `${name} 少了锁定判据`).toContain("dataset.locked === '1'");
      expect(js, `${name} 没有直通设置页`).toContain('openOptionsPage');
    }
  });

  it('三处入口的锁定文案口径一致（都要说「未开启」）', () => {
    expect(POPUP_JS).toContain('未开启');
    expect(SP_JS).toContain('未开启');
    expect(SRC).toContain('未开启');
  });
});

describe('竖条 · 展开', () => {
  it('鼠标移上 logo 就展开，不用点（点击照旧可以固定住）', async () => {
    const { doc, window } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    const rail = doc.getElementById('beacon-rail')!;
    const logo = doc.getElementById('beacon-rail-logo')!;
    expect(rail.classList.contains('open')).toBe(false);
    logo.dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: true }));
    await sleep(320);
    expect(rail.classList.contains('open')).toBe(true);
  });

  it('鼠标离开就收起（没被点击固定的话）', async () => {
    const { doc, window } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    const rail = doc.getElementById('beacon-rail')!;
    const logo = doc.getElementById('beacon-rail-logo')!;
    logo.dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: true }));
    await sleep(320);
    rail.dispatchEvent(new window.MouseEvent('pointerleave', { bubbles: true }));
    await sleep(520);
    expect(rail.classList.contains('open')).toBe(false);
  });

  it('点过 logo 就固定住，鼠标移开也不收', async () => {
    const { doc, window } = mount('https://www.douyin.com/video/7300000000000000000', ON);
    const rail = doc.getElementById('beacon-rail')!;
    const logo = doc.getElementById('beacon-rail-logo')!;
    logo.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true }));
    logo.dispatchEvent(new window.PointerEvent('pointerup', { button: 0, bubbles: true }));
    await sleep(20);
    expect(rail.classList.contains('open')).toBe(true);
    rail.dispatchEvent(new window.MouseEvent('pointerleave', { bubbles: true }));
    await sleep(520);
    expect(rail.classList.contains('open')).toBe(true);
  });
});
