import { prisma } from '../db';
import { toJson } from '../json';
import { MAX_RUNS_PER_DAY } from './schedule';
import { backgroundSchedulerRuns } from '../jobs/queue';

// ── 建一条定时计划 ──────────────────────────────────────────────────────────
//
// 【为什么单独成文件】这段逻辑此前整个躺在 app/(app)/workflows/schedule-actions.ts 里，
// 而那个文件顶上是 'use server'——它的每个导出都必须是 async server action，
// 同步的辅助函数（clampTime）永远导不出来，整段也没法在没有会话的地方复用。
//
// 现在 AI 也要能起草定时计划（起草制：模型出草案、用户确认后才落库），
// 而 AI 执行跑在后台、手上**没有会话**。要么把这段抄一份到工具里，要么抽出来共用。
// 抄一份的下场是确定的：整十分口径、模板归属谓词、条数上限，三处一旦分叉，
// 改一处漏一处，而且失效得静悄悄（用户配了一条永远不执行的计划，没有任何人报错）。

/**
 * 计划条数上限 = 每日跑动上限。
 *
 * 配得比上限多，多出来的每天都会被闸拦下、每天写一条「已跑满」——
 * 用户看到的是一堆永远不执行的计划。不如一开始就不让配。
 */
export const MAX_SCHEDULES = MAX_RUNS_PER_DAY;

export type CreateScheduleInput = {
  workspaceId: string;
  accountId: string;
  memberId: string;
  tenantId: string;
  templateId: string;
  atHour: number;
  atMinute: number;
  weekdays: number[];
};

/**
 * 时刻归一。
 *
 * **只允许整十分**：扫描每 10 分钟一轮，配成 09:07 会让用户以为
 * 「说好 7 分却 10 分才跑」。界面上也只给这几个选项，这里是服务端的同一道口径。
 */
export function clampScheduleTime(h: number, m: number): { hour: number; minute: number } {
  const hour = Number.isInteger(h) ? Math.min(23, Math.max(0, h)) : 9;
  const minute = Number.isInteger(m) ? Math.min(50, Math.max(0, Math.round(m / 10) * 10)) : 0;
  return { hour, minute };
}

/** 星期几的去重与范围校验。空数组 = 每天（不是「一天都不跑」）。 */
export function normalizeWeekdays(raw: number[]): number[] {
  return [...new Set(raw.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
}

export type CreateScheduleResult = { ok: true; id: string } | { ok: false; error: string };

export async function createSchedule(input: CreateScheduleInput): Promise<CreateScheduleResult> {
  // 界面在没有后台调度的部署里已经不给表单了，这里再拦一次：只藏界面不拦服务端，
  // 等于没拦——直接调 action（或让 AI 调工具）照样能建出一堆永不执行的计划
  if (!backgroundSchedulerRuns()) {
    return { ok: false, error: '这台机器上的后台定时没有在跑，配了也不会到点执行' };
  }

  const count = await prisma.scheduledAgent.count({ where: { workspaceId: input.workspaceId } });
  if (count >= MAX_SCHEDULES) {
    return { ok: false, error: `最多配 ${MAX_SCHEDULES} 条定时计划（每天总共也只跑这么多次）` };
  }

  // 模板必须是这个租户能用的：不校验的话可以把别人的自建模板 id 填进来定时跑。
  // 这个 OR 谓词与 listTemplates / runWorkflow 是同一份，别在这里另写一种写法
  const t = await prisma.workflowTemplate.findFirst({
    where: { id: input.templateId, enabled: true, OR: [{ isBuiltin: true }, { tenantId: input.tenantId }] },
    select: { id: true },
  });
  if (!t) return { ok: false, error: '这个智能体不存在或未启用' };

  const { hour, minute } = clampScheduleTime(input.atHour, input.atMinute);

  const row = await prisma.scheduledAgent.create({
    data: {
      workspaceId: input.workspaceId,
      accountId: input.accountId, // 派它在**当前账号**名下干活，跟数据页口径一致
      templateId: t.id,
      atHour: hour,
      atMinute: minute,
      weekdays: toJson(normalizeWeekdays(input.weekdays)),
      createdBy: input.memberId,
    },
  });
  return { ok: true, id: row.id };
}
