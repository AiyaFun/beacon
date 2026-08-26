import { prisma } from '../db';
import { notify } from '../notify';
import type { AgentRunStatus } from './run';

// ── 「跑完了叫我一声」 ────────────────────────────────────────────────────────
//
// 【为什么非有不可】执行改成后台跑之后，用户被明确告知「可以关掉这一页去做别的」。
// 而在这之前，AI 执行**一次通知都不发**（lib/agent 全目录零 notify 调用）——
// 于是「关掉页面」的真实含义是「这件事从此没有任何东西会提醒你」。
// 浏览器任务早就有通知了，AI 执行反而没有，恰恰是它最需要：它能停在「等你确认」上。
//
// 【去重键 = runId + 状态 + 激活段】
// 只按 (runId, status) 去重的话，将来「追问 → 同一条运行再跑一遍 → 又跑完了」
// 那次不会通知——而追问的人正是最想知道结果的那个。episode 那一列就是为这个存在的。

/** 哪些状态值得吵醒用户。running / queued 不在其中：那是正常推进，不是需要他知道的事。 */
const NOTIFY_STATUSES: readonly AgentRunStatus[] = [
  'awaiting_confirm',
  'waiting_browser',
  'waiting_quota',
  'done',
  'failed',
];

type RunForNotify = {
  id: string;
  workspaceId: string;
  accountId: string | null;
  memberId: string;
  goal: string;
  status: string;
  episode: number;
  error: string | null;
  answer: string | null;
};

function shortGoal(goal: string, max = 40): string {
  const g = goal.trim().replace(/\s+/g, ' ');
  return g.length > max ? `${g.slice(0, max)}…` : g;
}

/**
 * 通知文案。**每一条都要说清「这事现在归谁」**：
 * 通知是工作区级的红点（Notification 表没有 memberId，人人可见），
 * 而「确认」只有发起人点得动。写第二人称「等你确认」会让同事去点一个必定报错的按钮。
 */
function messageFor(run: RunForNotify, who: string): { title: string; body: string } | null {
  const g = shortGoal(run.goal);
  switch (run.status) {
    case 'awaiting_confirm':
      return {
        title: `等 ${who} 确认一步操作`,
        body: `任务「${g}」需要确认一个会改数据或花额度的动作，确认后才会继续。`,
      };
    case 'waiting_browser':
      return {
        title: `任务在等浏览器插件：${g}`,
        body: '已经把活排给浏览器插件了，等它下次醒来跑完就会自动接着做。',
      };
    case 'waiting_quota':
      return {
        title: `任务等额度重置：${g}`,
        body: '今日 AI 额度用完了，北京时间 0 点重置后会自动接着跑，不用管它。',
      };
    case 'done':
      return {
        title: `任务跑完了：${g}`,
        body: (run.answer ?? '').trim().slice(0, 200) || '已完成，点进去看它做了什么。',
      };
    case 'failed':
      return {
        title: `任务没跑成：${g}`,
        body: (run.error ?? '未说明原因').slice(0, 200),
      };
    default:
      return null;
  }
}

/**
 * 这次状态变化该不该通知，该的话发出去。
 *
 * 旁路增强：**任何一步出问题都只是没通知，绝不能影响执行本身**——
 * 所以整个函数吞掉自己的错（notify() 内部也是这么做的）。
 */
export async function notifyRunStatus(runId: string, status: AgentRunStatus): Promise<boolean> {
  if (!NOTIFY_STATUSES.includes(status)) return false;
  try {
    const run = (await prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        id: true, workspaceId: true, accountId: true, memberId: true,
        goal: true, status: true, episode: true, error: true, answer: true,
      },
    })) as RunForNotify | null;
    // 状态对不上说明这次迁移已经被后来的变化盖过去了，那就让后来那次去通知
    if (!run || run.status !== status) return false;

    const refId = notifyRefId(run.id, status, run.episode);
    // 去重：同一段里同一个状态只叫一次。重复触发是常态（叫醒重投、自愈顺手也踢了一次）
    const already = await prisma.notification.count({ where: { workspaceId: run.workspaceId, refId } });
    if (already > 0) return false;

    const member = await prisma.member.findUnique({ where: { id: run.memberId }, select: { name: true } });
    const msg = messageFor(run, member?.name ?? '发起人');
    if (!msg) return false;

    await notify({
      workspaceId: run.workspaceId,
      accountId: run.accountId,
      // 【点名给发起人】这几种状态里，能推动它的只有他一个人：
      // 等确认只有他点得动，跑完了也是他在等结果。
      // 不点名的话同事会为一件自己做不了的事看到红点。
      memberId: run.memberId,
      kind: 'system',
      refId,
      title: msg.title,
      body: msg.body,
      // 带 runId：不带的话点过去是一个空白助手页，那次运行再也找不回来
      link: `/assistant?run=${run.id}`,
    });
    return true;
  } catch {
    return false; // 通知发不出去是小事，绝不能因此影响执行
  }
}

/** 去重键。格式统一在这里，别在调用点手写字符串。 */
export function notifyRefId(runId: string, status: string, episode: number): string {
  return `agentrun:${runId}:${status}:${episode}`;
}
