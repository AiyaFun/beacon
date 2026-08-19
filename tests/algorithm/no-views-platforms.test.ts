import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { engagementRate, hasViews, ratioOf, type Metrics } from '@/lib/json';
import { buildBaseline, diagnose } from '@/lib/algorithm/coach';

// 抖音（以及一切「公开页面看不到播放量」的平台）。
//
// 真机口径（extension/content/douyin*.js 的注释里也钉着）：
//   · 主页卡片角标是 ♡ 点赞，**不是** ▷ 播放；抖音网页端根本不显示播放量
//   · 详情页能拿到 点赞 / 评论 / 收藏 / 转发 —— 这四项是真的，照常采
//   · 播放量只有创作者后台才有
//
// 于是「没有播放量」这件事必须一路诚实地传下去：
//   ① 缺席 ≠ 0。views 没采到就是**不知道**，不是「零次播放」。
//   ② 以播放为分母的指标（互动率、赞播比、各类 xx 率）算不出来就返回 null，
//      **绝不返回 0** —— 0 会被渲染成「互动率 0.0%」，那是拿一个编出来的数字冒充真实观测。
//   ③ 求均值/排序时只统计真的有这项数据的样本，否则抖音作品会把整体均值系统性拉到底，
//      看起来就像「这个号互动很差」。coach.ts 里对 CTR/搜索占比早就是这么做的，
//      这里把同一条纪律补到点赞率/评论率/收藏率/转发率上。

const DOUYIN_HOME: Metrics = { likes: 97000 };                                   // 主页只采到点赞
const DOUYIN_DETAIL: Metrics = { likes: 97000, comments: 3200, collects: 8100, shares: 1500 }; // 详情页：四项齐、就是没播放
const WITH_VIEWS: Metrics = { views: 100000, likes: 5000, comments: 300, collects: 800, shares: 200 };

describe('🔒 没有播放量时，缺席不许退化成 0', () => {
  it('hasViews：undefined 和 0 都算「没拿到」', () => {
    expect(hasViews({})).toBe(false);
    expect(hasViews({ views: 0 })).toBe(false);
    expect(hasViews({ views: 1 })).toBe(true);
  });

  it('🔒 互动率：拿不到播放量返回 null，不是 0', () => {
    // 修复前这里返回 0 → 页面显示「互动率 0.0%」，用户以为真有人看了但没人互动
    expect(engagementRate(DOUYIN_DETAIL)).toBeNull();
    expect(engagementRate(DOUYIN_HOME)).toBeNull();
    expect(engagementRate({ views: 0, likes: 100 })).toBeNull();
  });

  it('有播放量时照常算得对', () => {
    const r = engagementRate(WITH_VIEWS);
    expect(r).toBeCloseTo((5000 + 300 + 800 + 200) / 100000, 6);
  });

  it('ratioOf：分母拿不到 → null；分子没采到 → null；分子真的是 0 → 0（那是真实观测）', () => {
    expect(ratioOf(100, undefined)).toBeNull();
    expect(ratioOf(100, 0)).toBeNull();
    expect(ratioOf(undefined, 100)).toBeNull();
    expect(ratioOf(0, 100)).toBe(0); // 确实零评论，和「没采到评论」不是一回事
    expect(ratioOf(25, 100)).toBe(0.25);
  });

  it('赞播比在抖音上必须是 null（没有播放这个分母）', () => {
    expect(ratioOf(DOUYIN_DETAIL.likes, DOUYIN_DETAIL.views)).toBeNull();
  });

  it('评赞比在抖音详情页上算得出来——赞和评都是真采到的', () => {
    // 这一项不吃播放量，抖音详情页两个分量都有，属于「仍然可信」的指标
    expect(ratioOf(DOUYIN_DETAIL.comments, DOUYIN_DETAIL.likes)).toBeCloseTo(3200 / 97000, 6);
    // 但主页只采到点赞、没采到评论 → 仍然是 null，不许拿 0 当分子
    expect(ratioOf(DOUYIN_HOME.comments, DOUYIN_HOME.likes)).toBeNull();
  });
});

