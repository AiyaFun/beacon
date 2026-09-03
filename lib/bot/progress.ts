import { prisma } from '../db';
import { sendToChat, updateChatMessage, beaconUrl } from './index';
import { createLogger } from '../logger';
import type { PushMessage } from './types';

const log = createLogger({ module: 'bot-progress' });

// 群里派出的任务的**进度卡**（2026-09-03，学 Hermes gateway 的「能编辑消息的渠道就地改，不能的不刷屏」）。
//
// 此前群里派活之后只有三种时候有声音：等确认 / 跑完 / 没跑成（后来加了等插件 / 等额度）。
// 跑几分钟的任务中间是黑箱，用户只能去网页刷。现在：派出时发一张卡记下 message_id，
// 之后每记一步就把这张卡改成「正在跑 · 已走 N 步 · 最近：xxx」，终态再改成最终状态。
// 只改这一张卡，绝不每步发一条——那是教用户把机器人关掉。
//
// 【只有飞书】updateChatMessage 只认飞书（别的渠道没有「改已发消息」这个接口）；
// 其它渠道 startProgressCard 也会发一张「已开始」卡，只是之后改不了，终态由 echoRunToChat 另发一条。
//
// 【节流】每条运行最少隔 EDIT_MIN_INTERVAL_MS 才改一次（进程内记时），状态迁移时强制改。
// 飞书编辑接口有频控，一轮工具连着调五次不该打五次 PATCH。
const EDIT_MIN_INTERVAL_MS = 10_000;
const lastEditAt = new Map<string, number>();

function parseRef(ref: string): { integrationId: string; chatId: string } | null {
  const first = ref.indexOf(':');
  const second = first < 0 ? -1 : ref.indexOf(':', first + 1);
  if (second < 0) return null;
  return { integrationId: ref.slice(first + 1, second), chatId: ref.slice(second + 1) };
}

const TITLE: Record<string, (g: string) => string> = {
  queued: (g) => `🚀 任务已排队：${g}`,
  running: (g) => `⚙️ 正在跑：${g}`,
  awaiting_confirm: (g) => `✋ 等你确认：${g}`,
  waiting_browser: (g) => `🧩 等浏览器插件：${g}`,
  waiting_quota: (g) => `⏳ 等额度：${g}`,
  done: (g) => `✅ 跑完了：${g}`,
  failed: (g) => `❌ 没跑成：${g}`,
  cancelled: (g) => `⏹ 已终止：${g}`,
};

function shortGoal(goal: string): string {
  const g = goal.replace(/\s+/g, ' ').trim();
  return g.length > 40 ? `${g.slice(0, 40)}…` : g;
}

export function renderProgressCard(run: {
  id: string; goal: string; status: string; answer?: string | null; error?: string | null;
}, progress: { steps: number; lastTool?: string | null; lastOk?: boolean | null }): PushMessage {
  const g = shortGoal(run.goal);
  const lines: string[] = [];
  if (progress.steps > 0) {
    const last = progress.lastTool ? ` · 最近：${progress.lastTool}${progress.lastOk === false ? '（失败）' : ''}` : '';
    lines.push(`已走 ${progress.steps} 步${last}`);
  } else if (run.status === 'queued' || run.status === 'running') {
    lines.push('进度会在这张卡上更新');
  }
  if (run.status === 'done') lines.push((run.answer ?? '').trim().slice(0, 300) || '已完成，点下面看它做了什么。');
  if (run.status === 'failed') lines.push((run.error ?? '未说明原因').slice(0, 300));
  if (run.status === 'awaiting_confirm') lines.push('下一步会改数据或花额度，到网页里点头它才继续（群里不能确认）。');
  if (run.status === 'waiting_browser') lines.push('这一步要在你的浏览器里采集，打开装了烽火台插件的浏览器它就会接着跑。');
  if (run.status === 'waiting_quota') lines.push('今天的 AI 额度用完了，额度重置后自动继续。');
  return {
    kind: 'card',
    title: (TITLE[run.status] ?? ((x: string) => `任务：${x}`))(g),
    lines: lines.length ? lines : ['—'],
    link: { text: '去看看', url: beaconUrl(`/runs/${run.id}`) },
  };
}

/** 派出时发一张进度卡，记下消息 id。旁路：失败只记日志。 */
export async function startProgressCard(runId: string): Promise<boolean> {
  try {
    const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { id: true, workspaceId: true, botChatRef: true, goal: true, status: true } });
    if (!run?.botChatRef) return false;
    // 起卡是异步旁路：一个瞬间跑完的任务可能在这里执行时已经是终态——那时 echoRunToChat 已经/正要
    // 发终态回执，再发一张「跑完了」的进度卡就是同一句话说两遍（dispatch 端到端用例抓到的）。
    if (['done', 'failed', 'cancelled'].includes(run.status)) return false;
    const ref = parseRef(run.botChatRef);
    if (!ref) return false;
    const r = await sendToChat(run.workspaceId, ref.integrationId, ref.chatId, renderProgressCard(run, { steps: 0 }));
    if (!r.ok) { log.warn('进度卡发送失败', { runId, error: r.error }); return false; }
    if (r.messageId) {
      await prisma.agentRun.updateMany({ where: { id: runId }, data: { botMessageId: r.messageId } });
      lastEditAt.set(runId, Date.now());
    }
    return true;
  } catch (e) {
    log.warn('进度卡异常', { runId, err: e });
    return false;
  }
}

/** 把那张卡改成当前状态。节流；状态迁移时传 force。旁路，永不抛。 */
export async function updateProgressCard(runId: string, opts: { force?: boolean; now?: number } = {}): Promise<boolean> {
  try {
    const now = opts.now ?? Date.now();
    if (!opts.force && now - (lastEditAt.get(runId) ?? 0) < EDIT_MIN_INTERVAL_MS) return false;
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, workspaceId: true, botChatRef: true, botMessageId: true, goal: true, status: true, answer: true, error: true },
    });
    if (!run?.botChatRef || !run.botMessageId) return false;
    const ref = parseRef(run.botChatRef);
    if (!ref) return false;
    const [steps, last] = await Promise.all([
      prisma.agentStep.count({ where: { runId } }),
      prisma.agentStep.findFirst({ where: { runId }, orderBy: { seq: 'desc' }, select: { tool: true, ok: true, kind: true } }),
    ]);
    lastEditAt.set(runId, now);
    const r = await updateChatMessage(run.workspaceId, ref.integrationId, run.botMessageId, renderProgressCard(run, {
      steps, lastTool: last?.tool || last?.kind || null, lastOk: last?.ok ?? null,
    }));
    if (!r.ok) log.info('进度卡更新失败', { runId, error: r.error });
    return r.ok;
  } catch (e) {
    log.warn('进度卡更新异常', { runId, err: e });
    return false;
  }
}

/** 测试用 */
export function __resetProgressThrottle(): void { lastEditAt.clear(); }
