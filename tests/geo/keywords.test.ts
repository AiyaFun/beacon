import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_KEYWORDS, KNOWS_ABOUT, knowsAboutString } from '@/lib/geo/keywords';
import { HOT_SOURCES, PLATFORMS } from '@/lib/constants';

// 关键词矩阵的常驻守卫（2026-09-17）。
//
// ── 这道守卫拦的是什么 ──
// 关键词是**对着搜索引擎和大模型说的话**。它有两种失效方式，都不报错：
//   ① 说了假话 —— 「9 大平台实时热榜」，而榜单源只有 7 个。
//      这个项目已经栽过一次：/hotlists 的 SEO 文案写死「9 大平台」还点名了
//      快手/小红书/微信，而它们从来不是榜单源。2026-09-17 收到的词表里
//      又一次出现了「9大平台」——说明靠人记是记不住的。
//   ② 悄悄丢词 —— 词表是一个 160 多行的数组，删掉几行没有任何东西会红。
//      用户点名要的词今天在、下一次重构后不在了，没人会发现。

const ROOT = process.cwd();
const src = readFileSync(join(ROOT, 'lib/geo/keywords.ts'), 'utf8');

describe('带数量的词必须从常量派生，不许手写', () => {
  it('🔒 榜单平台名是生成的，不是手打的', () => {
    expect(
      src,
      'lib/geo/keywords.ts 里 `...HOT_SOURCES.map(...)` 那行没了——'
      + '有人把榜单平台名改回手写了。手写的名单不会跟着 HOT_SOURCES 变，'
      + '这正是「点名快手/小红书/微信当榜单源」那个坑的根。',
    ).toMatch(/\.\.\.HOT_SOURCES\.map\(/);
  });

  it.each(SITE_KEYWORDS.filter((w) => /(热榜|热搜|热门)$/.test(w)))(
    '「%s」指向的是真实榜单源',
    (word) => {
      const realNames = HOT_SOURCES.map((s) => s.name);
      // 「N大平台实时热榜」这类汇总词单独判（下一个 describe），这里只判点名平台的
      if (/^\d/.test(word)) return;
      expect(
        realNames,
        `关键词「${word}」点名了一个榜单平台，但 HOT_SOURCES 里没有它。`
        + `真实榜单源只有：${realNames.join('、')}。`
        + '编一个不存在的榜单源，等于对搜索引擎说假话——而假话不会让任何测试变红。',
      ).toContain(word);
    },
  );

  it('🔒 「N大平台 / N个平台」里的 N 必须等于真实数量', () => {
    const claims = SITE_KEYWORDS.filter((w) => /\d+\s*(大|个)平台/.test(w));
    expect(claims.length, '一个带平台数量的词都没有？这条守卫要跟着改').toBeGreaterThan(0);
    for (const w of claims) {
      const n = Number(/(\d+)\s*(?:大|个)平台/.exec(w)![1]);
      const real = [HOT_SOURCES.length, Object.keys(PLATFORMS).length];
      expect(
        real,
        `关键词「${w}」声称有 ${n} 个平台，但真实数量是：`
        + `榜单源 ${HOT_SOURCES.length} 个、发布平台 ${Object.keys(PLATFORMS).length} 个。`
        + '用 `${HOT_SOURCES.length}` 或 `${PLATFORM_COUNT}` 派生，别手写数字——'
        + '写死的数字不会报错，只会在某一天变成一句对着搜索引擎说的假话。',
      ).toContain(n);
    }
  });
});

describe('六大维度的编排还在', () => {
  // 维度分节不是排版：每加一个词先问它属于哪一维，归不进任何一维的词多半是想蹭流量。
  // 分节注释被删掉 = 这条判据没了位置可写。
  const DIMENSIONS = ['① 品牌主张', '② 客群场景', '③ 选题情报', '④ AI 创作中枢', '⑤ 合规风控', '⑥ GEO / AI 搜索优化'];

  it.each(DIMENSIONS)('分节「%s」还在', (d) => {
    expect(src, `lib/geo/keywords.ts 里「${d}」这一节的注释不见了`).toContain(d);
  });
});

describe('用户 2026-09-17 点名要的词，一个都不许丢', () => {
  // 【为什么把验收清单钉进测试】这批词是用户逐条列出来的交付内容。
  // 词表是一个 160 多行的数组，重构时删掉几行不会有任何东西变红——
  // 于是「交付过的东西后来悄悄没了」这件事没有任何人会发现。
  const ASKED: readonly string[] = [
    // ① 品牌主张
    '烽火台', 'Beacon', '跨平台内容作战室', '先知道做什么再谈怎么写', '创作者选题推荐引擎',
    // ② 客群场景
    '自媒体运营', '爆款选题', '融媒体中心', '融媒体矩阵管理', 'MCN机构内容运营', '跨平台分发', '个人IP打造',
    // ③ 选题情报
    '全网热榜聚合', '跨平台竞对监控', '8大选题推荐来源', '抢跑流量窗口', '30天流量节点日历', '常青选题库',
    // ④ AI 创作中枢
    '12视角AI选题智囊团', 'AI创作教练', 'AI人设记忆系统', 'AI自主学习', '一稿四态改写',
    '公众号深度长文改写', '小红书图文笔记改写', '抖音短视频分镜脚本', 'B站中长视频文案',
    // ⑤ 合规风控
    '平台算法教练', '分平台合规检测', '自媒体合规风控', '小红书限流词检测', '违规敏感词过滤',
    // ⑥ GEO / AI 搜索优化
    'GEO优化', '生成式引擎优化', '深度SEO优化', '品牌SoV声量监测',
    'DeepSeek SEO', 'ChatGPT SEO', 'Perplexity SEO', 'Kimi SEO', '豆包AI搜索收录',
    '微信小微AI搜索', '百度双Agent优化', '谷歌AI Overviews收录', 'Bing Copilot优化', 'Schema.org知识图谱',
  ];

  const all = new Set([...SITE_KEYWORDS, ...KNOWS_ABOUT].map((w) => w.replace(/\s/g, '')));

  it.each(ASKED)('「%s」在词表里', (w) => {
    expect(all, `用户点名要的「${w}」不在 SITE_KEYWORDS / KNOWS_ABOUT 里了`).toContain(w.replace(/\s/g, ''));
  });

  it('🔒 「9大平台实时热榜」**不许**出现（用户给的原词，但与事实不符）', () => {
    // 用户 2026-09-17 明确拍板「按照实际的为准」。榜单源是 HOT_SOURCES.length 个。
    // 这条断言正着写也反着写：既不许出现 9，也要求真实数量那个词在。
    expect([...all].some((w) => /9大平台/.test(w)), '「9大平台」又回来了').toBe(false);
    expect(all, `应当有「${HOT_SOURCES.length}大平台实时热榜」`).toContain(`${HOT_SOURCES.length}大平台实时热榜`);
  });
});

describe('词表本身的卫生', () => {
  it('没有重复词', () => {
    expect(new Set(SITE_KEYWORDS).size, 'SITE_KEYWORDS 里有重复词').toBe(SITE_KEYWORDS.length);
    expect(new Set(KNOWS_ABOUT).size, 'KNOWS_ABOUT 里有重复词').toBe(KNOWS_ABOUT.length);
  });

  it('没有空词或只有空白的词', () => {
    for (const w of [...SITE_KEYWORDS, ...KNOWS_ABOUT]) {
      expect(w.trim().length, `「${w}」是空词`).toBeGreaterThanOrEqual(2);
    }
  });

  it('两份清单都不是空的，且规模没有意外塌缩', () => {
    // 【为什么定下限】重构时把数组改坏成空数组，页面照常渲染、测试照常绿，
    // 只是 <meta keywords> 变成空串——最典型的「静默失效」。
    expect(SITE_KEYWORDS.length, '检索词少得不正常').toBeGreaterThanOrEqual(120);
    expect(KNOWS_ABOUT.length, '实体词少得不正常').toBeGreaterThanOrEqual(50);
  });

  it('knowsAboutString 输出的是逗号串，条数对得上', () => {
    expect(knowsAboutString().split(', ').length).toBe(KNOWS_ABOUT.length);
  });
});

describe('两份清单都真的被消费了', () => {
  // 「写了没接」在这里的形态：词表改得再好，没人 import 就等于没写。
  it('app/layout.tsx 用了 SITE_KEYWORDS', () => {
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
    expect(layout, 'app/layout.tsx 不再引用 SITE_KEYWORDS —— <meta keywords> 会退回空或旧值').toContain('SITE_KEYWORDS');
  });

  it('lib/geo/json-ld.ts 用了 KNOWS_ABOUT', () => {
    const jsonld = readFileSync(join(ROOT, 'lib/geo/json-ld.ts'), 'utf8');
    expect(jsonld, 'lib/geo/json-ld.ts 不再引用 KNOWS_ABOUT —— 知识图谱的 knowsAbout 会空掉').toContain('KNOWS_ABOUT');
  });
});