describe('🔒 基线：只对真有播放量的样本求率', () => {
  it('整个账号都没有播放量 → 四个率和均播都是 null，不是 0', () => {
    const b = buildBaseline([DOUYIN_DETAIL, DOUYIN_DETAIL, DOUYIN_DETAIL]);
    expect(b.sample).toBe(3);
    expect(b.avgViews).toBeNull();
    expect(b.likeRate).toBeNull();
    expect(b.commentRate).toBeNull();
    expect(b.shareRate).toBeNull();
    expect(b.collectRate).toBeNull();
  });

  it('🔒 混合样本：没播放量的那条不参与求均值（否则把率系统性拉低）', () => {
    const b = buildBaseline([WITH_VIEWS, DOUYIN_DETAIL]);
    // 只有 WITH_VIEWS 一条能算率，likeRate 应当等于它自己的 5000/100000
    expect(b.likeRate).toBeCloseTo(0.05, 6);
    // 修复前是 (0.05 + 0) / 2 = 0.025，凭空腰斩
    expect(b.likeRate).not.toBeCloseTo(0.025, 6);
    expect(b.sample).toBe(2); // 样本数照实说 2 条
  });

  it('有播放量的账号一切照旧', () => {
    const b = buildBaseline([WITH_VIEWS]);
    expect(b.avgViews).toBe(100000);
    expect(b.collectRate).toBeCloseTo(0.008, 6);
  });
});

describe('🔒 诊断：没数据不许编出结论', () => {
  it('小红书 · 没有播放量时不许报「收藏率 0.0%，工具价值被认可」', () => {
    const ds = diagnose('xiaohongshu', [DOUYIN_DETAIL, DOUYIN_DETAIL, DOUYIN_DETAIL]);
    const collect = ds.find((d) => d.signal.includes('收藏率'));
    // 修复前：collectRate=0、likeRate=0 → `0 < 0` 为假 → 走 else → 报了一句「工具价值被认可」
    expect(collect).toBeUndefined();
    for (const d of ds) expect(d.finding).not.toMatch(/0\.0%/);
  });

  it('抖音 · 没有播放量时不许报评论互动率的结论', () => {
    const ds = diagnose('douyin', [DOUYIN_DETAIL, DOUYIN_DETAIL, DOUYIN_DETAIL]);
    expect(ds.find((d) => d.signal.includes('评论互动率'))).toBeUndefined();
    for (const d of ds) expect(d.finding).not.toMatch(/0\.0%/);
  });

  it('有播放量时诊断照常工作（不许因为这次改动把正常路径也关掉）', () => {
    const weak = [
      { views: 10000, likes: 1000, comments: 5, collects: 10, completion: 0.5 },
      { views: 12000, likes: 1200, comments: 6, collects: 12, completion: 0.5 },
      { views: 8000, likes: 800, comments: 4, collects: 8, completion: 0.5 },
    ];
    expect(diagnose('douyin', weak).map((d) => d.signal)).toContain('评论互动率');
    expect(diagnose('xiaohongshu', weak).some((d) => d.signal.includes('收藏率'))).toBe(true);
  });
});

describe('🔒 页面不许把算不出来的比率渲染成 0.0%', () => {
  const TOP = readFileSync(resolve(process.cwd(), 'app/(app)/competitors/CompetitorTopPosts.tsx'), 'utf8');
  const COMP = readFileSync(resolve(process.cwd(), 'app/(app)/competitors/page.tsx'), 'utf8');

  it('竞对榜：互动率/赞播比都不许无条件 toFixed 出来', () => {
    // 领奖台那三格此前是无条件渲染的：抖音作品上就是「播放量 0 / 互动率 0.0% / 赞播比 0.0%」
    expect(TOP).not.toMatch(/\{\(p\.rate \* 100\)\.toFixed\(1\)\}%/);
    expect(TOP).not.toMatch(/\{\(p\.likeToView \* 100\)\.toFixed\(1\)\}%/);
  });

  it('竞对榜：源码里要有「算不出来就显示占位」的处理', () => {
    expect(TOP).toContain('NA_TEXT');
  });

  it('竞对页平均互动率：只对算得出来的作品求均值', () => {
    expect(COMP).toMatch(/engagementRate\(/);
    expect(COMP).toMatch(/!== null|!= null/);
  });
});
