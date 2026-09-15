// ── 数字员工的状态口径：**纯函数、零依赖**（客户端组件也能 import） ───────────────
//
// 【为什么单独一个文件】lib/agent/overview.ts 引了 prisma。客户端组件（工作流页的两栏面板）
// 要用状态的字与配色；import 那边会把 prisma 一起打进浏览器包——tsc 与单测都不会红，
// 只有 next build 才炸（tests/ui/client-bundle-safety.test.ts 钉着这条）。
// 规矩同 lib/runs/badge.ts：常量与纯函数放能被两侧 import 的文件，碰数据库的留在服务端文件里。
//
// 【状态口径写在这里，界面不许各算一套】
//   stopped   —— 没装 / 已卸载 / 模板被禁用：派不了
//   blocked   —— 有一次运行停着等人或等外部（等确认 / 等浏览器 / 等额度 / 排队）
//   busy      —— 有一次运行正在跑
//   broken    —— 最近一次运行失败，或它名下的定时连败 / 已被自动停用
//   available —— 装着、没在跑、最近一次没坏
// 先判 stopped，再判 blocked（比 busy 更需要人）、busy、broken，最后才是 available。

export type AgentState = 'available' | 'busy' | 'blocked' | 'broken' | 'stopped';

export const AGENT_STATE_LABEL: Record<AgentState, { zh: string; en: string; cls: string }> = {
  available: { zh: '可用', en: 'Available', cls: 'badge-green' },
  busy: { zh: '忙碌', en: 'Busy', cls: 'badge-brand' },
  blocked: { zh: '受阻', en: 'Blocked', cls: 'badge-amber' },
  broken: { zh: '故障', en: 'Broken', cls: 'badge-red' },
  stopped: { zh: '停用', en: 'Stopped', cls: 'badge-gray' },
};

const BLOCKED_STATUSES = new Set(['awaiting_confirm', 'waiting_browser', 'waiting_quota', 'queued']);

export type StateInput = {
  installed: boolean;
  templateEnabled: boolean;
  /** 它名下**未结束**的运行的状态（AgentRun 的 LIVE 状态 + WorkflowRun 的 running） */
  liveStatuses: readonly string[];
  /** 最近一次已结束的运行 */
  lastFinished: { status: string; error: string | null } | null;
  /** 名下定时里连败中 / 被自动停用的条数 */
  brokenSchedules: number;
};

/** 状态机。**纯函数**，用例直接测——判错的方向都是「界面说可用、其实派不动」。 */
export function deriveAgentState(i: StateInput): { state: AgentState; reason: string } {
  if (!i.installed || !i.templateEnabled) return { state: 'stopped', reason: i.installed ? '模板已被禁用' : '没有安装（或已卸载）' };
  const blocked = i.liveStatuses.find((s) => BLOCKED_STATUSES.has(s));
  if (blocked) {
    const why = blocked === 'awaiting_confirm' ? '有一次执行停着等你确认'
      : blocked === 'waiting_browser' ? '有一次执行在等采集执行器 / 浏览器插件'
      : blocked === 'waiting_quota' ? '有一次执行在等今日额度重置'
      : '有一次执行在排队等前面的让位';
    return { state: 'blocked', reason: why };
  }
  if (i.liveStatuses.some((s) => s === 'running')) return { state: 'busy', reason: '正在跑一次执行' };
  // 一次失败不算故障（网络抖一下就把员工标红会让状态失真）：调用方只把连败 ≥2 或已自动停用的计入 brokenSchedules
  if (i.brokenSchedules > 0) return { state: 'broken', reason: `名下有 ${i.brokenSchedules} 条定时连续失败` };
  if (i.lastFinished?.status === 'failed') return { state: 'broken', reason: `最近一次执行失败：${(i.lastFinished.error ?? '未知原因').slice(0, 80)}` };
  return { state: 'available', reason: '装着、没在跑、最近一次没出错' };
}

/**
 * 成功率。**样本为 0 返回 null，不补 0 也不补 100**——
 * 「还没跑过」和「跑了 10 次全失败」在界面上必须是两种东西。
 */
export function successRate(done: number, failed: number): number | null {
  const n = done + failed;
  if (n === 0) return null;
  return Math.round((done / n) * 100);
}

export type RunStat = { total: number; done: number; failed: number; cancelled: number; rate: number | null };

export function statOf(rows: readonly { status: string }[]): RunStat {
  let done = 0; let failed = 0; let cancelled = 0;
  for (const r of rows) {
    if (r.status === 'done') done += 1;
    else if (r.status === 'failed') failed += 1;
    else if (r.status === 'cancelled') cancelled += 1;
  }
  return { total: rows.length, done, failed, cancelled, rate: successRate(done, failed) };
}
