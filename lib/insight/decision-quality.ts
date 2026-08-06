import { prisma } from '../db';

// 决策质量：把「AI 的推荐/会诊到底准不准」本身变成可复盘对象——这是对平台信任的来源。
// 全部基于既有表统计，零新数据。

const RECOMMEND_SOURCES = ['hot', 'competitor', 'advisor'];
const ADOPTED_STATES = ['accepted', 'drafting', 'published', 'reviewed'];

export type DecisionQuality = {
  recommendAdopted: number;
  recommendRejected: number;
  adoptRatePct: number | null; // 推荐采纳率
  advisorAdopted: number;
  advisorRejected: number;
  advisorHitRatePct: number | null; // 智囊团采纳率
  angleProven: number; // 被数据验证有效的切入角数
  angleFailed: number; // 未跑出基线的切入角数
  reviewed: number; // 已复盘选题数
};

export async function decisionQuality(accountId: string, workspaceId: string): Promise<DecisionQuality> {
  const [topics, opinions, angleProven, angleFailed, reviewed] = await Promise.all([
    prisma.topicIdea.findMany({
      where: { accountId, sourceType: { in: RECOMMEND_SOURCES } },
      select: { state: true },
    }),
    prisma.advisorOpinion.findMany({
      where: { session: { accountId }, adopted: { not: null } },
      select: { adopted: true },
    }),
    prisma.memoryEntry.count({ where: { accountId, workspaceId, type: 'preference', active: true, content: { contains: '被数据验证有效' } } }),
    prisma.memoryEntry.count({ where: { accountId, workspaceId, type: 'preference', active: true, content: { contains: '未跑出基线' } } }),
    prisma.topicIdea.count({ where: { accountId, state: 'reviewed' } }),
  ]);

  const recommendAdopted = topics.filter((t) => ADOPTED_STATES.includes(t.state)).length;
  const recommendRejected = topics.filter((t) => t.state === 'rejected').length;
  const recDenom = recommendAdopted + recommendRejected;
  const adoptRatePct = recDenom > 0 ? Math.round((recommendAdopted / recDenom) * 100) : null;

  const advisorAdopted = opinions.filter((o) => o.adopted === true).length;
  const advisorRejected = opinions.filter((o) => o.adopted === false).length;
  const advDenom = advisorAdopted + advisorRejected;
  const advisorHitRatePct = advDenom > 0 ? Math.round((advisorAdopted / advDenom) * 100) : null;

  return {
    recommendAdopted,
    recommendRejected,
    adoptRatePct,
    advisorAdopted,
    advisorRejected,
    advisorHitRatePct,
    angleProven,
    angleFailed,
    reviewed,
  };
}
