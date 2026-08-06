import { prisma } from '../../db';
import { parseJson } from '../../json';
import { platformName } from '../../constants';
import { isSensitiveTitle } from '../../hot/sensitive';
import { textShingles, type Candidate } from '../scoring';

// 候选源：灵感收集箱。
//
// 【它补的是哪个洞】热榜给「已经爆了的」，竞对给「同行做了的」，自有数据给「你做过的」——
// 唯独没有「你**想过**的」。创作者刷到一条评论、一个别赛道的形式、一句想反驳的话，
// 那一刻的判断力是最准的，但此前系统里没有任何落点，等到坐下来选题时早忘干净了。
//
// 【两种用法，视情况二选一，不重复占位】
//   A) 唤醒：收藏的灵感与池中某条候选同题 → 给那条候选挂上「你 3 周前收藏过这个」的证据。
//      这是收集箱最有价值的时刻——你当时觉得值得记一笔的东西，现在真的火了。
//   B) 独立候选：没有同题热点的灵感 → 自己成为一条候选（本周队列，无时效压力）。
//   同一条灵感只会走其中一条路，绝不既唤醒又占位（同题两行推荐是纯噪声，与自搬运同一条纪律）。

// 与全站一致的「相关」判据：共享 ≥2 个中文 2-gram
const MIN_OVERLAP = 2;
// 独立候选的热度。灵感没有外部热度可言，但也不是 0：它是**用户自己**标记过「这值得做」的东西，
// 那是一个真实的人工信号。给一个明确的低位常量，让它在没有强热点的日子能浮上来，
// 有强热点时安静待着。数值是产品判断，不是测量值。
const INSPIRATION_HEAT = 0.3;
// 每轮最多放几条独立灵感候选：收集箱可能攒了上百条，全放进去会把候选池冲垮。
const MAX_STANDALONE = 3;

// 读者提问的候选热度。与灵感分开定：
// 灵感是「用户自己觉得值得做」（一个人的一次判断）；读者提问是「N 个真实的人独立地问了同一件事」。
// 跨作品权重更高——三条作品下都在问，比某一条下问了五次强得多。
// 上限刻意压在强热点之下：读者提问是**确定有人要**，不是**确定有流量**。
export const COMMENT_HEAT_BASE = 0.30;
export const COMMENT_HEAT_CAP = 0.55;
export function commentHeat(askedCount: number, askedWorks: number): number {
  const n = Math.min(askedCount, 8) / 8;
  const w = Math.min(askedWorks - 1, 3) / 3;
  return Math.min(COMMENT_HEAT_CAP, COMMENT_HEAT_BASE + n * 0.15 + w * 0.10);
}
export const MIN_ASKED_FOR_STANDALONE = 2;
const MAX_STANDALONE_COMMENT = 2;

const COMMENT_SOURCES = new Set(['comment', 'rival-comment']);

export type InspirationRow = {
  id: string;
  title: string;
  note: string | null;
  url: string | null;
  platform: string | null;
  author: string | null;
  tags: string;
  source: string;
  createdAt: Date;
  askedCount: number;
  askedWorks: number;
  lastAskedAt: Date | null;
};

function daysAgo(d: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
}

function whenText(d: Date, now: Date): string {
  const n = daysAgo(d, now);
  if (n === 0) return '今天';
  if (n < 7) return `${n} 天前`;
  if (n < 30) return `${Math.round(n / 7)} 周前`;
  return `${Math.round(n / 30)} 个月前`;
}

// 灵感的可比对文本 = 标题 + 备注 + 标签。
// 备注要算进去：用户写「这个开头的钩子很好」时，真正的主题词往往在备注里而不在原标题里。
function matchText(item: InspirationRow): string {
  return [item.title, item.note ?? '', ...parseJson<string[]>(item.tags, [])].join(' ');
}

function related(aGrams: Set<string>, b: string): boolean {
  const bGrams = textShingles(b);
  let overlap = 0;
  for (const g of aGrams) {
    if (bGrams.has(g)) {
      overlap++;
      if (overlap >= MIN_OVERLAP) return true;
    }
  }
  return false;
}

function sourceLine(item: InspirationRow): string {
  const parts = [item.platform ? platformName(item.platform) : '', item.author ?? ''].filter(Boolean);
  return parts.length ? `（来自${parts.join(' · ')}）` : '';
}

export type InspirationResult = { candidates: Candidate[]; wokeUp: number; standalone: number };

