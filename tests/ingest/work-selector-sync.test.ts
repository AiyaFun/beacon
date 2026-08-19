import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 同一个平台的同一个指标，在这个仓库里被取了不止一次：
//   · 主页/作品页解析器（douyin-video.js、tiktok.js …）—— 走「访问即采」那条常驻通道
//   · work.js 的 RULES —— 只服务「一键拆解这条作品」，按需注入
//
// 两份各自维护的后果 2026-08-13 当场抓到了两条，都是**静默**的：
//   ① 抖音：douyin-video.js 08-08 就换成了新埋点（video-player-digg 等），work.js 没跟，
//      于是拆解通道一直按旧 `*-count` 取数——取不到就是空，不报错、不告警。
//   ② TikTok：work.js 写的 `browse-share-count` **线上根本不存在**（tiktok.js:123 当场记过
//      「分享数的 data-e2e 就叫 undefined-count，不是笔误」），收藏数则整个漏了。
//
// 所以判据是：**专用解析器认得的锚点，work.js 必须一个不落地也认**。
// 反过来不要求——work.js 可以多带回退层级，那不会让它取到错数。
//
// ⚠️ 这条测试验的是「两处口径同步」，不是「选择器对不对」。后者只能真机校准：
//    专用解析器那一份要是本身就过时了，这里全绿也说明不了什么。

const EXT = (p: string) => readFileSync(resolve(process.cwd(), 'extension/content/' + p), 'utf8');
const WORK = EXT('work.js');

/**
 * 取 work.js 的 RULES 里某个平台那一段（到下一个平台键为止），**并剥掉注释**。
 * 剥注释不是洁癖：注释里会为了讲清楚而原样引用「写错的那个选择器」
 * （比如「此前写的 browse-share-count 线上根本不存在」），不剥的话
 * 否定断言会被自己的说明文字骗过去——这条测试第一次跑就撞上了。
 */
function workBlock(platform: string): string {
  const start = WORK.indexOf(`\n    ${platform}: {`);
  expect(start, `work.js 的 RULES 里找不到平台 ${platform} —— 改了结构就要改这个测试`).toBeGreaterThan(-1);
  const rest = WORK.slice(start + 1);
  const next = /\n {4}[a-z]+: \{/.exec(rest);
  const block = next ? rest.slice(0, next.index) : rest;
  return block.replace(/^\s*\/\/.*$/gm, '');
}

/** 从一段源码里抠出所有 [data-e2e="…"] 锚点 */
function anchors(src: string): string[] {
  return Array.from(new Set(Array.from(src.matchAll(/\[data-e2e="([^"]+)"\]/g), (m) => m[1])));
}

/** 专用解析器里取某个指标那一行（形如 set('likes', …) 或 likes: ttCount(…)） */
function metricLine(src: string, metric: string): string {
  const re = new RegExp(`(?:set\\('${metric}',|\\b${metric}:).*`, 'g');
  const hits = Array.from(src.matchAll(re), (m) => m[0]);
  expect(hits.length, `专用解析器里找不到指标 ${metric} 的取数行`).toBeGreaterThan(0);
  return hits.join('\n');
}

describe('work.js 的选择器必须与专用解析器同步（漂移是静默的，只能靠测试拦）', () => {
  const CASES = [
    { platform: 'douyin', file: 'douyin-video.js', metrics: ['likes', 'comments', 'collects', 'shares'] },
    { platform: 'tiktok', file: 'tiktok.js', metrics: ['likes', 'comments', 'shares', 'collects'] },
  ];

  for (const c of CASES) {
    describe(c.platform, () => {
      const src = EXT(c.file);
      const block = workBlock(c.platform);

      for (const metric of c.metrics) {
        it(`🔒 ${metric}：${c.file} 认得的锚点，work.js 一个都不能少`, () => {
          const want = anchors(metricLine(src, metric));
          expect(want.length, `${c.file} 的 ${metric} 一个 data-e2e 锚点都没抠到，正则大概率失效了`).toBeGreaterThan(0);
          for (const a of want) {
            // ⚠️ 必须比对**完整的** `[data-e2e="X"]`，不能只比裸名字：
            // `video-player-digg` 是 `video-player-digg-count` 的子串，只比裸名字的话，
            // 把新埋点删回旧的一套，这条断言照样绿（第一版就是这么假绿的）。
            expect(block, `work.js 的 ${c.platform}.${metric} 缺锚点 [data-e2e="${a}"]（${c.file} 在用）`)
              .toContain(`[data-e2e="${a}"]`);
          }
        });
      }
    });
  }

  // 这条单独钉：它不是「漂移」而是「凭空写错」——线上没有这个名字，写了等于永远取不到。
  it('🔒 TikTok 分享数不许写回 browse-share-count（线上不存在这个 data-e2e）', () => {
    expect(workBlock('tiktok')).not.toContain('browse-share-count');
    expect(workBlock('tiktok')).toContain('undefined-count');
  });
});
