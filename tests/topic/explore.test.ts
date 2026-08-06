import { describe, it, expect } from 'vitest';
import { pickExploration, EXPLORATION_NOTE } from '@/lib/topic/explore';
import type { Candidate } from '@/lib/topic/scoring';
import type { PersonaCard } from '@/lib/persona';

// 真探索位（research-5 §6.3）：从没进 Top N 的候选里挑「热度前 25% 且人设匹配低于中位数」。
// 本文件存在的理由：旧实现是把精排最后一名贴上 isExploration 标签——那不是探索，
// 是给排名垫底的选题换了个好听的名字。这里锁死「选谁」和「宁缺毋滥」两条。

const persona: PersonaCard = {
  identity: '前端工程师',
  audience: '前端新人',
  valueProp: '把复杂工具链讲明白',
  niche: '前端工程化',
  canDo: ['构建优化', '性能调优'],
  cantDo: [],
  tone: '干货',
  platforms: ['bilibili'],
} as PersonaCard;

const c = (title: string, heat: number): Candidate => ({ title, heat, sourceType: 'hot' });

describe('探索位选取', () => {
  it('选中「热度前 25% 且人设匹配低于中位数」的落选候选', () => {
    const pool = [
      c('前端工程化实践指南', 0.3), // 高匹配，已进推荐
      c('前端构建优化提速', 0.2), // 高匹配，已进推荐
      c('明星八卦大瓜', 1.0), // 池内热度第一（前 25%），零匹配 → 正是探索位要的
      c('今日菜价播报', 0.05), // 零匹配但热度垫底 → 不配
    ];
    const picked = pickExploration(pool, new Set(['前端工程化实践指南', '前端构建优化提速']), persona);
    expect(picked?.title).toBe('明星八卦大瓜');
  });

  it('宁缺毋滥：落选候选热度都不够高 → 不追加', () => {
    const pool = [
      c('前端工程化实践指南', 1.0),
      c('前端构建优化提速', 0.8),
      c('明星八卦大瓜', 0.2), // 零匹配但热度排不进前 25%
      c('今日菜价播报', 0.05),
    ];
    expect(pickExploration(pool, new Set(['前端工程化实践指南', '前端构建优化提速']), persona)).toBeNull();
  });

  it('宁缺毋滥：全池匹配打平（中位数即下限）时没有「明显更不像你」的候选 → 不追加', () => {
    // 两条都零匹配 → 中位数 0，没人能「低于」0 —— 不许硬凑
    const pool = [c('明星八卦大瓜', 1.0), c('今日菜价播报', 0.9)];
    expect(pickExploration(pool, new Set(['明星八卦大瓜']), persona)).toBeNull();
  });

  it('候选全部进了推荐（无落选者）→ 不追加', () => {
    const pool = [c('前端工程化实践指南', 0.5), c('明星八卦大瓜', 1.0)];
    expect(pickExploration(pool, new Set(['前端工程化实践指南', '明星八卦大瓜']), persona)).toBeNull();
  });

  it('空池不抛', () => {
    expect(pickExploration([], new Set(), persona)).toBeNull();
  });

  it('多条符合条件时取热度最高的', () => {
    const pool = [
      c('前端工程化实践指南', 0.3),
      c('明星八卦大瓜', 1.0),
      c('体育赛事爆冷', 0.95), // 前 25% 门槛按 8 条池算覆盖前 2 名
      c('前端构建优化提速', 0.2),
      c('前端性能调优实战', 0.25),
      c('前端工具链拆解', 0.22),
      c('今日菜价播报', 0.05),
      c('天气预报明日多云', 0.04),
    ];
    const recommended = new Set(['前端工程化实践指南', '前端构建优化提速', '前端性能调优实战', '前端工具链拆解']);
    expect(pickExploration(pool, recommended, persona)?.title).toBe('明星八卦大瓜');
  });

  it('探索位文案是给创作者看的人话', () => {
    expect(EXPLORATION_NOTE).toContain('探索位');
    expect(EXPLORATION_NOTE).toContain('试试看');
  });
});
