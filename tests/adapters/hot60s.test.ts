import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchHotSource, fetchAllHot, hotSourceMode } from '@/lib/adapters/registry';
import { HOT_SOURCES } from '@/lib/constants';

// 热榜 60s 免 key 通道：开关语义（dev 默认离线 Mock / 生产默认接真）+ 逐源优雅降级。
// 全程 stub 全局 fetch，零真实网络（铁律）。setup 已把 NODE_ENV 置 'test'（非生产）、
// BEACON_HOT60S 置 '0'——即默认走 Mock。要走 60s 联网路径的用例自己 stubEnv 打开。

// 60s API 的真实响应形状（v2）
const ok60sPayload = {
  code: 200,
  data: [
    { title: '真实热榜标题一', link: 'https://example.com/1', hot_value: 123456, detail: '摘要' },
    { title: '真实热榜标题二', link: 'https://example.com/2', hot_value: 65432 },
  ],
};

function stubFetch(impl: (url: string) => Promise<unknown>) {
  const fn = vi.fn((input: RequestInfo | URL) => impl(String(input)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const okResponse = () => ({ ok: true, status: 200, json: async () => ok60sPayload });

beforeEach(() => {
  // 显式钉死两个开关的默认态，防外部 CI 环境注入干扰
  vi.stubEnv('BEACON_60S_DISABLED', '');
  vi.stubEnv('BEACON_DAILYHOT_BASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('hot60s · 开关语义', () => {
  it("BEACON_HOT60S='0' 时纯 Mock，不发任何请求", async () => {
    vi.stubEnv('BEACON_HOT60S', '0');
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('weibo');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true); // 落库后 HotItem.isMock=true
    expect(r.entries.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("非生产态显式 BEACON_HOT60S='1' 时才走 60s 真实数据，degraded=false", async () => {
    vi.stubEnv('BEACON_HOT60S', '1');
    stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('weibo');
    expect(r.via).toBe('60s-public');
    expect(r.degraded).toBe(false);
    expect(r.entries[0]).toMatchObject({ source: 'weibo', rank: 1, title: '真实热榜标题一', heat: 123456 });
  });

  it('非生产态默认离线：不设 BEACON_HOT60S 时纯 Mock、零网络（铁律：全新 clone 跑 dev）', async () => {
    vi.stubEnv('BEACON_HOT60S', undefined); // 谁都没设这个开关的真实情形
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('weibo');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hotSourceMode()).toBe('mock');
  });

  it('生产态默认接真：不设 BEACON_HOT60S 时走 60s', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_HOT60S', undefined);
    stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('weibo');
    expect(r.via).toBe('60s-public');
    expect(r.degraded).toBe(false);
    expect(hotSourceMode()).toBe('60s');
  });

  it("生产态显式 BEACON_HOT60S='0' 才关，回退 Mock、不发请求", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_HOT60S', '0');
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('weibo');
    expect(r.via).toBe('mock-hot');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hotSourceMode()).toBe('mock');
  });

  it("BEACON_60S_DISABLED='1' 任何环境都强制关（兼容早期硬关开关）", () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_HOT60S', '1'); // 即便显式想开，硬关开关也压过它
    vi.stubEnv('BEACON_60S_DISABLED', '1');
    expect(hotSourceMode()).toBe('mock');
  });

  it('hotSourceMode 如实反映三态', () => {
    vi.stubEnv('BEACON_HOT60S', '1');
    expect(hotSourceMode()).toBe('60s');
    vi.stubEnv('BEACON_HOT60S', '0');
    expect(hotSourceMode()).toBe('mock');
    vi.stubEnv('BEACON_DAILYHOT_BASE_URL', 'http://dailyhot:6688');
    expect(hotSourceMode()).toBe('dailyhot'); // 配了自建实例就优先自建
  });
});

describe('hot60s · 逐源优雅降级', () => {
  beforeEach(() => vi.stubEnv('BEACON_HOT60S', '1'));

  it('单源请求失败 → 该源回退 Mock（isMock 语义），不 throw', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const r = await fetchHotSource('douyin');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0); // 不开天窗
  });

  it('超时（AbortError）同样回退 Mock', async () => {
    stubFetch(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError')));
    const r = await fetchHotSource('zhihu');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
  });

  it('HTTP 非 200 / code 异常回退 Mock', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    const r = await fetchHotSource('toutiao');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
  });

  it('单源失败不影响其他源', async () => {
    stubFetch((url) => (url.includes('/weibo') ? Promise.reject(new Error('boom')) : Promise.resolve(okResponse())));
    const bad = await fetchHotSource('weibo');
    const good = await fetchHotSource('douyin');
    expect(bad.via).toBe('mock-hot');
    expect(bad.degraded).toBe(true);
    expect(good.via).toBe('60s-public');
    expect(good.degraded).toBe(false);
  });

  it('60s 不覆盖的源（如小红书）直接走 Mock，不发请求', async () => {
    const fetchSpy = stubFetch(() => Promise.resolve(okResponse()));
    const r = await fetchHotSource('xiaohongshu');
    expect(r.via).toBe('mock-hot');
    expect(r.degraded).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('完全离线时 fetchAllHot 九源全通，全部落 Mock，绝不整体 throw', async () => {
    stubFetch(() => Promise.reject(new TypeError('network unreachable')));
    const all = await fetchAllHot();
    expect(all).toHaveLength(HOT_SOURCES.length);
    for (const r of all) {
      expect(r.via).toBe('mock-hot');
      expect(r.degraded).toBe(true);
      expect(r.entries.length).toBeGreaterThan(0);
    }
  });
});
