import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { POST as createAccountRoute, GET as listAccountsRoute } from '@/app/api/ingest/self/accounts/route';

// 插件里就地建号。
//
// 【为什么开这个口子】回填最常见的死路是「工作区里还没有『X』账号」：用户站在自己主页上、
// 数据就在眼前，却被要求切回网页建号、再回来重点一次。产品决策（2026-07-27）取最少操作。
//
// 【这是采集令牌唯一一处能创建工作区实体的地方】其余通道都只写数据。已知且被接受的代价：
// 网页里建号要 persona.edit（viewer 不能建），而设置页的令牌卡没有角色门，
// 所以拿到令牌的 viewer 可经此建号。下面锁的是**口子的边界**，不是这个取舍本身。

const TOKEN = 'bcn_create_token';
let wsId = '';

async function post(body: unknown, token = TOKEN) {
  return createAccountRoute(new Request('https://x/api/ingest/self/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
    body: JSON.stringify(body),
  }));
}

beforeEach(async () => {
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w', ingestToken: TOKEN } });
  wsId = ws.id;
});

describe('POST /api/ingest/self/accounts · 建号', () => {
  it('建出来的号可用：平台/名称正确，且立刻出现在清单里', async () => {
    const r = await post({ name: 'Aiya哎呀', platform: 'x', handle: 'Aiyafun' });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.account).toMatchObject({ name: 'Aiya哎呀', platform: 'x', handle: 'Aiyafun', status: 'active' });

    const list = await listAccountsRoute(new Request('https://x/api/ingest/self/accounts', {
      headers: { 'x-beacon-ingest-token': TOKEN },
    }));
    expect((await list.json()).accounts).toHaveLength(1);
  });

  it('🔒 种下与网页建号同一份空人设（否则账号带 "{}" 进系统，人设处处要额外兜底）', async () => {
    await post({ name: '我的号', platform: 'x' });
    const acc = await prisma.creatorAccount.findFirstOrThrow({ where: { workspaceId: wsId } });
    const persona = parseJson<Record<string, unknown>>(acc.personaCard, {});
    expect(Object.keys(persona).length).toBeGreaterThan(0);
    expect(acc.personaCard).not.toBe('{}');
    expect(parseJson<{ voice: unknown[] }>(acc.styleFingerprint, { voice: [] }).voice).toEqual([]);
  });

  it('🔒 同名同平台幂等：连点两下不该建出两个一样的号', async () => {
    const a = await (await post({ name: '我的号', platform: 'x' })).json();
    const b = await (await post({ name: '我的号', platform: 'x' })).json();
    expect(b.existed).toBe(true);
    expect(b.account.id).toBe(a.account.id);
    expect(await prisma.creatorAccount.count({ where: { workspaceId: wsId } })).toBe(1);
  });

  // 2026-08-07 真机：网页里按昵称建了「Aiya哎呀」(handle=Aiyafun)，插件在 X 作品页按用户名
  // 又建了「aiyafun」——同一个号躺成两条，数据一分为二，而数据页全按 accountId 过滤，
  // 用户看到的是「一半数据不见了」。只比 name 挡不住，判据必须 name/handle 交叉比。
  it('🔒 页面上抓到的用户名 = 已有账号的 handle → 认成同一个号，不建第二条', async () => {
    const web = await prisma.creatorAccount.create({
      data: { workspaceId: wsId, name: 'Aiya哎呀', platform: 'x', handle: 'Aiyafun' },
    });
    const r = await (await post({ name: 'aiyafun', platform: 'x', handle: 'aiyafun' })).json();
    expect(r.existed).toBe(true);
    expect(r.account.id).toBe(web.id);
    expect(await prisma.creatorAccount.count({ where: { workspaceId: wsId } })).toBe(1);
  });

  it('同名但不同平台是两个号（一人多平台是常态）', async () => {
    await post({ name: '我的号', platform: 'x' });
    await post({ name: '我的号', platform: 'douyin' });
    expect(await prisma.creatorAccount.count({ where: { workspaceId: wsId } })).toBe(2);
  });

  it('🔒 令牌无效 → 401，一个号都不许建', async () => {
    const r = await post({ name: '偷建的号', platform: 'x' }, 'nope');
    expect(r.status).toBe(401);
    expect(await prisma.creatorAccount.count()).toBe(0);
  });

  it.each([
    ['空名字', { name: '   ', platform: 'x' }],
    ['未知平台', { name: '号', platform: 'nosuch' }],
    ['名字超长', { name: 'x'.repeat(61), platform: 'x' }],
  ])('%s 被挡下', async (_why, body) => {
    expect((await post(body)).status).toBe(400);
    expect(await prisma.creatorAccount.count()).toBe(0);
  });

  it('🔒 总数封顶：防脚本跑飞把工作区刷满', async () => {
    for (let i = 0; i < 30; i++) {
      await prisma.creatorAccount.create({ data: { workspaceId: wsId, name: `号${i}`, platform: 'x' } });
    }
    const r = await post({ name: '第31个', platform: 'x' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('上限');
    expect(await prisma.creatorAccount.count({ where: { workspaceId: wsId } })).toBe(30);
  });

  it('🔒 只能建，不能改别人的号（这个端点没有改名/删除能力）', async () => {
    const other = await prisma.creatorAccount.create({ data: { workspaceId: wsId, name: '原名', platform: 'x' } });
    await post({ name: '新名', platform: 'x' });
    expect((await prisma.creatorAccount.findUniqueOrThrow({ where: { id: other.id } })).name).toBe('原名');
  });
});

// ── 这一趟数据记到哪个账号名下 ──
//
// 服务端的兜底顺序是「同平台活跃 → 同平台任意 → **multi 活跃** → multi 任意」。
// multi（多平台）那两级是给「一人一号打多个平台」准备的合法归属，但它有个后果：
// 工作区里只要存在一个 multi 账号，**任何平台**的数据都会落进去，永远触发不了「没有账号」——
// 于是各平台的数据全糊在同一个号上，而数据看板、平台基线、算法教练、学习样本都是按账号算的。
// 真机 2026-07-27：X 的 6 条推文落进了名为「我的账号」的 multi 号，用户要的是给 X 单独建一个。
//
// 所以归属改成在**插件侧回填前**就定：显式绑定 > 同平台账号 > 用页面昵称新建一个同平台的。
describe('🔒 sw.js · 回填前按平台定归属（multi 账号不再吃掉所有平台）', () => {
  type Call = { url: string; method: string; body: Record<string, unknown> | null };

  function loadSw(opts: { accounts?: Record<string, unknown>[]; bound?: string; payload?: Record<string, unknown> } = {}) {
    const noop = () => {};
    const listener = { addListener: noop };
    const calls: Call[] = [];
    const synced: Record<string, unknown> = { host: 'https://h', token: 't', ...(opts.bound ? { selfAccountId: opts.bound } : {}) };
    const removed: string[] = [];
    const context = vm.createContext({
      chrome: {
        runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
        storage: {
          sync: {
            get: () => Promise.resolve({ ...synced }),
            set: (o: Record<string, unknown>) => { Object.assign(synced, o); return Promise.resolve(); },
          },
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve(),
            remove: (k: string[]) => { removed.push(...(Array.isArray(k) ? k : [k])); return Promise.resolve(); },
          },
          onChanged: listener,
        },
        alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
        tabs: { onRemoved: listener, create: noop, remove: noop, sendMessage: noop },
        action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
        notifications: { create: noop, onClicked: listener },
        contextMenus: { removeAll: noop, create: noop, onClicked: listener },
        sidePanel: { open: noop },
      },
      console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
      fetch: (url: string, init: { method?: string; body?: string }) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ url, method, body });
        if (url.endsWith('/accounts')) {
          if (method === 'GET') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, accounts: opts.accounts ?? [] }) });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, account: { id: 'new-acc', name: body!.name, platform: body!.platform } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, created: 6, updated: 0, skipped: 0 }) });
      },
    });
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8'), context);
    const payload = opts.payload ?? {
      platform: 'x', handle: 'Aiyafun', profile: { name: 'Aiya哎呀' },
      posts: [{ platformItemId: '111', metrics: { views: 1 } }],
    };
    return {
      ingestSelf: context.ingestSelf as (p: unknown) => Promise<Record<string, unknown>>,
      createAccount: context.createAccount as (p: unknown) => Promise<Record<string, unknown>>,
      calls, synced, removed, payload,
      ingestCall: () => calls.find((c) => c.url.endsWith('/api/ingest/self')),
      createCall: () => calls.find((c) => c.url.endsWith('/accounts') && c.method === 'POST'),
    };
  }

  const MULTI = { id: 'a-multi', name: '我的账号', platform: 'multi', status: 'active' };
  const X_ACC = { id: 'a-x', name: 'Aiya哎呀', platform: 'x', status: 'active' };

  it('🔒 只有 multi 账号时，给 X 单独建一个号（真机那条：6 条推文落进了「我的账号」）', async () => {
    const sw = loadSw({ accounts: [MULTI] });
    const r = await sw.ingestSelf(sw.payload);
    expect(r.ok).toBe(true);
    expect(sw.createCall()!.body).toMatchObject({ name: 'Aiya哎呀', platform: 'x', handle: 'Aiyafun' });
    expect(sw.ingestCall()!.body!.accountId).toBe('new-acc');
    expect(sw.ingestCall()!.body!.accountId).not.toBe('a-multi');
    expect(String(r.summary)).toContain('已新建账号「Aiya哎呀」'); // 建了号就要说出来
  });

  it('已经有同平台账号 → 直接用它，不重复建号', async () => {
    const sw = loadSw({ accounts: [MULTI, X_ACC] });
    await sw.ingestSelf(sw.payload);
    expect(sw.createCall()).toBeUndefined();
    expect(sw.ingestCall()!.body!.accountId).toBe('a-x');
  });

  it('🔒 用户显式绑定过 → 听绑定的，不按平台自作主张', async () => {
    const sw = loadSw({ accounts: [MULTI, X_ACC], bound: 'a-multi' });
    await sw.ingestSelf(sw.payload);
    expect(sw.createCall()).toBeUndefined();
    expect(sw.ingestCall()!.body!.accountId).toBe('a-multi');
  });

  it('🔒 建号不再自动绑定——绑定=「所有平台都记到这个号」，会让下一个平台的回填被判平台不符', async () => {
    const sw = loadSw({ accounts: [MULTI] });
    await sw.ingestSelf(sw.payload);
    expect(sw.synced.selfAccountId).toBeUndefined();
    expect(sw.removed).toContain('selfAccounts'); // 但账号缓存要作废，下次能看到新号
  });

  it('账号列表拉不到（断网/无令牌）→ 不带 accountId，交回服务端按老规矩匹配，绝不因此回填失败', async () => {
    const noop = () => {};
    const listener = { addListener: noop };
    const calls: Call[] = [];
    const context = vm.createContext({
      chrome: {
        runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
        storage: {
          sync: { get: () => Promise.resolve({ host: 'https://h', token: 't' }), set: () => Promise.resolve() },
          local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
          onChanged: listener,
        },
        alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
        tabs: { onRemoved: listener, create: noop, remove: noop, sendMessage: noop },
        action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
        notifications: { create: noop, onClicked: listener },
        contextMenus: { removeAll: noop, create: noop, onClicked: listener },
        sidePanel: { open: noop },
      },
      console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
      fetch: (url: string, init: { method?: string; body?: string }) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
        if (url.endsWith('/accounts')) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, created: 6 }) });
      },
    });
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8'), context);
    const r = await (context.ingestSelf as (p: unknown) => Promise<Record<string, unknown>>)({
      platform: 'x', posts: [{ platformItemId: '1' }],
    });
    expect(r.ok).toBe(true);
    expect(calls.find((c) => c.url.endsWith('/api/ingest/self'))!.body).not.toHaveProperty('accountId');
  });

  it('创作者后台没有昵称（handle 恒为 self）→ 用平台名兜底，而不是建出一个叫 self 的号', async () => {
    const sw = loadSw({
      accounts: [MULTI],
      payload: { platform: 'wechat', handle: 'self', posts: [{ platformItemId: '1', metrics: { views: 1 } }] },
    });
    await sw.ingestSelf(sw.payload);
    expect(sw.createCall()!.body!.name).toBe('公众号账号');
  });
});

