// 公开「今日选题榜」的预设赛道（2026-09-05）。
//
// 只是**给没登录的人一个入口**：这几个是国内内容平台上最常见的创作者赛道，
// 每个都能让八条常青公式生成出读得通的标题。用户可以用 ?niche= 换成自己的词（限 2–20 字）。
// 登录用户的赛道来自人设卡，与这张表无关。
export const PRESET_NICHES: readonly string[] = ['职场成长', '家常菜', '母婴育儿', '健身减脂', '个人理财', '数码测评', '英语学习', '旅行攻略'] as const;

/** 赛道词清洗：2–20 个字，只留汉字、字母、数字与常见分隔；别的形状一律退回默认。 */
export function normalizeNiche(raw: unknown, fallback: string = PRESET_NICHES[0]): string {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().replace(/[^\p{Script=Han}A-Za-z0-9·\- ]/gu, '').slice(0, 20);
  return v.length >= 2 ? v : fallback;
}
