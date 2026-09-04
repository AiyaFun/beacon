import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { prisma } from '@/lib/db';
import { resolveTargetAccount, ingestOwnPostData } from '@/lib/ingest/own-post';
import { resolveDefaultAccountId } from '@/lib/ingest/own-account';

// 回填归属：插件里绑定的账号。
//
// 【为什么必须能绑】归属此前是**猜**的：按平台取第一个活跃账号（pickAccountFor）。
// 一个工作区经营两个抖音号时，这必然错一半——而挂错账号不是「显示得不对」：
// 数据看板每一页都是 where accountId = 当前选中账号，挂错了就**彻底看不见**，
// 还会带着另一个号的数字污染基线与学习信号（2026-07-25 真机事故，见 own-post.ts 注释）。
// 所以插件侧绑一个账号、回填时带 accountId 上来，让服务端不用猜。
//
// 【为什么平台对不上要报错而不是回退去猜】用户绑了「抖音·A号」却在 X 上点了回填，
// 这时任何一种自动选择都可能是错的，而错了要到数据看板上才发现。宁可让他先切账号。

const ACCOUNTS = [
  { id: 'a-dy-1', status: 'active', platform: 'douyin', name: '抖音主号' },
  { id: 'a-dy-2', status: 'active', platform: 'douyin', name: '抖音小号' },
  { id: 'a-x', status: 'active', platform: 'x', name: 'X 号' },
  { id: 'a-multi', status: 'active', platform: 'multi', name: '多平台号' },
];

describe('resolveTargetAccount · 绑了就只认绑的那个', () => {
  it('绑定命中 → 用它，不再按平台猜', () => {
    const r = resolveTargetAccount({ platform: 'douyin', accountId: 'a-dy-2' }, ACCOUNTS);
    expect(r).toEqual({ ok: true, id: 'a-dy-2' });
  });

  // 这条是这次改动的全部意义：不绑定时两个抖音号只会命中最早的那个
  it('🔒 同平台两个账号：不绑定必然落到第一个，绑定才能落到第二个', () => {
    const guess = resolveTargetAccount({ platform: 'douyin' }, ACCOUNTS);
    expect(guess).toEqual({ ok: true, id: 'a-dy-1' });
    const bound = resolveTargetAccount({ platform: 'douyin', accountId: 'a-dy-2' }, ACCOUNTS);
    expect(bound).toEqual({ ok: true, id: 'a-dy-2' });
  });

  it('🔒 绑定的账号平台对不上 → 报错，绝不回退去猜一个', () => {
    const r = resolveTargetAccount({ platform: 'x', accountId: 'a-dy-1' }, ACCOUNTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('抖音');   // 你绑的是这个
    expect(r.error).toContain('X');      // 这一页是这个
    expect(r.error).toContain('切');     // 该怎么办
  });

  it('multi（一人多平台）账号对任何平台都算对得上', () => {
    expect(resolveTargetAccount({ platform: 'x', accountId: 'a-multi' }, ACCOUNTS)).toEqual({ ok: true, id: 'a-multi' });
  });

  it('🔒 绑定的账号不在本工作区（已删除/换了工作区）→ 报错，不静默改挂别人', () => {
    const r = resolveTargetAccount({ platform: 'douyin', accountId: 'a-not-here' }, ACCOUNTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('no_account');
    expect(r.error).toContain('重新选择');
  });

  it('不绑定 → 保持原有行为（同平台活跃优先）', () => {
    expect(resolveTargetAccount({ platform: 'x' }, ACCOUNTS)).toEqual({ ok: true, id: 'a-x' });
  });
});

async function freshWorkspace(name: string) {
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't-' + name } });
  return prisma.workspace.create({ data: { tenantId: tenant.id, name } });
}

