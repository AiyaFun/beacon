import { describe, it, expect } from 'vitest';
import { coarseRank, type Candidate } from '@/lib/topic/scoring';
import { filterByCantDo } from '@/lib/pipeline';
import type { PersonaCard } from '@/lib/persona';

// P0-2 账号个性化候选池：cantDo 红线硬过滤 + 主战平台亲和度加权。
// 两条都是「有数据才生效、无数据退化为原行为」——回归锁在于既有粗排/推荐用例不受影响。

const persona = (over: Partial<PersonaCard> = {}): PersonaCard =>
  ({
    identity: '健身教练',
    audience: '想练但没方向的上班族',
    valueProp: '把训练讲明白',
    niche: '健身',
    canDo: ['增肌', '减脂'],
    cantDo: ['医疗建议', '荐股'],
    tone: '干货',
    platforms: ['douyin'],
    ...over,
  }) as PersonaCard;

const c = (title: string, heat: number, platform?: string): Candidate => ({ title, heat, sourceType: 'hot', platform });

describe('P0-2 · cantDo 红线硬过滤', () => {
  it('命中红线的候选被剔除（共享 ≥2 个 2-gram）', () => {
    const pool = [c('增肌餐一周食谱', 0.5), c('医疗建议：这样吃药才对', 0.9)];
    const kept = filterByCantDo(pool, persona());
    expect(kept.map((x) => x.title)).toEqual(['增肌餐一周食谱']);
  });

  it('短红线（≤3 字）走整词包含：荐股类被剔除', () => {
    const pool = [c('减脂打卡第7天', 0.5), c('推荐股票必涨内幕', 0.9)];
    const kept = filterByCantDo(pool, persona({ cantDo: ['荐股'] }));
    // '推荐股票' 归一化后含 '荐股' 相邻子串 → 命中
    expect(kept.map((x) => x.title)).toEqual(['减脂打卡第7天']);
  });

  it('不误伤：仅共享 1 个 2-gram 不算命中（医疗器械 ≠ 医疗建议）', () => {
    const pool = [c('医疗器械行业评测', 0.5)];
    const kept = filterByCantDo(pool, persona({ cantDo: ['医疗建议'] }));
    expect(kept).toHaveLength(1); // 只共享「医疗」一个 gram，保留
  });

  it('空池兜底：全部命中红线时放弃过滤，绝不清成空窗', () => {
    const pool = [c('健身房打卡', 0.5), c('健身餐分享', 0.9)];
    const kept = filterByCantDo(pool, persona({ cantDo: ['健身'] }));
    expect(kept).toHaveLength(2); // 若真剔完会 0 条 → 退回原池
  });

  it('cantDo 为空：原样返回', () => {
    const pool = [c('随便一条', 0.5)];
    expect(filterByCantDo(pool, persona({ cantDo: [] }))).toHaveLength(1);
  });
});

describe('P0-2 · 主战平台亲和度加权', () => {
  it('热度/匹配打平时，主战平台原生候选排在前', () => {
    const ranked = coarseRank(
      [c('外平台话题', 0.5, 'weibo'), c('本平台话题', 0.5, 'douyin')],
      persona(), // 主战 douyin
    );
    expect(ranked[0].title).toBe('本平台话题');
  });

  it('亲和度只是温和加权：外平台强热点仍压过本平台弱选题', () => {
    const ranked = coarseRank(
      [c('外平台强热点', 1.0, 'weibo'), c('本平台弱选题', 0.1, 'douyin')],
      persona(),
    );
    expect(ranked[0].title).toBe('外平台强热点');
  });

  it('候选无 platform 字段时退化为原公式（不影响既有用例）', () => {
    const ranked = coarseRank([c('甲', 0.2), c('乙', 0.9)], persona());
    expect(ranked[0].title).toBe('乙'); // 纯热度序
  });

  it('人设未填主战平台时亲和度恒 0', () => {
    const ranked = coarseRank(
      [c('话题A', 0.5, 'weibo'), c('话题B', 0.5, 'douyin')],
      persona({ platforms: [] }),
    );
    // 无亲和度差异，热度/匹配打平 → 保持稳定序（不因平台重排）
    expect(new Set(ranked.map((x) => x.title))).toEqual(new Set(['话题A', '话题B']));
  });
});
