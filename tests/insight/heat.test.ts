import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { interactionTotal, heatForSort, normalizedHeat } from '@/lib/insight/heat';
import type { Metrics } from '@/lib/json';

// 高热作品榜的排序口径。原来是 `hotScore = views / 20000`，纯播放量算的——
// 抖音/小红书/X 的公开页根本不显示播放量，于是这些平台的作品**恒为 0**，
// 而这个 0 决定了：哪 50 条能进榜、榜怎么排、哪些进选题候选、AI 被告知「热度 0」。

const DOUYIN: Metrics = { likes: 97000, comments: 3200, collects: 8100, shares: 1500 }; // 没有播放量
const BILI: Metrics = { views: 102372046, likes: 2835408, comments: 221779, collects: 1491503, shares: 473570 };
const HOME_CARD: Metrics = { likes: 6746 }; // 主页卡片只采到点赞
const NOTHING: Metrics = {};

describe('🔒 互动量：没有播放量的平台也排得出先后', () => {
  it('抖音作品算得出互动量（旧口径这里是 0）', () => {
    expect(interactionTotal(DOUYIN)).toBe(97000 + 3200 + 8100 + 1500);
  });

  it('只采到点赞也算数——有多少算多少，不要求四项齐全', () => {
    expect(interactionTotal(HOME_CARD)).toBe(6746);
  });

  it('🔒 一项都没采到 → null（「不知道」，不是「零互动」）', () => {
    expect(interactionTotal(NOTHING)).toBeNull();
  });

  it('🔒 故意不含播放量：否则报播放的平台仅因数字大就永远霸榜', () => {
    // B站 播放 1 亿，但互动量只按赞评藏转算 —— 不能让 1e8 把互动量淹掉
    expect(interactionTotal(BILI)).toBe(2835408 + 221779 + 1491503 + 473570);
    expect(interactionTotal(BILI)).toBeLessThan(BILI.views!);
  });

  it('🔒 排序时「没采到」排最后，不混进「互动最少」那一堆', () => {
    expect(heatForSort(NOTHING)).toBe(-1);
    expect(heatForSort(HOME_CARD)).toBe(6746);
    expect(heatForSort(NOTHING)).toBeLessThan(heatForSort(HOME_CARD));
  });

  it('抖音作品能排在只有点赞的作品前面（旧口径下两者都是 0，顺序随机）', () => {
    expect(heatForSort(DOUYIN)).toBeGreaterThan(heatForSort(HOME_CARD));
  });
});

describe('🔒 选题候选的 heat 按批内最大值归一', () => {
  it('批内最强的那条 = 1，其余按比例', () => {
    const h = normalizedHeat([HOME_CARD, DOUYIN]);
    expect(h[1]).toBe(1);
    expect(h[0]).toBeGreaterThan(0);
    expect(h[0]).toBeLessThan(1);
  });

  it('🔒 不许用固定除数：小号作品会永远接近 0、大号永远顶格', () => {
    // 同一批只有小号作品时，最强的那条仍然应当是 1（相对权重，不是绝对量级）
    expect(normalizedHeat([HOME_CARD])).toEqual([1]);
  });

  it('全都没采到指标时不炸，也不产出 NaN', () => {
    const h = normalizedHeat([NOTHING, NOTHING]);
    expect(h.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('🔒 榜上不许再出现算不出来的派生指标与 hotScore', () => {
  // 只看代码不看注释：注释里正引用着这些旧指标名当反面教材，
  // 连注释一起断言的话，守卫会被自己的说明文字钉死（这个坑今天已经踩过一次）。
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const TOP = strip(readFileSync(resolve(process.cwd(), 'app/(app)/competitors/CompetitorTopPosts.tsx'), 'utf8'));
  const PAGE = readFileSync(resolve(process.cwd(), 'app/(app)/competitors/page.tsx'), 'utf8');

  it('赞播比/评赞比/藏赞比已从榜上移除（多数平台算不出来，位置留给真有的数）', () => {
    for (const label of ['赞播比', '评赞比', '藏赞比']) {
      expect(TOP, `${label} 仍在榜上`).not.toContain(label);
    }
  });

  it('热度分/爆款热度已移除', () => {
    expect(TOP).not.toContain('爆款热度');
    expect(TOP).not.toContain('热度指数');
  });

  it('🔒 榜的取数不许再按 hotScore 排序（那是纯播放量算的）', () => {
    expect(strip(PAGE)).not.toMatch(/orderBy:\s*\{\s*hotScore/);
  });

  it('🔒 领奖台不许写死指标格——没采到的项会被印成 0', () => {
    // 真机 2026-08-11：领奖台固定摆「点赞/评论/收藏」，而抖音主页只采得到点赞，
    // 榜首于是显示「评论 0 · 收藏 0」。那不是零互动，是这两项根本没采。
    // 判据：格子由 podiumCells 按「真的有值」挑出来，而不是写死的字面量数组。
    expect(TOP).toContain('podiumCells');
    expect(TOP).not.toMatch(/lbl:\s*'评论',\s*val:\s*fmtNum/);
  });

  it('换上的是真实绝对数：评论量/收藏量/转发量', () => {
    for (const label of ['评论', '收藏', '转发']) {
      expect(TOP, `榜上没有${label}`).toContain(label);
    }
  });
});
