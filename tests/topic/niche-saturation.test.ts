import { describe, it, expect, vi } from 'vitest';
import type { PersonaCard } from '@/lib/persona';
import { filterNichePosts, saturationFromTitles } from '@/lib/topic/saturation';
import { coarseRank } from '@/lib/topic/scoring';

// 三期 P2-4（饱和度按赛道）与 P2-5（粗排语义匹配）的取舍锁定。

const persona = {
  identity: '健身教练',
  audience: '上班族',
  valueProp: '把训练讲明白',
  niche: '健身增肌',
  canDo: ['深蹲教学'],
  cantDo: [],
  tone: '干货',
  platforms: ['douyin'],
} as PersonaCard;

// 同赛道 9 条（过 MIN_NICHE_SAMPLE=8 的线）+ 跨赛道噪声
const nichePosts = [
  '健身增肌怎么吃', '增肌训练计划', '深蹲教学要点', '健身房新手指南',
  '增肌期的碳水', '健身两年心得', '增肌与减脂', '健身教练怎么选', '增肌补剂避坑',
];
const offNichePosts = ['明星塌房实录', '手机新品发布', '股市今日收评', '明星塌房后续'];

describe('P2-4 饱和度按赛道过滤', () => {
  it('同赛道样本充足时只留同赛道作品', () => {
    const kept = filterNichePosts([...nichePosts, ...offNichePosts], persona);
    expect(kept).toHaveLength(nichePosts.length);
    expect(kept).not.toContain('明星塌房实录');
  });

  it('同赛道样本不足 8 条时退回全局口径（不拿小样本装赛道结论）', () => {
    const few = ['健身增肌怎么吃', '增肌训练计划', ...offNichePosts];
    expect(filterNichePosts(few, persona)).toEqual(few);
  });

  it('不传人设时原样返回（既有调用点行为不变）', () => {
    expect(filterNichePosts(nichePosts, null)).toEqual(nichePosts);
  });

  it('过滤掉跨赛道噪声后，泛热点的饱和度更低——「全网在聊」不等于「我这条赛道挤」', () => {
    const candidate = ['明星塌房怎么看'];
    const global = saturationFromTitles(candidate, [...nichePosts, ...offNichePosts]);
    const niche = saturationFromTitles(candidate, filterNichePosts([...nichePosts, ...offNichePosts], persona));
    expect(global['明星塌房怎么看']).toBeGreaterThan(niche['明星塌房怎么看']);
  });
});

describe('P2-5 粗排语义匹配（只加不减）', () => {
  // A：词形零命中的同义候选（该账号其实该看）；B：词形完全命中；C：纯高热无关话题
  const A = { title: '自重锻炼计划', heat: 0.5, sourceType: 'hot' };
  const B = { title: '健身增肌怎么吃', heat: 0.5, sourceType: 'hot' };
  const C = { title: '今日股市收评', heat: 0.9, sourceType: 'hot' };

  it('无语义分时行为与原公式完全一致', () => {
    const a = coarseRank([A, B, C], persona);
    const b = coarseRank([A, B, C], persona, {}, {});
    expect(a.map((c) => c.title)).toEqual(b.map((c) => c.title));
    expect(a[0].title).toBe('健身增肌怎么吃'); // 词形命中的排前
  });

  it('语义分把词形零命中的同义候选从高热无关话题之下捞上来', () => {
    const before = coarseRank([A, C], persona);
    expect(before[0].title).toBe('今日股市收评'); // 只有热度说话时，无关高热话题在前
    const after = coarseRank([A, C], persona, {}, { 自重锻炼计划: 0.95 });
    expect(after[0].title).toBe('自重锻炼计划');
  });

  it('语义分低于词形分时不压低已命中的候选（取 max，词形永远是地板）', () => {
    const ranked = coarseRank([A, B], persona, {}, { 健身增肌怎么吃: 0, 自重锻炼计划: 0.5 });
    expect(ranked[0].title).toBe('健身增肌怎么吃');
  });
});

describe('P2-5 语义分只在真 embedding key 下启用', () => {
  it('Mock/哈希嵌入返回空表——dev 零基础设施下粗排退化为纯词形', async () => {
    vi.resetModules();
    const { semanticPersonaFit } = await import('@/lib/topic/semantic');
    // dev 默认无 BEACON_EMBED_* → getEmbedder() 返回 mocked 的 HashingEmbedder
    expect(await semanticPersonaFit(['健身增肌怎么吃'], persona)).toEqual({});
  });
});
