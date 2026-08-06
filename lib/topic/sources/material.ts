import { loadMaterials, type MaterialEntry } from '../../material';
import { textShingles, type Candidate } from '../scoring';

// 候选增强：素材唤醒（F3-5 经历/观点素材库 × 当前候选）。
//
// 【为什么这是差异化最强的一块】热点人人可抄，竞对分析人人可做，连切入角都可能撞——
// 唯独**你亲身经历过的事**别人拿不走。素材库里躺着用户自己录入的经历/案例/观点，
// 此前只在「生成初稿时作为写作原料」被用到（materialContextForAccount → 创作阶段）。
// 但它更该在**选题阶段**说话：同样两条热点，一条你有亲历、一条没有，值不值得做完全不同。
//
// 【为什么是 enricher，不改 sourceType】与话题回温不同：
//   - 回温改写来源，因为**推荐它的理由变了**（不再是「它在热榜上」，而是「你做过它且它又火了」）；
//   - 素材唤醒不改来源，因为它回答的是**「你能怎么做得不一样」**，不是「为什么推它」。
//     所以它对任何来源的候选都成立（热点/抢跑/竞对/日历都能挂），只是往 evidence 上追加一句。
//
// 【口头禅不参与】catchphrase 是语气资产（写稿时用），不是选题依据。
// 拿「我常说'先跑通再优化'」去论证某个热点值得做，是把风格当论据。

// 与全站一致的「相关」判据：共享 ≥2 个中文 2-gram
const MIN_OVERLAP = 2;
// 能作为差异化论据的素材类型（见文件头为什么排除 catchphrase）
const USABLE_TYPES = new Set(['experience', 'case', 'opinion']);
const TYPE_LABEL: Record<string, string> = {
  experience: '亲身经历',
  case: '真实案例',
  opinion: '既有观点',
};
// 素材正文可能很长，证据句里只放开头一小段做提示——完整内容在创作阶段才需要。
const SNIPPET = 40;

function overlapCount(aGrams: Set<string>, text: string): number {
  const bGrams = textShingles(text);
  let n = 0;
  for (const g of aGrams) if (bGrams.has(g)) n++;
  return n;
}

export type MaterialMatch = { material: MaterialEntry; score: number };

// 候选标题 × 素材 → 最相关的一条（无匹配返回 null）。
// 标签命中优先于正文命中：标签是用户自己打的主题词，比正文里偶然重合的字更能说明「这条素材是讲这个的」。
export function bestMaterialFor(title: string, materials: MaterialEntry[]): MaterialMatch | null {
  const grams = textShingles(title);
  let best: MaterialMatch | null = null;
  for (const m of materials) {
    if (!USABLE_TYPES.has(m.type)) continue;
    // 标签精确命中：标签本身出现在标题里，或标题与标签共享足够 gram
    const tagHit = m.tags.some((t) => {
      const tag = t.trim();
      if (tag.length < 2) return false;
      return title.includes(tag) || overlapCount(grams, tag) >= MIN_OVERLAP;
    });
    const bodyOverlap = overlapCount(grams, m.content);
    if (!tagHit && bodyOverlap < MIN_OVERLAP) continue;
    // 标签命中给固定高分，正文命中按重合度——两者不可比，所以分档而不是相加
    const score = tagHit ? 100 + bodyOverlap : bodyOverlap;
    if (!best || score > best.score) best = { material: m, score };
  }
  return best;
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > SNIPPET ? `${clean.slice(0, SNIPPET)}…` : clean;
}

// 纯函数：给命中素材的候选追加一句证据。不改 sourceType、不改队列、不新增候选。
// 已有 evidence（如话题回温、抢跑窗口）的候选**追加而非覆盖**——两句都是事实，都该让用户看到。
export function enrichWithMaterial(candidates: Candidate[], materials: MaterialEntry[]): Candidate[] {
  const usable = materials.filter((m) => USABLE_TYPES.has(m.type));
  if (usable.length === 0) return candidates;
  return candidates.map((c) => {
    const hit = bestMaterialFor(c.title, usable);
    if (!hit) return c;
    const label = TYPE_LABEL[hit.material.type] ?? '素材';
    const line = `你的素材库里有一条相关的${label}：「${snippet(hit.material.content)}」——同题内容里，只有你能把这段讲出来。`;
    return { ...c, evidence: c.evidence ? `${c.evidence} ${line}` : line };
  });
}

// 取数入口。素材库为空 → 原样返回（新账号不受影响）。
export async function enrichCandidatesWithMaterial(accountId: string, candidates: Candidate[]): Promise<Candidate[]> {
  if (candidates.length === 0) return candidates;
  const materials = await loadMaterials(accountId);
  return enrichWithMaterial(candidates, materials);
}