describe('resolveDefaultAccountId · 账号级数据同一套归属', () => {
  it('绑定命中 → 用它', async () => {
    const ws = await freshWorkspace('绑定测试');
    const first = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '一号', platform: 'douyin' } });
    const second = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '二号', platform: 'douyin' } });

    expect(await resolveDefaultAccountId(ws.id)).toBe(first.id);            // 不绑：最早活跃
    expect(await resolveDefaultAccountId(ws.id, second.id)).toBe(second.id); // 绑了：听绑定的
    // 绑到别的工作区的账号 → null（调用方回 404，而不是挂到本工作区随便一个号上）
    expect(await resolveDefaultAccountId(ws.id, 'someone-else')).toBeNull();
  });
});

describe('ingestOwnPostData · 端到端落到绑定的账号名下', () => {
  let wsId = '';
  let dy1 = '';
  let dy2 = '';

  beforeEach(async () => {
    const ws = await freshWorkspace('归属测试');
    wsId = ws.id;
    dy1 = (await prisma.creatorAccount.create({ data: { workspaceId: wsId, name: '主号', platform: 'douyin' } })).id;
    dy2 = (await prisma.creatorAccount.create({ data: { workspaceId: wsId, name: '小号', platform: 'douyin' } })).id;
  });

  it('带 accountId → 新建的发布记录挂在那个账号下', async () => {
    const r = await ingestOwnPostData(wsId, {
      platform: 'douyin',
      accountId: dy2,
      posts: [{ platformItemId: 'v-1', title: '一条作品', metrics: { views: 100 } }],
    });
    expect(r.ok).toBe(true);
    const rec = await prisma.publishRecord.findFirst({ where: { platformItemId: 'v-1' }, select: { accountId: true } });
    expect(rec?.accountId).toBe(dy2);
    expect(rec?.accountId).not.toBe(dy1);
  });

  it('🔒 平台对不上时一条都不入库（报错先于写库）', async () => {
    const r = await ingestOwnPostData(wsId, {
      platform: 'x',
      accountId: dy1,
      posts: [{ platformItemId: 'x-1', title: '一条推文', metrics: { views: 100 } }],
    });
    expect(r.ok).toBe(false);
    expect(await prisma.publishRecord.count({ where: { platformItemId: 'x-1' } })).toBe(0);
  });
});

// ── 插件侧：accountId 必须挂在唯一出口上 ──
// 三个入口（popup / SidePanel / 页内侧栏）都调 sw.js 的 ingestSelf。挂在各自的点击处理里
// 迟早会漏一个，而漏掉的那个入口发出去的数据会被后端按平台猜归属——错了还查不出来。
describe('🔒 sw.js · 三个入口共用的出口自动带上 accountId', () => {
  function loadSw(bound: string | undefined) {
    const noop = () => {};
    const listener = { addListener: noop };
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const context = vm.createContext({
      chrome: {
        runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
        storage: {
          sync: { get: () => Promise.resolve({ host: 'https://h', token: 't', selfAccountId: bound }), set: () => Promise.resolve() },
          local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
          onChanged: listener,
        },
        alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
        tabs: { onRemoved: listener, onUpdated: listener, create: noop, remove: noop, sendMessage: noop },
        action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
        notifications: { create: noop, onClicked: listener },
        contextMenus: { removeAll: noop, create: noop, onClicked: listener },
        sidePanel: { open: noop },
      },
      console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
      fetch: (url: string, init: { body: string }) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, created: 1 }) });
      },
    });
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8'), context);
    return { ingestSelf: context.ingestSelf as (p: unknown) => Promise<unknown>, sent };
  }

  it('绑定了 → 请求体里带 accountId', async () => {
    const sw = loadSw('acc-42');
    await sw.ingestSelf({ platform: 'x', posts: [{ platformItemId: '1' }] });
    expect(sw.sent[0].url).toContain('/api/ingest/self');
    expect(sw.sent[0].body.accountId).toBe('acc-42');
  });

  it('没绑定 → 不带（后端退回按平台匹配，与老版本插件行为一致）', async () => {
    const sw = loadSw(undefined);
    await sw.ingestSelf({ platform: 'x', posts: [{ platformItemId: '1' }] });
    expect(sw.sent[0].body).not.toHaveProperty('accountId');
  });

  it('调用方已经指定了 accountId 时不被覆盖', async () => {
    const sw = loadSw('acc-42');
    await sw.ingestSelf({ platform: 'x', accountId: 'acc-explicit', posts: [{ platformItemId: '1' }] });
    expect(sw.sent[0].body.accountId).toBe('acc-explicit');
  });
});

