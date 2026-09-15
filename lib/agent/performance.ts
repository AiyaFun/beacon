import { prisma } from '../db';
import { runsEconomics } from './economics';

// ── 可解释员工绩效 v1（2026-09-11 P2）：五项硬指标，不做总分 ────────────────────
//
// 【为什么不做总分】总分把「跑得稳但慢」和「跑得快但常被驳回」压成同一个数，
// 管理者据此淘汰谁都是错的。五项各自可下钻到样本；样本不足就写「不足」，不补分。
// 指标定义带版本号（METRIC_VERSION）：口径一改，历史对比就该失效，别让两个口径的数摆在一起比。
//
//   reliability   成功完成 / 有效发起（done / (done+failed)；取消不算发起）——样本 = 这个员工的运行
//   leadTime      工单从建单到验收通过的中位时长（只算验收通过的工单）
//   acceptance    验收通过的工单 / 送到过审校的工单（验收过或被驳回过的工单数，按工单不按事件）
//   rework        每个验收通过的工单平均返工次数
//   unitCost      验收通过的工单挂着的运行的真实 AI 成本 / 验收通过的工单数（分子分母同一批工单）
// cohort 只有一个：近 N 天指派给这个员工的内容工单（WorkItemRun 是共同事实表）；样本量随指标展示。
//
// 曝光量刻意不进来：发布效果受账号、选题与时机影响，直接归功给某次执行是过度因果。

export const METRIC_VERSION = 'v1';
/** 少于这么多样本就不给数（给了也是噪声） */
export const MIN_SAMPLES = 3;

export type Metric = {
  key: 'reliability' | 'leadTime' | 'acceptance' | 'rework' | 'unitCost';
  label: string;
  /** null = 样本不足 */
  value: number | null;
  unit: '%' | 'min' | 'x' | 'usd';
  samples: number;
  definition: string;
  /** 下钻：样本在哪儿看 */
  href: string;
};

export type PerformanceView = {
  metricVersion: string;
  rangeDays: number;
  metrics: Metric[];
  /** 异常原因 Top（失败的 error 前缀聚合） */
  failureReasons: { reason: string; count: number }[];
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 失败原因聚合：取错误文案前 24 字当键（够区分「模板不存在」与「额度用完」，不至于每条都不同）。 */
export function groupFailureReasons(errors: readonly (string | null)[]): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of errors) {
    const k = (e ?? '未知原因').replace(/\s+/g, ' ').slice(0, 24);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5);
}

/** 纯计算部分，用例直接测。 */
export function computeMetrics(input: {
  runs: readonly { status: string; createdAt: Date; updatedAt: Date }[];
  /** 验收通过的工单数 */
  accepted: number;
  /** 送到过审校的工单数（验收过或被驳回过，按工单去重） */
  reviewed: number;
  reworkTotalOfAccepted: number;
  /** 验收通过的工单从建单到验收的分钟数 */
  leadMinutes: readonly number[];
  /** 验收通过的工单挂着的运行的真实成本 */
  costUsdOfAccepted: number;
}, agentHref: string): Metric[] {
  const done = input.runs.filter((r) => r.status === 'done');
  const failed = input.runs.filter((r) => r.status === 'failed');
  const effective = done.length + failed.length;
  const durations = input.leadMinutes.filter((x) => x >= 0);
  const delivered = input.reviewed;
  const med = median(durations);
  return [
    { key: 'reliability', label: '运行可靠性', unit: '%', samples: effective, value: effective >= MIN_SAMPLES ? Math.round((done.length / effective) * 100) : null, definition: '成功完成 / 有效发起（取消不算发起）', href: agentHref },
    { key: 'leadTime', label: '交付时效', unit: 'min', samples: durations.length, value: durations.length >= MIN_SAMPLES && med !== null ? Math.round(med) : null, definition: '工单从建单到验收通过的中位时长（只算验收通过的）', href: '/runs?view=work' },
    { key: 'acceptance', label: '被接受产物率', unit: '%', samples: delivered, value: delivered >= MIN_SAMPLES ? Math.round((input.accepted / delivered) * 100) : null, definition: '验收通过的工单 / 送到过审校的工单（按工单数，不按驳回次数）', href: '/runs?view=work' },
    { key: 'rework', label: '返工率', unit: 'x', samples: input.accepted, value: input.accepted >= MIN_SAMPLES ? Math.round((input.reworkTotalOfAccepted / input.accepted) * 100) / 100 : null, definition: '每个验收通过的工单平均返工次数', href: '/runs?view=work' },
    { key: 'unitCost', label: '单位交付成本', unit: 'usd', samples: input.accepted, value: input.accepted >= MIN_SAMPLES ? Math.round((input.costUsdOfAccepted / input.accepted) * 10000) / 10000 : null, definition: '验收通过的工单所挂运行的真实 AI 成本 / 验收通过的工单数（同一批工单）', href: '/runs?view=work' },
  ];
}

export async function agentPerformance(workspaceId: string, templateId: string, rangeDays = 30, now = new Date()): Promise<PerformanceView> {
  const since = new Date(now.getTime() - rangeDays * 86_400_000);
  const [runs, items] = await Promise.all([
    prisma.agentRun.findMany({
      where: { workspaceId, agentTemplateId: templateId, createdAt: { gte: since }, status: { in: ['done', 'failed'] } },
      select: { id: true, status: true, error: true, createdAt: true, updatedAt: true },
      take: 500,
    }),
    prisma.contentWorkItem.findMany({
      where: { workspaceId, agentTemplateId: templateId, updatedAt: { gte: since } },
      select: { id: true, createdAt: true, acceptedAt: true, reworkCount: true, events: { where: { kind: { in: ['accept', 'reject'] } }, select: { kind: true } }, runs: { select: { runId: true } } },
    }),
  ]);
  const acceptedItems = items.filter((i) => i.acceptedAt);
  const accepted = acceptedItems.length;
  // 按工单去重：一单被驳回三次再验收，只算一个「送到过审校」的样本
  const reviewed = items.filter((i) => i.acceptedAt || i.events.some((e) => e.kind === 'reject')).length;
  const reworkTotalOfAccepted = acceptedItems.reduce((n, i) => n + i.reworkCount, 0);
  const leadMinutes = acceptedItems.map((i) => (i.acceptedAt!.getTime() - i.createdAt.getTime()) / 60_000);
  // 分子分母同一批：只算验收通过的工单挂着的运行
  const cost = await runsEconomics(acceptedItems.flatMap((i) => i.runs.map((r) => r.runId)));
  return {
    metricVersion: METRIC_VERSION,
    rangeDays,
    metrics: computeMetrics({ runs, accepted, reviewed, reworkTotalOfAccepted, leadMinutes, costUsdOfAccepted: cost.costUsd }, `/workflows?agent=${templateId}`),
    failureReasons: groupFailureReasons(runs.filter((r) => r.status === 'failed').map((r) => r.error)),
  };
}
