import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { WECHAT_COLLECT_RULES } from '@/lib/wechat-collect-rules';

// 公众号名 → fakeid 的本机缓存（2026-08-13 用户真机撞频控之后加的）。
//
// 采一个公众号是三个请求：searchbiz 按名字搜号换 fakeid，再最多两页 appmsgpublish。
// **搜号那一个口的配额最紧**，而 fakeid 对一个号是固定的——每次采集都拿名字去重问一遍
// 早就知道的答案，等于每次都先去撞最窄的那道门。存下来之后重复采集 3 个请求降到 2 个。
//
// 这份用例钉的是四件事，每一件都是「省配额」这个目的本身：
//   ① 第一次采完要真的把 fakeid 写进本机；
//   ② 第二次要真的把它递给内容脚本（不递＝白存）；
//   ③ 命中续用不刷新时间戳（否则天天在采的号永远轮不到复核，TTL 等于没有）；
//   ④ 被证伪的 fakeid 要当场扔掉（留着就是每次都拿它去换一个必然的错误）。

const SW_SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

type Store = Record<string, unknown>;
type Msg = { type: string; name?: string; fakeid?: unknown };

/** chrome.storage 的 get 支持 'key' 与 ['k1','k2'] 两种传法，mock 必须两种都认 */
function pick(store: Store, keys: unknown): Store {
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (Array.isArray(keys)) {
    const out: Store = {};
    for (const k of keys) out[String(k)] = store[String(k)];
    return out;
  }
  return { ...store };
}

type Reply = Record<string, unknown>;

function loadSw(opts: { local?: Store; reply?: Reply | ((n: number) => Reply) } = {}) {
  const noop = () => {};
  const listener = { addListener: noop };
  const local: Store = {
    // 风险确认（0.9.8 起 collectWechatOne 的第一道闸）预置为已确认——本文件测的是
    // 确认**之后**的行为。闸本身由 tests/legal/wechat-risk-ack.test.ts 与本文件末尾
    // 那条「没确认时一个请求都不发」守着。
    wechatRiskAck: { version: 1, at: Date.now() },
    ...(opts.local ?? {}),
  };
  const sent: Msg[] = [];
  let asked = 0;

  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop, sendMessage: () => Promise.resolve() },
      storage: {
        sync: { get: () => Promise.resolve({ host: 'https://h', token: 't' }), set: () => Promise.resolve() },
        local: {
          get: (k: unknown) => Promise.resolve(pick(local, k)),
          set: (o: Store) => { Object.assign(local, o); return Promise.resolve(); },
          remove: (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) delete local[key];
            return Promise.resolve();
          },
        },
        onChanged: listener,
      },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      scripting: { executeScript: () => Promise.resolve() },
      tabs: {
        onRemoved: listener,
        query: () => Promise.resolve([{ id: 7, url: 'https://mp.weixin.qq.com/cgi-bin/home?token=1234567890' }]),
        create: ({ url }: { url: string }) => Promise.resolve({ id: 8, url }),
        remove: () => Promise.resolve(),
        sendMessage: (_id: number, m: Msg) => {
          sent.push(m);
          asked++;
          const r = typeof opts.reply === 'function' ? opts.reply(asked) : opts.reply;
          return Promise.resolve(
            r ?? {
              ok: true,
              fakeid: 'MTI0MDU3NDYwMQ==',
              payload: { platform: 'wechat', handle: '央视新闻', posts: [] },
            },
          );
        },
      },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: noop, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, URL, AbortController,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, competitor: '央视新闻' }) }),
  });
  vm.runInContext(SW_SRC, context);
  return {
    collectWechatOne: context.collectWechatOne as (name: string) => Promise<Record<string, unknown>>,
    local,
    sent,
  };
}

const DAY = 86400_000;
const cache = (local: Store) => local.wechatFakeids as Record<string, { fakeid: string; at: number }> | undefined;