// ── 三个界面上都要有这个下拉框 ──
const SURFACES: [string, string, string, string][] = [
  ['SidePanel', 'extension/sidepanel.js', 'extension/sidepanel.html', 'spAccountSel'],
  ['popup', 'extension/popup.js', 'extension/popup.html', 'accountSel'],
  ['设置页', 'extension/options.js', 'extension/options.html', 'selfAccount'],
];

describe.each(SURFACES)('%s · 账号绑定下拉框', (_name, jsPath, htmlPath, selId) => {
  function mount() {
    const dom = new JSDOM(readFileSync(resolve(process.cwd(), htmlPath), 'utf8'), {
      url: 'chrome-extension://test/panel.html',
    });
    const sent: { type: string; accountId?: string }[] = [];
    const chrome = {
      runtime: {
        sendMessage: (msg: { type: string }) => {
          sent.push(msg);
          if (msg.type === 'beacon-get-config') return Promise.resolve({ host: 'https://beacon.iyunci.cn' });
          if (msg.type === 'beacon-get-competitors') return Promise.resolve({ ok: true, competitors: [] });
          if (msg.type === 'beacon-get-accounts') {
            return Promise.resolve({
              ok: true,
              selfAccountId: 'a-2',
              accounts: [
                { id: 'a-1', name: '主号', platform: 'douyin', status: 'active' },
                { id: 'a-2', name: '<script>坏名字', platform: 'x', status: 'paused' },
              ],
            });
          }
          return Promise.resolve({ ok: true });
        },
        openOptionsPage: () => {},
        onMessage: { addListener: () => {} },
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1, url: 'https://x.com/me', title: 't' }]),
        sendMessage: () => Promise.resolve({ ok: false }),
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
    const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
    return { dom, sent, settle, sel: () => dom.window.document.getElementById(selId) as HTMLSelectElement };
  }

  it('拉到账号后填进下拉框，并选中已绑定的那个', async () => {
    const p = mount();
    await p.settle();
    const sel = p.sel();
    expect(sel.options.length).toBe(3); // （自动匹配）+ 2 个账号
    expect(sel.value).toBe('a-2');
  });

  it('选项文案带平台名与停用状态，且账号名按文本插入（用户填的名字可能带 < >）', async () => {
    const p = mount();
    await p.settle();
    const opt = Array.from(p.sel().options).find((o) => o.value === 'a-2')!;
    expect(opt.textContent).toContain('X');
    expect(opt.textContent).toContain('已停用');
    expect(opt.textContent).toContain('<script>坏名字');
    expect(p.sel().querySelector('script')).toBeNull();
  });

  it('改选后写回绑定', async () => {
    const p = mount();
    await p.settle();
    const sel = p.sel();
    sel.value = 'a-1';
    sel.dispatchEvent(new p.dom.window.Event('change'));
    await p.settle();
    expect(p.sent.filter((m) => m.type === 'beacon-set-account').at(-1)).toMatchObject({ accountId: 'a-1' });
  });

  it('选回「按平台自动匹配」= 解除绑定（传空串）', async () => {
    const p = mount();
    await p.settle();
    const sel = p.sel();
    sel.value = '';
    sel.dispatchEvent(new p.dom.window.Event('change'));
    await p.settle();
    expect(p.sent.filter((m) => m.type === 'beacon-set-account').at(-1)).toMatchObject({ accountId: '' });
  });
});
