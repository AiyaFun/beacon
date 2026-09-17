import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE_SEO, ROOT_USES_SITE_DEFAULT, pageMetadata } from '@/lib/geo/page-seo';
import { allowedByRobots } from '@/lib/geo/public-surface';

// 「每一页都要有自己的标题」常驻守卫（2026-09-17）。
//
// ── 这道守卫拦的是什么 ──
// 一个页面不写自己的 metadata，就**静默**沿用根布局的全站默认值。
// 不报错、不掉功能、本地开发看不出来——只有在搜索结果页上才会现形：
// 六个页面六条一样的标题。上一轮补了四页，/desktop /extension /login 三页漏了半个月，
// 而它们**一直在 sitemap.xml 里被递交给搜索引擎**。
//
// 靠人去数「sitemap 里有几个 URL、其中几个有 metadata」治不了复发，所以钉成守卫。

const ROOT = process.cwd();

/**
 * 从 app/sitemap.ts 里把递交的路径抠出来。
 *
 * 【为什么读源码而不是 import 那个函数】sitemap.ts 里调了 next/headers，
 * 在 vitest 里没有请求上下文。读源码换来的代价是「形状变了守卫会瞎」——
 * 所以下面第一条断言先验「确实抠出了足够多的 URL」，不让它空转。
 */
