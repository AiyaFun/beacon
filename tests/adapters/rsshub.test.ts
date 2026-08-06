import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCompetitorPosts } from '@/lib/adapters/registry';

// 竞对采集 · RSSHub 开源自建通道（方案二）+ 主备链语义。
// 链：真实源（商业/官方/B站公开） → RSSHub（配 BEACON_RSSHUB_BASE_URL 才在链上） → Mock（零真实通道才兜底）。
// 全程 stub 全局 fetch，零真实网络（铁律）。

// RSSHub ?format=json 的 JSON Feed 1.1 响应形状
const feedPayload = {
  version: 'https://jsonfeed.org/version/1.1',
  title: '某UP主的 bilibili 空间',
  items: [
    {
      id: 'https://www.bilibili.com/video/BV1xx411c7mD',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      title: '新作品标题一',
      content_html: '<p>这是&nbsp;<b>简介</b>正文</p>',
      date_published: '2026-07-18T08:00:00.000Z',
    },
    {
      id: 'https://www.bilibili.com/video/BV1yy411c7mE',
      url: 'https://www.bilibili.com/video/BV1yy411c7mE',
      title: '新作品标题二',
      date_published: '2026-07-17T08:00:00.000Z',
    },
  ],
};

function stubFetch(impl: (url: string) => Promise<unknown>) {
  const fn = vi.fn((input: RequestInfo | URL) => impl(String(input)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const okFeed = () => ({ ok: true, status: 200, json: async () => feedPayload });

beforeEach(() => {
  // 钉死默认态：全部真实通道关闭
  vi.stubEnv('BEACON_RSSHUB_BASE_URL', '');
  vi.stubEnv('BEACON_BILIBILI_ENABLED', '');
  vi.stubEnv('BEACON_TIKHUB_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('rsshub · env 门控（铁律：无 env 零网络）', () => {
  it('不配 BEACON_RSSHUB_BASE_URL：链为空 → Mock，不发任何请求', async () => {
    const fetchSpy = stubFetch(() => Promise.resolve(okFeed()));
    const r = await fetchCompetitorPosts('bilibili', '12345');
    expect(r.via).toBe('mock-competitor');
    expect(r.degraded).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('配了实例但平台无路由（wechat）：仍走 Mock，不发请求', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    const fetchSpy = stubFetch(() => Promise.resolve(okFeed()));
    const r = await fetchCompetitorPosts('wechat', 'some-account');
    expect(r.via).toBe('mock-competitor');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('rsshub · JSON Feed 归一化', () => {
  beforeEach(() => vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200'));

  it('抖音无 TikHub key 时 RSSHub 是主源：路由/格式/条目映射正确', async () => {
    const douyinFeed = {
      items: [
        {
          url: 'https://www.douyin.com/video/7300000000000000000',
          title: '抖音新视频',
          date_published: '2026-07-18T00:00:00.000Z',
        },
      ],
    };
    const fetchSpy = stubFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => douyinFeed }));
    const r = await fetchCompetitorPosts('douyin', 'MS4wLjABAAAA-test');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain('http://rsshub:1200/douyin/user/MS4wLjABAAAA-test');
    expect(url).toContain('format=json');
    expect(r.via).toBe('rsshub');
    expect(r.degraded).toBe(false);
    expect(r.posts[0]).toMatchObject({
      platform: 'douyin',
      platformItemId: '7300000000000000000', // 从 URL 提取平台原生 ID，与 TikHub 通道对齐
      title: '抖音新视频',
    });
    expect(r.posts[0].metrics).toBeUndefined(); // RSS 无指标——不给 metrics，不覆盖别的通道
  });

  it('content_html 剥标签成摘要；date_published 解析为 Date', async () => {
    vi.stubEnv('BEACON_BILIBILI_ENABLED', ''); // 只留 rsshub
    stubFetch(() => Promise.resolve(okFeed()));
    const r = await fetchCompetitorPosts('bilibili', '12345');
    expect(r.posts).toHaveLength(2);
    expect(r.posts[0].platformItemId).toBe('BV1xx411c7mD');
    expect(r.posts[0].summary).toBe('这是 简介 正文');
    expect(r.posts[0].publishedAt?.toISOString()).toBe('2026-07-18T08:00:00.000Z');
  });
});

describe('rsshub · 主备链语义', () => {
  it('B站公开接口失败 → 降级到 RSSHub 备源', async () => {
    vi.stubEnv('BEACON_BILIBILI_ENABLED', '1');
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    stubFetch((url) =>
      url.includes('api.bilibili.com')
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(okFeed()),
    );
    const r = await fetchCompetitorPosts('bilibili', '12345');
    expect(r.via).toBe('rsshub');
    expect(r.degraded).toBe(false);
    expect(r.posts).toHaveLength(2);
  });

  it('真实通道配置了但全部失败：返回空 + degraded，绝不落 Mock（防生产数据污染）', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    stubFetch(() => Promise.reject(new TypeError('network unreachable')));
    const r = await fetchCompetitorPosts('douyin', 'MS4wLjABAAAA-test');
    expect(r.via).toBe('none');
    expect(r.degraded).toBe(true);
    expect(r.posts).toHaveLength(0); // 不喂假数据
  });

  it('真实通道成功但确实没作品：空 + degraded=false（真没发过 ≠ 通道故障）', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    stubFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) }));
    const r = await fetchCompetitorPosts('douyin', 'MS4wLjABAAAA-test');
    expect(r.via).toBe('rsshub');
    expect(r.degraded).toBe(false);
    expect(r.posts).toHaveLength(0);
  });

  it('RSSHub 返回非 200 视为通道失败', async () => {
    vi.stubEnv('BEACON_RSSHUB_BASE_URL', 'http://rsshub:1200');
    stubFetch(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    const r = await fetchCompetitorPosts('xiaohongshu', 'abc123');
    expect(r.via).toBe('none');
    expect(r.degraded).toBe(true);
  });
});
