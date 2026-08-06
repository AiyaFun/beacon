import { describe, it, expect } from 'vitest';
import { coarseRank, runScoring, type Candidate } from '@/lib/topic/scoring';
import type { PersonaCard } from '@/lib/persona';

// 选题粗排。本文件的存在理由是 VERIFICATION.md 里记的那个已修 bug：
//   「粗排中文匹配失效：人设关键词是复合词，整词 includes 命中率低，导致无关高热选题排到相关选题前。」
// 修法是中文 2-gram 指纹匹配 + 提高人设匹配权重（0.35 热度 / 0.45 匹配 / 0.20 饱和度）。
// 修过的 bug 最容易回归——这里把它锁死。

const persona = (over: Partial<PersonaCard> = {}): PersonaCard =>
  ({
    identity: '前端工程师',
    niche: '前端工程化',
    valueProp: '把复杂工具链讲明白',
    canDo: ['构建优化', '性能调优'],
    // 以下字段不进粗排指纹，但 runScoring 精排会走 personaPromptBlock，缺了会抛
    audience: '前端新人',
    cantDo: [],
    tone: '干货',
    platforms: ['bilibili'],
    ...over,
  }) as PersonaCard;

const c = (title: string, heat: number): Candidate => ({ title, heat, sourceType: 'hot' });

describe('选题粗排 · 中文 2-gram 回归锁（核心）', () => {
  it('相关低热选题必须压过无关高热选题', () => {
    // 这就是 bug 的原始形态：「前端工程化」作为整词不会出现在标题里，
    // 整词 includes 恒不命中 → 匹配分恒为 0 → 纯按热度排 → 娱乐八卦屠版。
    const ranked = coarseRank(
      [c('某明星深夜发文引爆热搜', 1.0), c('前端工程化实践：构建提速 10 倍', 0.2)],
      persona(),
    );
    expect(ranked[0].title).toBe('前端工程化实践：构建提速 10 倍');
  });

  it('人设复合词被切成 2-gram 后能命中标题片段', () => {
    // 「前端工程化」→ 前端/端工/工程/程化，标题里的「前端」「工程」都能命中
    const ranked = coarseRank([c('无关话题一则', 0.9), c('聊聊前端构建', 0.1)], persona());
    expect(ranked[0].title).toBe('聊聊前端构建');
  });

  it('canDo 里的能力词也进指纹（不只 niche）', () => {
    const ranked = coarseRank([c('今日财经速览', 0.95), c('性能调优实战', 0.05)], persona());
    expect(ranked[0].title).toBe('性能调优实战');
  });

  it('identity 与 valueProp 也进指纹', () => {
    const ranked = coarseRank([c('明星热搜', 0.9), c('工程师的工具链心得', 0.1)], persona());
    expect(ranked[0].title).toBe('工程师的工具链心得');
  });

  it('热度仍然有效：两条都不匹配人设时按热度排', () => {
    const ranked = coarseRank([c('无关话题甲', 0.2), c('无关话题乙', 0.9)], persona());
    expect(ranked[0].title).toBe('无关话题乙');
  });

  it('都匹配人设时按热度排（匹配分打平后热度决定）', () => {
    const ranked = coarseRank([c('前端工程化入门', 0.2), c('前端工程化进阶', 0.9)], persona());
    expect(ranked[0].title).toBe('前端工程化进阶');
  });

  it('匹配数 cap 3：堆砌关键词无法无限刷分', () => {
    const stuffed = c('前端工程化前端工程化前端工程化构建优化性能调优', 0.0);
    const single = c('前端聊聊', 0.0);
    const ranked = coarseRank([single, stuffed], persona());
    // 堆砌的确实更高，但不该高到能让 heat=0 压过一个满匹配 + 高热的
    expect(ranked[0].title).toBe(stuffed.title);
    const vsHot = coarseRank([stuffed, c('前端工程化构建优化实战', 1.0)], persona());
    expect(vsHot[0].heat).toBe(1.0);
  });

  it('大小写不敏感（英文人设词）', () => {
    const p = persona({ niche: 'TypeScript', canDo: [] });
    const ranked = coarseRank([c('无关高热话题', 0.9), c('typescript 类型体操', 0.1)], p);
    expect(ranked[0].title).toBe('typescript 类型体操');
  });
});

