import type { PersonaCard } from '../persona';
import { personaShingles, titleMatchScore, type Candidate } from './scoring';

// 真探索位（research-5 §6.3）：推荐系统只按人设匹配排序会自我强化（exposure→data→exposure），
// 越推越窄。解法是每天留一个「低后验但高热度」的位置：从**没进推荐 Top N** 的候选里挑
// 「热度位于池子前 25% 且人设匹配低于中位数」的一条——正因为匹配低它才进不了 Top N，
// 也正因为热度高它才值得试。找不到符合条件的就不追加，探索位宁缺毋滥地硬凑等于没有。

// 探索位的推荐理由（落库到 rationale，UI 直接展示给创作者）
export const EXPLORATION_NOTE = '探索位：热度高但和你的人设匹配存疑，试试看能不能打开新领域。';

export function pickExploration(
  pool: Candidate[],
  recommendedTitles: Set<string>,
  persona: PersonaCard,
): Candidate | null {
  const rest = pool.filter((c) => !recommendedTitles.has(c.title));
  if (rest.length === 0) return null;

  // 热度门槛：位于整个候选池前 25%（分位数按池子算，不按剩余算——「高热」是相对全场说的）
  const heats = pool.map((c) => c.heat).sort((a, b) => b - a);
  const quartile = Math.max(1, Math.ceil(pool.length * 0.25));
  const heatCut = heats[quartile - 1];

  // 人设匹配中位数（全池）：探索位要的是「明显不像你平时做的」，用中位数而非绝对阈值，
  // 让判定随账号自己的候选池自适应。
  // titleMatchScore 只依赖标题，算一次缓存进 Map 复用：中位数与过滤都从这里取，别算两遍。
  const shingles = personaShingles(persona);
  const scoreByTitle = new Map(pool.map((c) => [c.title, titleMatchScore(c.title, shingles)]));
  const matches = pool.map((c) => scoreByTitle.get(c.title)!).sort((a, b) => a - b);
  const n = matches.length;
  const median = n % 2 ? matches[(n - 1) / 2] : (matches[n / 2 - 1] + matches[n / 2]) / 2;

  const qualified = rest.filter((c) => c.heat >= heatCut && scoreByTitle.get(c.title)! < median);
  if (qualified.length === 0) return null;
  // 多条符合时取热度最高的：探索位的赌注就押在热度上
  return qualified.reduce((a, b) => (b.heat > a.heat ? b : a));
}