function sitemapPaths(): string[] {
  const src = readFileSync(join(ROOT, 'app/sitemap.ts'), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/url:\s*`\$\{SITE\}([^`]*)`/g)) {
    out.push(m[1] === '' ? '/' : m[1]);
  }
  return out;
}

describe('sitemap 递交的每个页面都要有自己的标题与描述', () => {
  const paths = sitemapPaths();

  it('守卫自己不能空转：确实从 sitemap.ts 里抠到了 URL', () => {
    expect(
      paths.length,
      'app/sitemap.ts 里 url 那一行的写法变了，这条守卫抠不到路径——它会对所有页面集体误绿。'
      + '请把 sitemapPaths() 的正则改对。',
    ).toBeGreaterThanOrEqual(8);
    expect(paths).toContain('/');
  });

  it.each(paths)('%s 有自己的 SEO 文案', (path) => {
    if (path === ROOT_USES_SITE_DEFAULT) {
      // 首页刻意豁免：它的标题描述**就是**全站默认那一份（首页本来就代表整个站），
      // 在 PAGE_SEO 里再写一遍等于同一句话维护两遍。
      expect(PAGE_SEO[path], '首页不该进 PAGE_SEO —— 它用的就是根布局的全站默认值').toBeUndefined();
      return;
    }
    expect(
      PAGE_SEO[path],
      `${path} 在 sitemap.xml 里递交给了搜索引擎，却没有自己的标题与描述——`
      + '它会静默沿用根布局的全站默认值，于是搜索结果里它和首页长得一模一样。'
      + '请在 lib/geo/page-seo.ts 里补一条。',
    ).toBeTruthy();
  });

  it('🔒 声明可收录的页，都必须真的递交进了 sitemap', () => {
    for (const [path, seo] of Object.entries(PAGE_SEO)) {
      if (!seo.indexable) continue;
      expect(
        paths,
        `${path} 在 page-seo.ts 里写着 indexable: true，却不在 sitemap.xml 里——`
        + '「允许被收录」和「告诉搜索引擎它存在」是两件事，只做前一件等于没做。',
      ).toContain(path);
    }
  });
});

describe('标题不许自带品牌名（根布局的 template 会拼）', () => {
  // 根布局：title.template = '%s | 烽火台 · 跨平台内容作战室'
  // 子页 title 里再写一遍品牌名，输出就是「隐私政策 — 烽火台 | 烽火台 · 跨平台内容作战室」。
  // /legal 三页、/pricing、/overview 此前全是这个样子。
  const BRAND = ['烽火台', 'Beacon'];

  it.each(Object.keys(PAGE_SEO))('%s 的 title 里没有品牌名', (path) => {
    for (const b of BRAND) {
      expect(
        PAGE_SEO[path].title.includes(b),
        `${path} 的 title 是「${PAGE_SEO[path].title}」，里面有「${b}」。`
        + '根布局的 title.template 会再拼一次品牌名，实际输出会有两遍。'
        + '（分享卡片的 ogTitle 相反：它不走 template，**要**自带品牌名。）',
      ).toBe(false);
    }
  });

  it('🔒 根布局确实有 title.template（没有的话上面那条断言就成了无理取闹）', () => {
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
    expect(
      /template:\s*'%s \|/.test(layout),
      'app/layout.tsx 的 title.template 不见了或形状变了——上面「标题不许自带品牌名」的理由随之消失，'
      + '两条要一起改。',
    ).toBe(true);
  });
});

describe('每一页的文案都要真的不一样', () => {
  const entries = Object.entries(PAGE_SEO);

  it('标题两两不重复', () => {
    const seen = new Map<string, string>();
    for (const [path, seo] of entries) {
      const prev = seen.get(seo.title);
      expect(prev, `${path} 和 ${prev} 的 title 一模一样：「${seo.title}」`).toBeUndefined();
      seen.set(seo.title, path);
    }
  });

  it('描述两两不重复', () => {
    const seen = new Map<string, string>();
    for (const [path, seo] of entries) {
      const prev = seen.get(seo.description);
      expect(prev, `${path} 和 ${prev} 的 description 一模一样`).toBeUndefined();
      seen.set(seo.description, path);
    }
  });

  it('描述不许等于（或照抄）全站默认那一句', () => {
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
    // 全站默认描述里这半句最有辨识度；照抄它等于这一页根本没写自己的描述
    const DEFAULT_FRAGMENT = '八条选题来源，只有两条看热榜';
    expect(layout, '全站默认描述的形状变了，这条守卫的判据要跟着改').toContain(DEFAULT_FRAGMENT);
    for (const [path, seo] of entries) {
      expect(
        seo.description.includes(DEFAULT_FRAGMENT),
        `${path} 的 description 照抄了全站默认那一句`,
      ).toBe(false);
    }
  });
});

describe('长度与内容的下限', () => {
  it.each(Object.entries(PAGE_SEO))('%s 的文案长度落在可用区间', (path, seo) => {
    // 中文搜索结果标题大约 30 个汉字后截断，加上 template 拼的 14 个字，
    // 子标题超过 34 就注定看不全。不是硬错，但值得在这里红一次。
    expect(seo.title.length, `${path} 的 title 太长（${seo.title.length} 字），加上品牌后缀会被截断`).toBeLessThanOrEqual(34);
    expect(seo.title.length, `${path} 的 title 太短，说不清这一页是什么`).toBeGreaterThanOrEqual(2);
    // 摘要：百度约 78 个汉字、Google 约 80 字符后截断；留到 160 是给英文与标点的余量
    expect(seo.description.length, `${path} 的 description 太短`).toBeGreaterThanOrEqual(20);
    expect(seo.description.length, `${path} 的 description 过长（${seo.description.length} 字），后半截不会被显示`).toBeLessThanOrEqual(160);
    expect(seo.keywords.length, `${path} 一个关键词都没有`).toBeGreaterThan(0);
    expect(new Set(seo.keywords).size, `${path} 的 keywords 里有重复词`).toBe(seo.keywords.length);
  });
});

describe('收录声明要和 robots.txt 对得上', () => {
  it.each(Object.entries(PAGE_SEO))('%s 的 indexable 与 robots 放行一致', (path, seo) => {
    // 判据直接写在守卫里：为它单独导出一个函数会立刻变成「只有测试在调」的孤儿，
    // 而那正是 tests/geo/wired-up.test.ts 要拦的形状。
    expect(
      seo.indexable === allowedByRobots(path),
      `${path} 声明 indexable: ${seo.indexable}，但 robots.txt ${allowedByRobots(path) ? '放行了' : '没放行'} 它。`
      + '两边必须一致：声明可收录却被 robots 挡住 = 永远不会被收录；'
      + '声明不可收录却被放行 = 爬虫会抓到一个登录页。'
      + '（改 lib/geo/public-surface.ts 的 PUBLIC_ALLOW，或改这一条的 indexable。）',
    ).toBe(true);
  });
});

describe('pageMetadata 的输出', () => {
  it('可收录的页不输出 noindex，登录墙后面的页输出 noindex', () => {
    const open = pageMetadata('/hotlists');
    expect(open.robots, '/hotlists 是公开页，不该带 robots 覆盖').toBeUndefined();
    const walled = pageMetadata('/overview');
    expect(walled.robots, '/overview 在登录墙后面，必须 noindex').toMatchObject({ index: false });
  });

  it('canonical 一定有', () => {
    for (const path of Object.keys(PAGE_SEO)) {
      expect(pageMetadata(path).alternates?.canonical, `${path} 没有 canonical`).toBe(path);
    }
  });

  it('🔒 表里没有的路径直接抛，不许静默回退到全站默认', () => {
    expect(() => pageMetadata('/不存在的页')).toThrow(/page-seo/);
  });

  it('英文只在真有英文正文的页上切（titleEn 填了才算）', () => {
    // /legal/data-request 是全站唯一有英文正文分支的公开页
    expect(pageMetadata('/legal/data-request', 'en').title).toBe('Data Removal Request');
    // 没填 titleEn 的页，即使 lang=en 也继续给中文——标题英文、正文中文比全中文糟得多
    expect(pageMetadata('/hotlists', 'en').title).toBe(PAGE_SEO['/hotlists'].title);
  });
});
