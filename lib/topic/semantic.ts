import { getEmbedder, cosine } from '../vector/embed';
import type { PersonaCard } from '../persona';

// P2-5 粗排语义匹配：用 embedding 补词形匹配的同义盲区（「AI绘画」vs「生成式艺术」2-gram 零命中）。
//
// 三条自我约束，都是因为这是粗排里权重 0.40 的最大因子：
// 1) **只在配了真 embedding key 时启用**。开发态的 HashingEmbedder 本身就是 2-gram 分桶，
//    用它算「语义」相似度只是把同一把尺换个写法，质量不会更好，还可能引入哈希碰撞噪声——
//    mocked embedder 一律返回空表，粗排退化为原纯词形公式，dev 零基础设施铁律不受影响。
// 2) **失败即返回空表**，绝不让远程 embedding 抖动阻塞每日推荐。
// 3) 结果交给 coarseRank 与词形分取 max（只加不减），语义只能捞回漏配，不能压低已命中的候选。

// 人设 → 一段用于比对的赛道描述文本
function personaText(persona: PersonaCard): string {
  return [persona.niche, persona.identity, persona.valueProp, ...(persona.canDo ?? [])]
    .filter((x) => x && String(x).trim())
    .join('；');
}

export async function semanticPersonaFit(
  titles: string[],
  persona: PersonaCard,
  limit = 60,
): Promise<Record<string, number>> {
  const embedder = getEmbedder();
  if (embedder.mocked) return {}; // 见约束 1
  const text = personaText(persona);
  if (!text || titles.length === 0) return {};

  const unique = [...new Set(titles)].slice(0, limit);
  try {
    const vecs = await embedder.embed([text, ...unique]);
    if (vecs.length !== unique.length + 1) return {};
    const [personaVec, ...titleVecs] = vecs;
    const out: Record<string, number> = {};
    unique.forEach((t, i) => {
      // cosine ∈ [-1,1]；负相关一律按 0（无关），不做任何拉伸映射——不把弱相似度包装成强匹配
      out[t] = Math.max(0, cosine(personaVec, titleVecs[i]));
    });
    return out;
  } catch {
    return {}; // 见约束 2
  }
}
