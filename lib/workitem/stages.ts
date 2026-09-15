// ── 内容工单的阶段机（2026-09-11 P1）：**纯函数、零依赖**，客户端与用例都能 import ──
//
// 阶段顺序固定：候选选题 → 起稿 → 审校 → 待发布 → 已发布 → 复盘。
// 验收/驳回只发生在「审校」：验收进「待发布」，驳回退回「起稿」并计一次返工。
// 不允许跳阶段（起稿直接到已发布）——那样「验收」这道闸就名存实亡。

export const WORK_STAGES = ['topic', 'drafting', 'review', 'ready', 'published', 'retro'] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

export const STAGE_LABEL: Record<WorkStage, { zh: string; en: string }> = {
  topic: { zh: '候选选题', en: 'Topic' },
  drafting: { zh: '起稿', en: 'Drafting' },
  review: { zh: '审校', en: 'Review' },
  ready: { zh: '待发布', en: 'Ready' },
  published: { zh: '已发布', en: 'Published' },
  retro: { zh: '复盘', en: 'Retro' },
};

export function isWorkStage(v: string): v is WorkStage {
  return (WORK_STAGES as readonly string[]).includes(v);
}

export function nextStage(s: WorkStage): WorkStage | null {
  const i = WORK_STAGES.indexOf(s);
  return i >= 0 && i < WORK_STAGES.length - 1 ? WORK_STAGES[i + 1] : null;
}

/** 从 from 推到 to 合不合法：只许前进一步；审校→起稿是返工（走 rework 不走 advance）。 */
export function canAdvance(from: WorkStage, to: WorkStage): boolean {
  return nextStage(from) === to;
}

/** 推进到下一阶段前，这单上得有什么。缺的那样就是「为什么推不动」。 */
export function advanceRequirement(to: WorkStage): { field: 'topicId' | 'draftId' | 'publishPlanId' | 'publishRecordId' | null; why: string } {
  switch (to) {
    case 'drafting': return { field: null, why: '' };
    case 'review': return { field: 'draftId', why: '进审校前得先有一篇草稿挂在这单上' };
    case 'ready': return { field: 'draftId', why: '验收的是草稿，没有草稿没法验收' };
    case 'published': return { field: 'publishRecordId', why: '要先登记发布记录（或让发布计划跑完）才算已发布' };
    case 'retro': return { field: 'publishRecordId', why: '没发出去的东西没法复盘' };
    default: return { field: null, why: '' };
  }
}

/** 一个工单的当前流程：给看板画进度条与「下一步该做什么」。 */
export function stageIndex(s: WorkStage): number {
  return WORK_STAGES.indexOf(s);
}

/** 看板上的一张卡（core.ts 的 hydrate 产出）。放这里是为了客户端组件能只 import 类型不带 prisma。 */
export type WorkItemView = {
  id: string;
  title: string;
  stage: WorkStage;
  status: string;
  accountId: string;
  accountName?: string;
  ownerMemberId: string | null;
  ownerName?: string;
  agentTemplateId: string | null;
  agentName?: string;
  dueAt: string | null;
  overdue: boolean;
  inputs: string;
  acceptance: string;
  topicId: string | null;
  draftId: string | null;
  draftTitle?: string;
  draftVersions?: number;
  publishPlanId: string | null;
  publishRecordId: string | null;
  runIds: string[];
  runs: { id: string; status: string; goal: string; href: string }[];
  rejectReason: string | null;
  reworkCount: number;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
  events: { id: string; kind: string; fromStage: string | null; toStage: string | null; note: string; memberId: string | null; memberName?: string; at: string }[];
};