// 纯函数核心：把收集箱应用到候选池上。返回**新的候选数组**（含被唤醒的与新增的独立候选）。
export function applyInspiration(
  candidates: Candidate[],
  items: InspirationRow[],
  now: Date = new Date(),
): InspirationResult {
  if (items.length === 0) return { candidates, wokeUp: 0, standalone: 0 };

  const used = new Set<string>(); // 已经用掉的灵感 id（唤醒过就不再独立占位）
  let wokeUp = 0;

  // A) 唤醒：逐条候选找最匹配的灵感
  const enriched = candidates.map((c) => {
    const grams = textShingles(c.title);
    const hit = items.find((it) => !used.has(it.id) && related(grams, matchText(it)));
    if (!hit) return c;
    used.add(hit.id);
    wokeUp++;
    let line: string;
    if (COMMENT_SOURCES.has(hit.source)) {
      const worksText = hit.askedWorks > 1 ? `（分布在 ${hit.askedWorks} 条作品下）` : '';
      line = `你的读者在这个话题下问过 ${hit.askedCount} 次：「${hit.title}」${worksText}。这个话题现在真的起来了。`;
    } else {
      const note = hit.note ? `，当时记的是「${hit.note}」` : '';
      line = `你在${whenText(hit.createdAt, now)}把《${hit.title}》收进了灵感箱${sourceLine(hit)}${note}。这个话题现在真的起来了。`;
    }
    // 追加而非覆盖：可能已经有抢跑/回温/素材的证据，每一句都是独立事实
    return { ...c, evidence: c.evidence ? `${c.evidence} ${line}` : line };
  });

  // B) 独立候选：没被用掉的灵感里挑最近的几条
  // 灵感和评论分开选，各占各的名额：不分开的话评论量一上来就会把灵感全挤掉
  const unused = items
    .filter((it) => !used.has(it.id))
    .filter((it) => !isSensitiveTitle(it.title) && !isSensitiveTitle(it.note ?? ''))
    .filter((it) => {
      const grams = textShingles(matchText(it));
      return !enriched.some((c) => related(grams, c.title));
    });

  const inspirationItems = unused.filter((it) => !COMMENT_SOURCES.has(it.source)).slice(0, MAX_STANDALONE);
  const commentItems = unused
    .filter((it) => COMMENT_SOURCES.has(it.source))
    // 被问一次 = 一个人的一句话，不是需求信号
    .filter((it) => it.askedCount >= MIN_ASKED_FOR_STANDALONE)
    // 90 天外不做独立候选（仍可做唤醒证据）
    .filter((it) => it.lastAskedAt && now.getTime() - it.lastAskedAt.getTime() < 90 * 86_400_000)
    .slice(0, MAX_STANDALONE_COMMENT);

  const standalone: Candidate[] = [
    ...inspirationItems.map((it) => ({
      // 备注常常比原标题更接近「用户想做的那个选题」，有备注就用备注当标题
      title: (it.note?.trim() || it.title).slice(0, 120),
      heat: INSPIRATION_HEAT,
      sourceType: 'inspiration' as const,
      sourceRef: it.id,
      queue: 'week' as const,
      evidence: `你在${whenText(it.createdAt, now)}把《${it.title}》收进了灵感箱${sourceLine(it)}——当时觉得值得做，现在把它落地。`,
      windowHint: it.url ? `原内容：${it.url}` : undefined,
    })),
    ...commentItems.map((it) => {
      const worksText = it.askedWorks > 1 ? `（分布在 ${it.askedWorks} 条作品下）` : '';
      const variantsText = it.note ? `，${it.note}` : '';
      return {
        // 评论条目的 note 是元信息（「被问到 N 次；其它问法：…」），绝不能当标题
        title: it.title.slice(0, 120),
        heat: commentHeat(it.askedCount, it.askedWorks),
        sourceType: it.source as 'comment' | 'rival-comment',
        sourceRef: it.id,
        queue: 'week' as const,
        evidence: `这是你的读者直接问的问题，被问到 ${it.askedCount} 次${worksText}${variantsText}。回答自己读者的问题不需要蹭热点。`,
        windowHint: it.url ? `原内容：${it.url}` : undefined,
      };
    }),
  ];

  return { candidates: [...enriched, ...standalone], wokeUp, standalone: standalone.length };
}

// 取数入口：本账号可见的待用灵感（本账号专属 + 工作区共享）。
// 分两个窗口读：普通灵感和评论提问各占各的额度，互不挤占。
// 如果不分，评论量一上来就会把 take 的 60 行全占满，配额闸在这一层之后救不了。
export async function loadInspirations(workspaceId: string, accountId: string): Promise<InspirationRow[]> {
  const baseWhere = { workspaceId, state: 'open' as const, OR: [{ accountId: null }, { accountId }] };
  const select = {
    id: true, title: true, note: true, url: true,
    platform: true, author: true, tags: true, source: true,
    createdAt: true, askedCount: true, askedWorks: true, lastAskedAt: true,
  };
  const [inspirations, comments] = await Promise.all([
    prisma.inspirationItem.findMany({
      where: { ...baseWhere, source: { notIn: ['comment', 'rival-comment'] } },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select,
    }),
    prisma.inspirationItem.findMany({
      where: { ...baseWhere, source: { in: ['comment', 'rival-comment'] } },
      orderBy: [{ lastAskedAt: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select,
    }),
  ]);
  return [...inspirations, ...comments];
}

export async function applyInspirationForAccount(
  workspaceId: string,
  accountId: string,
  candidates: Candidate[],
): Promise<InspirationResult> {
  const items = await loadInspirations(workspaceId, accountId);
  return applyInspiration(candidates, items);
}

// 灵感转成选题被采纳后回写 used：收集箱是流动暂存区，用掉的要出队，
// 否则同一条灵感会在往后每一轮推荐里反复出现。
export async function markInspirationUsed(id: string): Promise<void> {
  // updateMany 而不是 update：TopicIdea.sourceRef 是**松引用**（没有 FK），
  // 灵感可能已被用户删掉。update 找不到记录会抛（还会在日志里刷一条 prisma:error），
  // updateMany 命中 0 行就是 0 行——这正是这里想要的语义。
  await prisma.inspirationItem.updateMany({
    where: { id },
    data: { state: 'used', usedAt: new Date() },
  });
}
