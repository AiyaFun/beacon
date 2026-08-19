import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLUGIN_COLLECTABLE } from '@/lib/ingest/competitor';

// 「这个站点不在竞对采集范围内（B站/抖音/小红书/YouTube/X）」——TikTok 早就支持了，
// 而这句话在插件里出现了 5 次、网页里 1 次，全都漏了它。被明确告知「不支持」的用户
// **根本不会去试**，功能等于不存在（这与「按钮点了报错」不同：那还能看出是 bug）。
//
// 2026-08-13 是这类漂移的第二轮了（第一轮是 sidebar.js:824 那一条单独修的）。
// 手改文案永远会漏，所以判据改成：**凡是逐个列举平台的用户可见文案，都必须列全**。
//
// 判据来源：`PLUGIN_COLLECTABLE`（服务端认定「插件能采」的平台集合）。它是这些文案在说的那件事。

// **只扫用户看得见的文案**：代码注释里也会顺口列几个平台（如「抖音/小红书/X 的公开页没有播放量」），
// 那是在讲某几家的性质，不是在告诉用户支持范围，硬要求列全会把注释改成假话。
const read = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8')
    .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')   // 行注释与块注释正文
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');    // JSX 注释

// 这几串**本来就该窄**，逐条写清理由（不写理由不许加进来）
const EXEMPT = new Map<string, string>([
  // 创作者后台是另一套页面，与「公开页能不能采」是两件事：视频号/公众号没有公开主页，
  // 而 X/YouTube/TikTok 压根没有独立的创作者后台域名。
  ['视频号/公众号/抖音/小红书/B站', '创作者后台清单，与公开页平台集合本就不同'],
]);

/** 平台在用户可见文案里的叫法（与 lib/constants.ts 的 PLATFORMS.name 同源，公众号例外见下） */
const LABEL: Record<string, string> = {
  bilibili: 'B站',
  douyin: '抖音',
  xiaohongshu: '小红书',
  youtube: 'YouTube',
  x: 'X',
  tiktok: 'TikTok',
  wechat: '公众号',
};

// 「B站/抖音/…」这种斜杠连写的枚举串
// 视频号也列进来：它不在 PLUGIN_COLLECTABLE 里（没有公开主页），但只有认得它，
// 「视频号/公众号/抖音/小红书/B站」这串才会被整体匹配到、从而命中下面的豁免；
// 否则正则会从「公众号」切一刀，豁免键对不上。
const ENUM_RE = /(?:B站|抖音|小红书|YouTube|X|TikTok|公众号|视频号)(?:\/(?:B站|抖音|小红书|YouTube|X|TikTok|公众号|视频号)){2,}/g;

const FILES = [
  'extension/popup.js',
  'extension/sidepanel.js',
  'extension/content/sidebar.js',
  'app/(app)/competitors/page.tsx',
];

describe('用户可见的平台枚举文案不许漏平台', () => {
  it('🔒 每条「A/B/C…」枚举都覆盖了插件能采的全部公开平台', () => {
    // 公众号没有公开主页，「在某某页面上使用采集」这类句子本来就不该把它算进去，
    // 所以判据只要求**公开页平台**列全；公众号是否提及由各处按语义决定。
    const publicPlatforms = [...PLUGIN_COLLECTABLE].filter((p) => p !== 'wechat');
    expect(publicPlatforms.length, 'PLUGIN_COLLECTABLE 里公开页平台少于 5 个？先确认是不是下线了')
      .toBeGreaterThanOrEqual(5);

    const problems: string[] = [];
    for (const f of FILES) {
      const src = read(f);
      for (const m of src.match(ENUM_RE) ?? []) {
        if (EXEMPT.has(m)) continue;
        const listed = new Set(m.split('/'));
        const missing = publicPlatforms.filter((p) => !listed.has(LABEL[p]));
        if (missing.length) {
          problems.push(`${f} 的「${m}」漏了：${missing.map((p) => LABEL[p]).join('、')}`);
        }
      }
    }
    expect(problems, `这些面向用户的平台清单漏了平台——用户会以为不支持：\n  ${problems.join('\n  ')}`)
      .toEqual([]);
  });

  // 豁免清单是这条守卫唯一的逃生口，所以它本身也要有闸：
  // 一条豁免要成立，前提是它**确实在讲另一类页面**——必须含有公开页平台集合之外的平台
  //（视频号/公众号这类没有公开主页的）。全由公开页平台组成的串只能是「漏了」，不可能是「本来就窄」。
  // 没有这条，任何人都可以把一条漏平台的文案原样塞进 EXEMPT 让守卫闭嘴。
  it('🔒 豁免不能拿来消音：每条豁免都必须确实是「另一类清单」', () => {
    const publicLabels = new Set([...PLUGIN_COLLECTABLE].filter((p) => p !== 'wechat').map((p) => LABEL[p]));
    for (const [key, reason] of EXEMPT) {
      expect(reason.trim().length, `豁免「${key}」没写理由`).toBeGreaterThan(8);
      const hasOutsider = key.split('/').some((label) => !publicLabels.has(label));
      expect(
        hasOutsider,
        `豁免「${key}」全部由公开页平台组成——那它就是漏了平台，不是「本来就窄」，不许豁免`,
      ).toBe(true);
    }
  });

  it('扫描确实抓到了枚举串（正则失效时别静默通过）', () => {
    const total = FILES.reduce((n, f) => n + (read(f).match(ENUM_RE) ?? []).length, 0);
    expect(total, '一条平台枚举文案都没匹配到，ENUM_RE 大概率已失效').toBeGreaterThanOrEqual(5);
  });
});
