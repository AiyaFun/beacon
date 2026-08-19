import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  specForPlatform, coverSpec, COVER_SPECS, DEFAULT_COVER_SPEC,
  checkArkSize, ARK_MIN_PIXELS, ARK_MAX_PIXELS, planCoverJobs,
} from '@/lib/cover/specs';
import { MAX_COVER_IMAGES } from '@/lib/cover/rules';
import { rankStylesForPersona, COVER_STYLES, coverFont, decorPrompts } from '@/lib/cover/styles';
import { PLATFORMS } from '@/lib/constants';

// 比例是平台的属性：每个平台都要能推出一档；未知平台回落到小红书 3:4。
describe('specForPlatform', () => {
  it('八个平台各自有默认比例，且视频号 / 抖音 / B站 / 公众号不是 3:4', () => {
    for (const key of Object.keys(PLATFORMS)) {
      const s = specForPlatform(key);
      expect(COVER_SPECS.some((x) => x.key === s.key)).toBe(true);
    }
    expect(specForPlatform('xiaohongshu').ratio).toBe('3:4');
    expect(specForPlatform('shipinhao').ratio).toBe('6:7');
    expect(specForPlatform('douyin').ratio).toBe('9:16');
    expect(specForPlatform('tiktok').ratio).toBe('9:16');
    expect(specForPlatform('bilibili').ratio).toBe('16:10');
    expect(specForPlatform('wechat').ratio).toBe('2.35:1');
    expect(specForPlatform('youtube').ratio).toBe('16:9');
  });

  it('未知 / 空平台 → 默认（小红书 3:4）', () => {
    expect(specForPlatform('nope').key).toBe(DEFAULT_COVER_SPEC);
    expect(specForPlatform(undefined).key).toBe(DEFAULT_COVER_SPEC);
    expect(coverSpec('nope').key).toBe(DEFAULT_COVER_SPEC);
  });
});

describe('rankStylesForPersona（按赛道推荐）', () => {
  it('人设命中关键词的风格排前并标 recommended；空人设原序、无推荐', () => {
    const r = rankStylesForPersona('我是育儿博主，讲科普');
    expect(r[0].recommended).toBe(true);
    expect(r[0].style.recommendFor.some((k) => '我是育儿博主，讲科普'.includes(k))).toBe(true);
    const none = rankStylesForPersona('');
    expect(none.map((x) => x.style.key)).toEqual(COVER_STYLES.map((s) => s.key));
    expect(none.every((x) => !x.recommended)).toBe(true);
  });

  it('排序不丢档、不重复', () => {
    const r = rankStylesForPersona('职场 数码');
    expect(new Set(r.map((x) => x.style.key)).size).toBe(COVER_STYLES.length);
  });
});

describe('字体倾向 / 装饰', () => {
  it('未知字体回落 auto（无提示词）；装饰只取认识的 key', () => {
    expect(coverFont('nope').key).toBe('auto');
    expect(coverFont('nope').prompt).toBe('');
    expect(decorPrompts(['stickers', 'x'])).toHaveLength(1);
    expect(decorPrompts(undefined)).toHaveLength(0);
  });
});

// 方舟对自定义尺寸有硬约束（总像素 [3686400, 16777216]、宽高比 [1/16, 16]）。超出就是 400，
// 而且报错文本对用户毫无意义。这条守卫的意义是：**加一档新比例时当场变红**，
// 而不是等用户点「生成封面」才在生产撞墙。2026-08-17 已对着官方文档核过现有 8 档全部合法。
describe('COVER_SPECS 必须落在方舟能接受的尺寸区间内', () => {
  it('每一档都过 checkArkSize', () => {
    for (const s of COVER_SPECS) {
      expect(checkArkSize(s.size), `${s.key} (${s.size})`).toBeNull();
    }
  });

  it('checkArkSize 认得出太小 / 太大 / 比例过极端 / 格式不对', () => {
    expect(checkArkSize('1024x1024')).toContain('太小'); // 1,048,576 < 下限
    expect(checkArkSize('5000x5000')).toContain('太大'); // 25,000,000 > 上限
    expect(checkArkSize('40000x100')).toContain('宽高比'); // 400:1
    expect(checkArkSize('2048*2048')).toContain('宽x高');
    expect(checkArkSize('')).toContain('宽x高');
  });

  it('边界值：正好等于上下限算合法（官方推荐档 1440x2560 就压在下限上）', () => {
    expect(ARK_MIN_PIXELS).toBe(1440 * 2560);
    expect(checkArkSize('1440x2560')).toBeNull();
    expect(ARK_MAX_PIXELS).toBe(4096 * 4096);
    expect(checkArkSize('4096x4096')).toBeNull();
  });
});

