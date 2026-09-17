import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { itemListJsonLd, breadcrumbJsonLd, hotItemEntries } from '@/lib/geo/item-list';
import { JsonLd } from '@/components/JsonLd';

// /hotlists 与 /topics-today 的结构化清单（2026-09-17）。
//
// 这一层有两个要命的地方，都要钉住：
//   ① **它含外部平台来的文本**（热榜标题）。直接 JSON.stringify 进 <script> 里，
//      标题里一个 `</script>` 就能跳出脚本上下文 —— 一个现成的 XSS。
//   ② **它可能是空的**（库里还没采过热榜）。输出一个零条的 ItemList，
//      等于对引擎宣称「这一页有个榜单」然后给出空清单，比什么都不说更糟。

describe('🔒 JsonLd 必须转义，外部文本进不了脚本上下文', () => {
  it('热榜标题里的 </script> 跳不出脚本块', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const html = renderToStaticMarkup(
      createElement(JsonLd, { data: itemListJsonLd('/hotlists', '榜', '说明', [{ name: evil }]) }),
    );
    expect(
      html.includes('</script><img'),
      '外部来的标题原样进了 HTML —— 这是 XSS。JSON.stringify 不转义 `<`，必须自己转。',
    ).toBe(false);
    // 转义后仍然是合法 JSON，且内容没丢
    const body = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
    expect(JSON.parse(body).itemListElement[0].name).toBe(evil);
  });

  it('U+2028 / U+2029 也要转（JSON 里合法，JS 源码里是换行）', () => {
    const html = renderToStaticMarkup(
      createElement(JsonLd, { data: itemListJsonLd('/x', '榜', '说明', [{ name: `a b c` }]) }),
    );
    expect(html).not.toContain(' ');
    expect(html).not.toContain(' ');
  });

  it('data 为 null 时什么都不渲染', () => {
    expect(renderToStaticMarkup(createElement(JsonLd, { data: null }))).toBe('');
  });
});

describe('空清单不许输出', () => {
  it('一条都没有 → null', () => {
    expect(itemListJsonLd('/hotlists', '榜', '说明', [])).toBeNull();
  });

  it('全是空标题 → 也是 null（不是一个零条的清单）', () => {
    expect(itemListJsonLd('/hotlists', '榜', '说明', [{ name: '  ' }, { name: '' }])).toBeNull();
  });
});

describe('清单本身', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ name: `话题${i + 1}`, url: `https://example.com/${i}` }));

  it('条数有上限（这段 JSON 会进 HTML，条数就是首屏体积）', () => {
    const list = itemListJsonLd('/hotlists', '榜', '说明', entries) as { itemListElement: unknown[] };
    expect(list.itemListElement.length).toBeLessThanOrEqual(30);
  });

  it('🔒 numberOfItems 写的是这段数据里真有几条，不是库里有几条', () => {
    const list = itemListJsonLd('/hotlists', '榜', '说明', entries) as { numberOfItems: number; itemListElement: unknown[] };
    expect(
      list.numberOfItems,
      'numberOfItems 与实际条目数对不上 —— 拿截断前的总数冒充清单长度，引擎数得出来。',
    ).toBe(list.itemListElement.length);
  });

  it('position 从 1 开始且连续', () => {
    const list = itemListJsonLd('/x', '榜', '说明', entries.slice(0, 5)) as { itemListElement: { position: number }[] };
    expect(list.itemListElement.map((e) => e.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('没有 url 的条目不写空 url 字段', () => {
    const list = itemListJsonLd('/x', '榜', '说明', [{ name: '常青题' }]) as { itemListElement: Record<string, unknown>[] };
    expect('url' in list.itemListElement[0]).toBe(false);
  });

  it('标题里的换行被压平（多行名字在结果里会截断得很难看）', () => {
    const list = itemListJsonLd('/x', '榜', '说明', [{ name: '上\n下' }]) as { itemListElement: { name: string }[] };
    expect(list.itemListElement[0].name).toBe('上 下');
  });
});

describe('面包屑', () => {
  it('两级：站点 → 本页', () => {
    const b = breadcrumbJsonLd('/hotlists', '全网热榜') as { itemListElement: { position: number; name: string; item: string }[] };
    expect(b.itemListElement.map((e) => e.name)).toEqual(['烽火台', '全网热榜']);
    expect(b.itemListElement[1].item).toMatch(/\/hotlists$/);
  });
});

describe('🔒 热榜条目：只发最近一次采集，且跨平台轮转', () => {
  // 【这条守卫是线上真踩出来的】1.3.81 首发时结构化数据里前 23 条**全都自称「第 1 位」**，
  // 而它们分别来自 09-15 / 09-16 / 09-17 三天——HotItem 存的是历次快照，
  // 按 rank 全局排序就等于把三天的冠军堆在一起，还各自宣称自己是第一。
  // 同时百度一家占了 30 席里的 11 席，一个叫「全网热榜聚合」的清单名不副实。
  const brand = (k: string) => ({ baidu: '百度', douyin: '抖音', weibo: '微博' }[k] ?? k);
  const at = (iso: string) => new Date(iso);

  /** 造一批「三天的快照堆在一起」的数据：每天每源都有 rank 1..3 */
  const items = [
    ...['2026-09-15T08:00:00Z', '2026-09-16T08:00:00Z', '2026-09-17T08:00:00Z'].flatMap((day) =>
      ['baidu', 'douyin', 'weibo'].flatMap((src) =>
        [1, 2, 3].map((rank) => ({
          source: src, rank, title: `${src}-${day.slice(5, 10)}-第${rank}`,
          url: `https://e.com/${src}/${rank}`, fetchedAt: at(day), isMock: false,
        })),
      ),
    ),
  ];

  it('只取每个源最近一次采集的那一批（旧快照一条都不许进）', () => {
    const out = hotItemEntries(items, brand);
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) {
      expect(e.name, `「${e.name}」来自旧快照，不该出现在结构化数据里`).toContain('09-17');
    }
  });

  it('🔒 同一个平台不许出现重复名次（重复=在对搜索引擎说假话）', () => {
    const seen = new Set<string>();
    for (const e of hotItemEntries(items, brand)) {
      const key = e.description ?? '';
      expect(seen.has(key), `「${key}」出现了两次——两个不同条目不可能同时是第 N 位`).toBe(false);
      seen.add(key);
    }
  });

  it('跨平台轮转：前三条来自三个不同平台，而不是一家占满', () => {
    const out = hotItemEntries(items, brand);
    const firstThree = out.slice(0, 3).map((e) => (e.description ?? '').replace(/热榜第.*/, ''));
    expect(new Set(firstThree).size, `前三条来自 ${firstThree.join('/')}，没有轮转`).toBe(3);
  });

  it('示例数据一条都不许进', () => {
    const withMock = [...items, {
      source: 'baidu', rank: 1, title: '示例热点', url: '#',
      fetchedAt: at('2026-09-17T08:00:00Z'), isMock: true,
    }];
    expect(hotItemEntries(withMock, brand).some((e) => e.name === '示例热点')).toBe(false);
  });

  it('没有 rank 时只说平台，不编一个名次出来', () => {
    const noRank = [{ source: 'baidu', rank: null, title: 'x', url: null, fetchedAt: at('2026-09-17T08:00:00Z'), isMock: false }];
    expect(hotItemEntries(noRank, brand)[0].description).toBe('百度热榜');
  });
});