describe('选题粗排 · 饱和度倒 U', () => {
  // 饱和度数据从竞对库取数的部分见 tests/topic/saturation.test.ts；
  // 这里只锁倒 U 因子本身的形状，以及 runScoring 确实把 saturation 传进了粗排（曾经是死参数）。
  it('中等饱和度(0.5)优于红海(1.0)', () => {
    const cands = [c('前端话题甲', 0.5), c('前端话题乙', 0.5)];
    const ranked = coarseRank(cands, persona(), { '前端话题甲': 1.0, '前端话题乙': 0.5 });
    expect(ranked[0].title).toBe('前端话题乙');
  });

  it('中等饱和度优于无人问津(0)', () => {
    const cands = [c('前端话题甲', 0.5), c('前端话题乙', 0.5)];
    const ranked = coarseRank(cands, persona(), { '前端话题甲': 0.0, '前端话题乙': 0.5 });
    expect(ranked[0].title).toBe('前端话题乙');
  });

  it('缺省饱和度不报错（默认 0）', () => {
    expect(() => coarseRank([c('话题', 0.5)], persona())).not.toThrow();
  });

  it('runScoring 真的把 saturation 传进粗排：红海候选被挤出 topN', async () => {
    // 回归锁：saturation 参数曾经从未被调用方传过（satFactor 恒 0.7 的死代码）。
    // 两条候选热度/人设匹配完全打平，topN=1，只有饱和度能分出胜负。
    const scored = await runScoring(
      null,
      [c('前端话题甲', 0.5), c('前端话题乙', 0.5)],
      persona(),
      '',
      1,
      { '前端话题甲': 1.0, '前端话题乙': 0.5 },
    );
    expect(scored).toHaveLength(1);
    expect(scored[0].title).toBe('前端话题乙');
  });
});

describe('精排结果的 Mock 标注', () => {
  it('dev 无 key 走 Mock provider 时，ScoredTopic.mocked = true', async () => {
    const scored = await runScoring(null, [c('前端工程化实践', 0.5)], persona(), '', 1);
    expect(scored[0].mocked).toBe(true);
    // Mock 返回的是合法 JSON，不该被当成「AI 返回异常」
    expect(scored[0].rationale).not.toContain('默认分');
  });
});

describe('选题粗排 · 健壮性', () => {
  it('空候选 → 空数组', () => {
    expect(coarseRank([], persona())).toEqual([]);
  });

  it('人设为空 → 不抛，退化为按热度排', () => {
    const empty = { identity: '', niche: '', valueProp: '', canDo: [] } as unknown as PersonaCard;
    const ranked = coarseRank([c('甲', 0.1), c('乙', 0.9)], empty);
    expect(ranked[0].title).toBe('乙');
  });

  it('canDo 缺失（undefined）不抛', () => {
    const p = { identity: '工程师', niche: '前端', valueProp: '' } as unknown as PersonaCard;
    expect(() => coarseRank([c('前端话题', 0.5)], p)).not.toThrow();
  });

  it('不改动输入数组，只返回新序', () => {
    const cands = [c('甲', 0.1), c('乙', 0.9)];
    const copy = [...cands];
    coarseRank(cands, persona());
    expect(cands).toEqual(copy);
  });

  it('输出与输入等长且元素不丢', () => {
    const cands = [c('甲', 0.1), c('乙', 0.9), c('前端丙', 0.5)];
    const ranked = coarseRank(cands, persona());
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked.map((x) => x.title))).toEqual(new Set(['甲', '乙', '前端丙']));
  });

  it('单字人设不产生指纹时不误命中所有标题', () => {
    // cleaned.length < 2 → 无 2-gram → 匹配分全 0 → 纯热度序
    const p = { identity: '甲', niche: '', valueProp: '', canDo: [] } as unknown as PersonaCard;
    const ranked = coarseRank([c('随便', 0.1), c('随便二', 0.9)], p);
    expect(ranked[0].title).toBe('随便二');
  });
});