describe('🔒 页内侧栏 · 没号也是一次点击', () => {
  const SIDEBAR_SRC = readFileSync(resolve(process.cwd(), 'extension/content/sidebar.js'), 'utf8');

  function mount(reply: Record<string, unknown>) {
    const dom = new JSDOM('<html><body></body></html>', { url: 'https://x.com/Aiyafun' });
    const sent: { type: string; payload?: Record<string, unknown> }[] = [];
    const chrome = {
      runtime: {
        getURL: (p: string) => `chrome-extension://test/${p}`,
        sendMessage: (msg: { type: string }, cb?: (r: unknown) => void) => {
          sent.push(msg);
          if (cb) { cb({ ok: true }); return undefined; }
          if (msg.type === 'beacon-ingest-self') return Promise.resolve(reply);
          return Promise.resolve({ ok: true });
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
      __beaconParse: () => ({
        platform: 'x', handle: 'Aiyafun', isSelf: true,
        profile: { name: 'Aiya哎呀' },
        posts: [{ platformItemId: '111', title: '推文', metrics: { views: 1 } }],
      }),
    });
    vm.runInContext(SIDEBAR_SRC, context);
    const btn = () => dom.window.document.getElementById('beacon-self-btn') as HTMLButtonElement;
    const click = async () => {
      btn().dispatchEvent(new dom.window.Event('click'));
      for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const toast = () => dom.window.document.querySelector('.beacon-toast')?.textContent ?? '';
    return { sent, btn, click, toast };
  }

  it('点一次就完事：新建的账号名出现在结果里，按钮照常复原', async () => {
    const p = mount({
      ok: true, summaryOk: true,
      summary: '✓ 已新建账号「Aiya哎呀」并回填：2 条作品',
      createdAccount: { id: 'new-acc', name: 'Aiya哎呀' },
    });
    await p.click();
    expect(p.sent.filter((m) => m.type === 'beacon-ingest-self')).toHaveLength(1); // 只发一次，不需要第二次点击
    expect(p.toast()).toContain('已新建账号「Aiya哎呀」');
    expect(p.btn().textContent).toContain('这是我的作品');
    expect(p.btn().disabled).toBe(false);
  });

  it('建号失败时把原因说出来，按钮仍复原', async () => {
    const p = mount({ ok: false, error: '想自动建号「Aiya哎呀」但没成功：账号已达上限（30 个）' });
    await p.click();
    expect(p.toast()).toContain('上限');
    expect(p.btn().disabled).toBe(false);
  });
});
