import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// 插件「一键更新」（0.7.1）。
//
// 前提事实：商店版随审核走、自托管 zip 永远最新，**两条通道天然不同版本**。
// 所以插件要自己去问、自己提示；而「更新」这个动作在两种安装方式下能做的事**不一样**：
//   · 商店安装 → requestUpdateCheck + reload，真·一键；
//   · 开发者模式加载 → Chrome 不允许扩展给自己换文件，只能下 zip + 打开扩展页，剩下要人来。
// 这份用例钉的就是「不许把第二种伪装成第一种」——那是最典型的假成功。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

type Ctx = {
  cmpVersion: (a: string, b: string) => number;
  checkForUpdate: (force?: boolean) => Promise<Record<string, unknown>>;
  applyUpdate: () => Promise<{ ok: boolean; mode: string; message: string }>;
};

function loadSw(opts: {
  current: string;
  installType: string;
  fetchImpl: unknown;
  updateCheckStatus?: string;
}) {
  const noop = () => {};
  const listener = { addListener: noop };
  const local: Record<string, unknown> = {};
  const opened: string[] = [];
  let reloaded = false;
  const context = vm.createContext({
    chrome: {
      runtime: {
        onInstalled: listener,
        onStartup: listener,
        onMessage: listener,
        id: 'abcdef',
        getManifest: () => ({ version: opts.current }),
        requestUpdateCheck: (cb: (s: string) => void) => cb(opts.updateCheckStatus ?? 'no_update'),
        reload: () => {
          reloaded = true;
        },
      },
      management: { getSelf: () => Promise.resolve({ installType: opts.installType }) },
      storage: {
        sync: { get: () => Promise.resolve({ host: 'https://beacon.iyunci.cn', token: 't' }), set: () => Promise.resolve() },
        local: {
          get: (k: string) => Promise.resolve({ [k]: local[k] }),
          set: (o: Record<string, unknown>) => {
            Object.assign(local, o);
            return Promise.resolve();
          },
        },
        onChanged: listener,
      },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      tabs: {
        onRemoved: listener,
        onUpdated: listener,
        create: (o: { url: string }) => {
          opened.push(o.url);
          return Promise.resolve({ id: 1 });
        },
        remove: noop,
        sendMessage: noop,
      },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: noop, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    URL,
    AbortController,
    fetch: opts.fetchImpl,
  });
  vm.runInContext(SW_SRC, context);
  return { ctx: context as unknown as Ctx, opened, wasReloaded: () => reloaded };
}

const okFetch = (latest: string, storeVersion: string | null = null) => () =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        ok: true,
        latest,
        zipUrl: `/downloads/beacon-collector-${latest}.zip`,
        storeUrl: 'https://chromewebstore.google.com/detail/x',
        storeVersion,
      }),
  });

describe('插件版本比较', () => {
  it('按数字段比，不是字符串比', () => {
    const { ctx } = loadSw({ current: '0.7.0', installType: 'development', fetchImpl: okFetch('0.7.1') });
    expect(ctx.cmpVersion('0.9.0', '0.10.0')).toBe(-1);
    expect(ctx.cmpVersion('0.7.1', '0.7.1')).toBe(0);
    expect(ctx.cmpVersion('1.0.0', '0.9.9')).toBe(1);
  });
});

describe('检查更新', () => {
  it('服务端有更高版本 → hasUpdate=true，并带上 zip 地址（拼成绝对地址）', async () => {
    const { ctx } = loadSw({ current: '0.7.0', installType: 'development', fetchImpl: okFetch('0.7.1') });
    const info = await ctx.checkForUpdate(true);
    expect(info.hasUpdate).toBe(true);
    expect(info.latest).toBe('0.7.1');
    expect(info.zipUrl).toBe('https://beacon.iyunci.cn/downloads/beacon-collector-0.7.1.zip');
    expect(info.from).toBe('development');
  });

  it('同版本 → 不提示', async () => {
    const { ctx } = loadSw({ current: '0.7.1', installType: 'normal', fetchImpl: okFetch('0.7.1') });
    expect((await ctx.checkForUpdate(true)).hasUpdate).toBe(false);
  });

  it('🔒 请求失败不许当成「已是最新」，要如实带 error', async () => {
    const { ctx } = loadSw({
      current: '0.7.0',
      installType: 'normal',
      fetchImpl: () => Promise.reject(new Error('连不上')),
    });
    const info = await ctx.checkForUpdate(true);
    expect(info.hasUpdate).toBe(false);
    expect(String(info.error)).toContain('无法连接服务器');
  });
});

describe('一键更新', () => {
  it('商店版 + 商店已有新包 → 拉更新并重载自己', async () => {
    const { ctx, wasReloaded } = loadSw({
      current: '0.7.0',
      installType: 'normal',
      fetchImpl: okFetch('0.7.1', '0.7.1'),
      updateCheckStatus: 'update_available',
    });
    const r = await ctx.applyUpdate();
    expect(r.mode).toBe('store');
    await new Promise((res) => setTimeout(res, 400));
    expect(wasReloaded()).toBe(true);
  });

  it('商店版但商店还在审核 → 如实说明滞后，并指路 zip（不假装更新成功）', async () => {
    const { ctx } = loadSw({
      current: '0.6.4',
      installType: 'normal',
      fetchImpl: okFetch('0.7.1', '0.6.4'),
      updateCheckStatus: 'no_update',
    });
    const r = await ctx.applyUpdate();
    expect(r.mode).toBe('store-pending');
    expect(r.message).toContain('0.6.4');
    expect(r.message).toContain('zip');
  });

  it('🔒 开发者模式装的：下 zip + 开扩展页，并明说剩下要人来（浏览器不许扩展自己换文件）', async () => {
    const { ctx, opened } = loadSw({ current: '0.7.0', installType: 'development', fetchImpl: okFetch('0.7.1') });
    const r = await ctx.applyUpdate();
    expect(r.mode).toBe('unpacked');
    expect(opened[0]).toContain('beacon-collector-0.7.1.zip');
    expect(opened[1]).toContain('chrome://extensions');
    expect(r.message).toContain('重新加载');
  });

  it('本来就是最新 → 明说已是最新，不做任何动作', async () => {
    const { ctx, opened } = loadSw({ current: '0.7.1', installType: 'development', fetchImpl: okFetch('0.7.1') });
    const r = await ctx.applyUpdate();
    expect(r.mode).toBe('noop');
    expect(opened).toEqual([]);
  });
});