describe('公众号 fakeid 缓存 · 省掉配额最紧的那个搜号请求', () => {
  it('第一次采：没有可递的 fakeid，采完把它记下来', async () => {
    const sw = loadSw();
    const r = await sw.collectWechatOne('央视新闻');
    expect(r.ok).toBe(true);
    expect(sw.sent[0].fakeid).toBe(''); // 没缓存就是空串，内容脚本据此照常搜号
    expect(cache(sw.local)?.['央视新闻'].fakeid).toBe('MTI0MDU3NDYwMQ==');
  });

  it('🔒 第二次采：把缓存里的 fakeid 递给内容脚本（不递＝白存，搜号照烧不误）', async () => {
    const sw = loadSw({ local: { wechatFakeids: { 央视新闻: { fakeid: 'CACHED==', at: Date.now() } } } });
    await sw.collectWechatOne('央视新闻');
    expect(sw.sent[0].fakeid).toBe('CACHED==');
  });

  it(`超过 ${WECHAT_COLLECT_RULES.fakeidCacheDays} 天的旧记录当没有：到期复核一次，兜住「存错了/号迁移了」`, async () => {
    const stale = Date.now() - (WECHAT_COLLECT_RULES.fakeidCacheDays + 1) * DAY;
    const sw = loadSw({ local: { wechatFakeids: { 央视新闻: { fakeid: 'CACHED==', at: stale } } } });
    await sw.collectWechatOne('央视新闻');
    expect(sw.sent[0].fakeid).toBe('');
  });

  it('🔒 命中续用不刷新时间戳——否则天天在采的号永远轮不到复核，TTL 等于没有', async () => {
    const at = Date.now() - 20 * DAY;
    const sw = loadSw({ local: { wechatFakeids: { 央视新闻: { fakeid: 'MTI0MDU3NDYwMQ==', at } } } });
    await sw.collectWechatOne('央视新闻');
    expect(cache(sw.local)?.['央视新闻'].at).toBe(at);
  });

  it('内容脚本报 staleFakeid（拿它拉列表微信不认）→ 当场扔掉，重搜到的新值立刻顶上', async () => {
    const sw = loadSw({
      local: { wechatFakeids: { 央视新闻: { fakeid: 'OLD==', at: Date.now() } } },
      reply: { ok: true, staleFakeid: true, fakeid: 'NEW==', payload: { platform: 'wechat', handle: '央视新闻', posts: [] } },
    });
    await sw.collectWechatOne('央视新闻');
    expect(cache(sw.local)?.['央视新闻'].fakeid).toBe('NEW==');
  });

  it('重搜也没救回来（整趟失败）→ 缓存里那条必须消失，不能留着下次继续撞', async () => {
    const sw = loadSw({
      local: { wechatFakeids: { 央视新闻: { fakeid: 'OLD==', at: Date.now() } } },
      reply: { ok: false, staleFakeid: true, code: 'not_found', error: '后台搜不到' },
    });
    const r = await sw.collectWechatOne('央视新闻');
    expect(r.ok).toBe(false);
    expect(cache(sw.local)?.['央视新闻']).toBeUndefined();
  });

  it('采集失败但与 fakeid 无关（如频控）→ 缓存原样留着，别把好东西一起赔进去', async () => {
    const at = Date.now();
    const sw = loadSw({
      local: { wechatFakeids: { 央视新闻: { fakeid: 'CACHED==', at } } },
      reply: { ok: false, code: 'rate_limited', error: '微信提示操作过于频繁' },
    });
    await sw.collectWechatOne('央视新闻');
    expect(cache(sw.local)?.['央视新闻']).toEqual({ fakeid: 'CACHED==', at });
  });

  it('注销时要连这份缓存一起抹掉（每加一个缓存键就要往 LOCAL_KEYS_ON_UNLINK 补一行）', () => {
    expect(SW_SRC).toMatch(/LOCAL_KEYS_ON_UNLINK = \[[^\]]*'wechatFakeids'/s);
  });
});
