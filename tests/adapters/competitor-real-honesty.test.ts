import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BilibiliAdapter } from '@/lib/adapters/competitor-real';

// 数据源要么给出真数据，要么如实说自己坏了 —— 不许有第三种状态。
//
// 2026-08-24 抓取合规审查时真机实测发现：B 站这条通道**一条数据都取不到**
// （路径里的 `wbi` 是 B 站的接口签名机制，URL 必须带 w_rid/wts，我们从来没算过），
// 而它当时的表现是：
//   · fetchPosts → `data?.data?.list?.vlist ?? []` 把失败变成**空数组**，
//     registry 据此判定「真实通道确认这个号没作品」，既不熔断也不打降级标记；
//   · health()   → 硬编码 `{ ok: true }`，健康看板长期对用户说「正常」。
// 两件加起来，用户看到的是「B 站竞对一条作品都没有」，而不是「这个数据源坏了」。
// 本文件钉住修复后的性质。

const SRC = readFileSync(resolve(process.cwd(), 'lib/adapters/competitor-real.ts'), 'utf8');
const codeLines = SRC.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));

afterEach(() => vi.unstubAllGlobals());

/** 让 fetch 返回一个「HTTP 200 但 body 里 code≠0」的响应——B 站失败的典型形状 */
function stubBiliError(code: number, message: string) {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify({ code, message, data: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('B 站适配器：失败必须响，不许静默返回空', () => {
  it('🔒 HTTP 200 + code=-403（缺 wbi 签名）→ 抛错，不是返回 []', async () => {
    stubBiliError(-403, '访问权限不足');
    await expect(new BilibiliAdapter().fetchPosts('946974')).rejects.toThrow(/-403|访问权限不足/);
  });

  it('🔒 HTTP 200 + code=-352（风控）→ 抛错', async () => {
    stubBiliError(-352, '风控校验失败');
    await expect(new BilibiliAdapter().fetchPosts('946974')).rejects.toThrow(/-352|风控/);
  });

  it('code=0 且有数据 → 正常解析（别把闸修成「一律抛错」）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: { list: { vlist: [{ bvid: 'BV1xx', title: '标题', play: 100, comment: 5, created: 1700000000 }] } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const posts = await new BilibiliAdapter().fetchPosts('946974');
    expect(posts).toHaveLength(1);
    expect(posts[0].platformItemId).toBe('BV1xx');
  });

  it('code=0 但确实没作品 → 空数组，不抛错（「没作品」和「取不到」是两回事）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ code: 0, data: { list: { vlist: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(new BilibiliAdapter().fetchPosts('946974')).resolves.toEqual([]);
  });
});

describe('B 站 health()：真探，不报平安', () => {
  it('🔒 接口拒绝时 health 必须 ok:false，并带上真实原因', async () => {
    stubBiliError(-352, '风控校验失败');
    const h = await new BilibiliAdapter().health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/-352|风控/);
  });

  it('接口正常时 health 才 ok:true', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ code: 0, data: { list: { vlist: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect((await new BilibiliAdapter().health()).ok).toBe(true);
  });

  it('🔒 health 里真的发了请求 —— 硬编码 ok:true 那种写法不许回来', async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { list: { vlist: [] } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', spy);
    await new BilibiliAdapter().health();
    expect(spy, 'health() 一个请求都没发，那它凭什么说自己 ok').toHaveBeenCalled();
  });
});

describe('🔒 不实现 wbi 签名', () => {
  // wbi 签名**就是** B 站的技术措施本身。本轮刚把伪装 UA 去掉，理由是「不规避目标站点的
  // 技术措施」；转头去破解它的签名算法是同一件事更重的版本。要恢复 B 站数据源，
  // 正路是商业数据服务商或官方开放平台。这条守卫拦住「顺手把签名算出来」那一刻。
  it('代码里没有 w_rid / wts 的生成逻辑', () => {
    const bad = codeLines.filter((l) => /w_rid|wts=|mixinKey|getWbiKeys/i.test(l));
    expect(bad, `疑似在实现 wbi 签名：\n${bad.join('\n')}`).toEqual([]);
  });

  // 【这里曾经有第二条用例，断言「注释里保留了为什么不做的理由」——被 tests/fake-green-guard.test.ts
  //  当场判为假绿，判得对：它守的是注释，代码怎么改都绿。真正拦住这件事的是上面那条
  //  （扫代码行找 w_rid/wts/mixinKey），已 mutation 验证能红。理由留在被守的文件的注释里
  //  给人读就够了，不该再写一条守注释的测试来自我安慰。】
});

describe('🔒 其它适配器的 health 不冒充连通性', () => {
  it('只验配置的那几家，detail 要明说「只验配置」', () => {
    // 它们按次计费，探连通会烧用户的钱，所以只验配置是对的——
    // 但看板上必须说清楚，否则用户以为「显示正常」等于「取得到数据」。
    const configured = SRC.match(/detail: '[^']*已配置密钥[^']*'/g) ?? [];
    expect(configured.length, 'TikHub/YouTube/twitterapi.io/新榜 四家').toBe(4);
    for (const d of configured) expect(d).toContain('只验配置');
  });
});
