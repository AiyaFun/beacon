import { platformWindowHours } from '../hot/lifecycle';
import type { Candidate } from './scoring';

// 选题的时间结构（三队列）。
//
// 【要解决的问题】原推荐是一个按总分排序的平铺列表——一条「微博已爆 4 小时、抖音还没上」的
// 抢跑机会，和一条「新手必看的十个误区」被排在同一个榜上比大小。可这两件事的决策完全不同：
// 前者是「今天不做就没了」，后者是「什么时候做都行」。总分再准也回答不了「先做哪个」。
//
// 【三队列】
//   today     今日突击：有硬窗口，过期作废（升温中的热点、跨平台抢跑）
//   week      本周窗口：有节奏但不紧急（降温期热点、竞对爆款、话题回温、跨平台补发）
//   evergreen 常青储备：无时效（赛道长青题）。**不参与每日名额竞争**，只在空窗时保底，
//             见 sources/evergreen.ts —— 它的价值是「没热点的日子也有活干」，
//             不是每天占掉一个本该给真热点的位置。
//
// 队列只决定「排产顺序」，不决定「值不值得做」——后者仍是六维评分的事，两者不互相顶替。

export type TopicQueue = 'today' | 'week' | 'evergreen';

// 热点过了平台窗口的一半就不再算「今日突击」：此时同题内容已铺满，抢跑窗口的价值主要在前半程。
// 用比例而非固定小时数，是因为各平台的内容半衰期差一个数量级（微博 36h vs B站 240h，见 lifecycle.ts）。
const TODAY_MAX_AGE_RATIO = 0.5;

// 候选归队。候选源显式声明的队列优先（抢跑/翻新这类源自己最清楚窗口），
// 其余按「这条还有没有时间压力」推断。
export function resolveQueue(c: Candidate, now: Date = new Date()): TopicQueue {
  if (c.queue) return c.queue;
  // 竞对爆款没有硬窗口：别人已经发了，晚一天做不会「过期」，只会更卷。归本周。
  if (c.sourceType === 'competitor') return 'week';
  // 缺生命周期信息就当没有时间压力——宁可把一条真热点排到本周，
  // 也不能把一条来路不明的候选贴上「今天不做就没了」的紧迫标签去催用户。
  if (!c.lifecycle || !c.firstSeenAt) return 'week';
  if (c.lifecycle !== 'rising' && c.lifecycle !== 'peak') return 'week';
  const ageHours = (now.getTime() - c.firstSeenAt.getTime()) / 3_600_000;
  return ageHours <= platformWindowHours(c.sourceType) * TODAY_MAX_AGE_RATIO ? 'today' : 'week';
}

// 名额基准比例。today 占多数但不独占——全给 today 就退化回「只推热点」，
// 那正是要改掉的毛病：一个只会追热点的选题引擎，在没热点的日子等于停摆。
const TODAY_RATIO = 0.6;
// 回填优先级：空出来的名额先补今日突击（有窗口的先做），再补本周，常青兜底。
const REFILL_ORDER: TopicQueue[] = ['today', 'week', 'evergreen'];

export function queueQuota(topN: number): Record<TopicQueue, number> {
  if (topN <= 0) return { today: 0, week: 0, evergreen: 0 };
  // 至少留 1 个今日突击位：哪怕 topN=1，有窗口的机会也该优先于慢慢做的题。
  const today = Math.min(topN, Math.max(1, Math.round(topN * TODAY_RATIO)));
  return { today, week: topN - today, evergreen: 0 };
}

// 按队列配额从粗排结果里选 topN。
//
// 关键约束：**总数恒等于 min(topN, ranked.length)**。配额只改变「选谁」，绝不减少产出——
// 某队列候选不足时名额必须回流给别的队列，否则「今天没有紧急热点」就会变成「今天推荐变少了」，
// 用户看到的是产品坏了，不是市场没货。
//
// 返回值保持粗排原序（不按队列重排）：下游 finePrompt 逐条打分与顺序无关，
// 保持原序能让「配额是否真的改变了选择」在测试里一眼可见。
export function allocateByQueue(ranked: Candidate[], topN: number, now: Date = new Date()): Candidate[] {
  if (topN <= 0) return [];
  // 候选还不够填满 topN：配额毫无意义，全要（也保证既有「候选少时行为不变」）
  if (ranked.length <= topN) return [...ranked];

  const pools: Record<TopicQueue, Candidate[]> = { today: [], week: [], evergreen: [] };
  for (const c of ranked) pools[resolveQueue(c, now)].push(c);

  const quota = queueQuota(topN);
  const picked = new Set<Candidate>();
  const cursor: Record<TopicQueue, number> = { today: 0, week: 0, evergreen: 0 };

  const takeFrom = (q: TopicQueue, n: number): number => {
    let taken = 0;
    while (taken < n && cursor[q] < pools[q].length) {
      picked.add(pools[q][cursor[q]++]);
      taken++;
    }
    return taken;
  };

  let filled = 0;
  for (const q of REFILL_ORDER) filled += takeFrom(q, quota[q]);
  // 回流：把没用掉的名额按优先级分给还有存货的队列
  for (const q of REFILL_ORDER) {
    if (filled >= topN) break;
    filled += takeFrom(q, topN - filled);
  }

  return ranked.filter((c) => picked.has(c));
}