// ── 出图排期（planCoverJobs）─────────────────────────────────────────────
//
// 【被守的是什么】此前服务端与工位各写了一份「这次出几张」，在**名额刚好排满**的边界上
// 给出不同结果：勾了「连 1:1 次图一起出（公众号要两张）」又选了 3 张变体时，
// 服务端先排满 3 张主图，成对那一步的 `jobs.length < MAX` 不成立 —— 次图被静默丢掉。
// 总张数仍然是 3，所以既不报错也不进 warning：用户只会发现「勾了没用」。
describe('planCoverJobs · 一次出哪几张', () => {
  const MAX = MAX_COVER_IMAGES;
  const plan = (o: Parameters<typeof planCoverJobs>[0]) => planCoverJobs(o);

  it('默认只出一张，用当前比例与风格', () => {
    const jobs = plan({ specKey: 'xhs-3-4', styleKey: 'bold-text', max: MAX });
    expect(jobs).toEqual([{ styleKey: 'bold-text', specKey: 'xhs-3-4' }]);
  });

  it('变体：同风格出 N 张，封顶 MAX', () => {
    expect(plan({ specKey: 'xhs-3-4', styleKey: 'a', variants: 2, max: MAX })).toHaveLength(2);
    expect(plan({ specKey: 'xhs-3-4', styleKey: 'a', variants: 99, max: MAX })).toHaveLength(MAX);
    // 0 / 负数 / 小数都退回 1 张，绝不排出 0 张（0 张会让 run.ts 拿不到 plan[0]）
    for (const v of [0, -3, 0.4]) {
      expect(plan({ specKey: 'xhs-3-4', styleKey: 'a', variants: v, max: MAX })).toHaveLength(1);
    }
  });

  it('多选风格：每个风格各一张，变体数被忽略', () => {
    const jobs = plan({ specKey: 'xhs-3-4', styleKeys: ['a', 'b'], variants: 3, max: MAX });
    expect(jobs.map((j) => j.styleKey)).toEqual(['a', 'b']);
  });

  it('🔒 公众号成对：勾了就一定有 1:1 次图，哪怕主图已经要满了', () => {
    const jobs = plan({ specKey: 'wechat-235-1', styleKey: 'a', variants: MAX, wechatSquareToo: true, max: MAX });
    expect(jobs).toHaveLength(MAX);
    expect(jobs.filter((j) => j.specKey === 'square-1-1')).toHaveLength(1); // 次图没被挤掉
    expect(jobs.filter((j) => j.specKey === 'wechat-235-1')).toHaveLength(MAX - 1); // 主图让出一格
  });

  it('🔒 多选风格 + 成对：同样保住次图（风格列表按主图预算截断）', () => {
    const jobs = plan({ specKey: 'wechat-235-1', styleKeys: ['a', 'b', 'c'], wechatSquareToo: true, max: MAX });
    expect(jobs).toHaveLength(MAX);
    expect(jobs.filter((j) => j.specKey === 'square-1-1')).toHaveLength(1);
    expect(jobs.filter((j) => j.specKey === 'wechat-235-1').map((j) => j.styleKey)).toEqual(['a', 'b']);
  });

  it('次图沿用主图的风格（一对封面不该是两个风格）', () => {
    const jobs = plan({ specKey: 'wechat-235-1', styleKey: 'neon', wechatSquareToo: true, max: MAX });
    expect(jobs.find((j) => j.specKey === 'square-1-1')?.styleKey).toBe('neon');
  });

  it('成对只对公众号主图成立：别的比例勾了也不产出 1:1', () => {
    const jobs = plan({ specKey: 'xhs-3-4', styleKey: 'a', variants: 2, wechatSquareToo: true, max: MAX });
    expect(jobs.every((j) => j.specKey === 'xhs-3-4')).toBe(true);
    expect(jobs).toHaveLength(2);
  });

  it('上限只有 1 张时优先保主图（没有主图的「一对」不成立）', () => {
    const jobs = plan({ specKey: 'wechat-235-1', styleKey: 'a', variants: 2, wechatSquareToo: true, max: 1 });
    expect(jobs).toEqual([{ styleKey: 'a', specKey: 'wechat-235-1' }]);
  });

  it('未知比例 key 回落到默认档，不产出一个查不到的 specKey', () => {
    const jobs = plan({ specKey: '不存在的比例', styleKey: 'a', max: MAX });
    expect(jobs[0].specKey).toBe(DEFAULT_COVER_SPEC);
  });
});

// 服务端与工位必须调**同一个** planCoverJobs：各写一份正是上面那个 bug 的来源。
describe('🔒 出图排期只有一份实现', () => {
  it('run.ts 与 CoverStation.tsx 都走 planCoverJobs，且没有各自的成对判断', () => {
    const root = path.resolve(__dirname, '..', '..');
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const run = strip(fs.readFileSync(path.join(root, 'lib', 'cover', 'run.ts'), 'utf8'));
    const ui = strip(fs.readFileSync(path.join(root, 'app', '(app)', 'studio', 'CoverStation.tsx'), 'utf8'));
    for (const [name, src] of [['run.ts', run], ['CoverStation.tsx', ui]] as const) {
      expect(src, name).toMatch(/planCoverJobs\(/);
      // 手写的 `jobs.length < MAX` / `+ (… ? 1 : 0)` 这类自算张数不许再出现
      expect(src, name).not.toMatch(/jobs\.length\s*<\s*MAX_COVER_IMAGES/);
      expect(src, name).not.toMatch(/'wechat-235-1'/); // 比例 key 只从常量来
    }
  });
});
