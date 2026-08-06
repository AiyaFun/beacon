import { prisma } from '../db';
import { textShingles, personaShingles } from './scoring';
import type { PersonaCard } from '../persona';

// 竞争饱和度取数（research-5 §5.2）：近 72h 竞对作品里有多少条已经在做这个话题。
// 数据源是 CrawledPost 全局表——饱和度问的是「市场上这个话题挤不挤」，跟哪个租户订阅了谁无关。
// 产出 0-1 交给 coarseRank 的倒 U 因子：无人做（可能没流量）和挤爆（做不出头）都降分。

const WINDOW_HOURS = 72;
// 计数 5 封顶：5 条同题竞对作品已足以判定红海，再多不增加信息量，还会让头部话题的分母失真
const COUNT_CAP = 5;
// 至少共享 2 个 2-gram 才算「做过同一话题」：单个常见二字词（如「教程」「今天」）撞上的概率太高
const MIN_OVERLAP = 2;

// 纯函数核心：候选标题 × 竞对作品标题 → 每个候选的饱和度（0-1）
export function saturationFromTitles(candidateTitles: string[], postTitles: string[]): Record<string, number> {
  const posts = postTitles.map((t) => textShingles(t));
  const out: Record<string, number> = {};
  for (const title of candidateTitles) {
    const grams = textShingles(title);
    let count = 0;
    for (const p of posts) {
      let overlap = 0;
      for (const g of grams) {
        if (p.has(g)) {
          overlap++;
          if (overlap >= MIN_OVERLAP) break;
        }
      }
      if (overlap >= MIN_OVERLAP) count++;
    }
    out[title] = Math.min(count, COUNT_CAP) / COUNT_CAP;
  }
  return out;
}

// P2-4 赛道过滤：只统计与账号同赛道的竞对作品。
// 「这个话题挤不挤」对一个健身号来说，挤的应该是健身赛道——全网都在聊某个泛热点，
// 不等于健身号做它就撞车。判据沿用全站同一把尺（共享 ≥2 个中文 2-gram，与粗排/cantDo 同口径）。
// 人设为空或过滤后样本太少时**退回全局口径**：宁可用全网数据，也不拿 3 条样本假装赛道结论。
const MIN_NICHE_SAMPLE = 8;

export function filterNichePosts(postTitles: string[], persona?: PersonaCard | null): string[] {
  if (!persona) return postTitles;
  const broad = personaShingles(persona);
  // 赛道词本身（persona.niche，如「健身增肌」）单独成一档：命中它一个就算同赛道。
  // 只用「共享 ≥2 个 2-gram」会把「健身两年心得」这种明显同赛道的作品判出去
  // （它只共享「健身」一个 gram），过滤器于是长期达不到样本线、白白退回全局口径。
  const core = textShingles(persona.niche ?? '');
  if (broad.size === 0 && core.size === 0) return postTitles;
  const kept = postTitles.filter((t) => {
    const grams = textShingles(t);
    let overlap = 0;
    for (const g of grams) {
      if (core.has(g)) return true;
      if (broad.has(g)) {
        overlap++;
        if (overlap >= MIN_OVERLAP) return true;
      }
    }
    return false;
  });
  return kept.length >= MIN_NICHE_SAMPLE ? kept : postTitles;
}

// 取数入口：竞对库为空 → 空表（coarseRank 缺省按 0 处理，新账号不受影响）。
// 传 persona 则按赛道过滤后再算饱和度（P2-4）；不传保持原全局口径，既有调用点行为不变。
export async function computeSaturation(
  candidateTitles: string[],
  persona?: PersonaCard | null,
): Promise<Record<string, number>> {
  if (candidateTitles.length === 0) return {};
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);
  const recent = await prisma.crawledPost.findMany({
    // 优先看发布时间；采集到的老作品没有 publishedAt 时退到采集时间，避免把整库历史都算成「近 72h」
    where: { OR: [{ publishedAt: { gte: since } }, { publishedAt: null, crawledAt: { gte: since } }] },
    select: { title: true },
  });
  if (recent.length === 0) return {};
  const titles = filterNichePosts(recent.map((r) => r.title), persona);
  return saturationFromTitles(candidateTitles, titles);
}
