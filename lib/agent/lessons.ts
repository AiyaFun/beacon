import { prisma } from '../db';
import { memoryThreat } from '../memory/guard';
import { toolByName } from './tools';

// ── 偏好回路：这个工作区的「教训」反哺系统提示（2026-09-09）──────────────────
//
// 【它补的是什么】执行器早就在留痕：用户拒绝过哪些工具调用（kind=rejected）、模型被打回过几次
//（编示例数据 / 把调用写成正文 / 摊手不记缺口）、哪些工具反复失败、用户追问里说过什么。
// 这些全躺在 AgentStep / AgentRunNote 里，**从来没有反哺过下一次执行**——同一个坑每次都重新踩。
// 用户要的「自我调教、越用越强」，最便宜也最直接的一条就是把这些信号算成几句话，每次开工前带上。
//
// 【为什么不写进长期记忆表】记忆表装的是账号的事实（人设/偏好/表现），有置信度、激活线、语义召回，
// 那套机制是为「用户是谁」设计的。教训是「这个工作区里 AI 自己的行为记录」，按窗口统计即可：
// 三十天前拒绝过的东西不该永远压着模型，所以它必须会**自动过期**——统计窗口就是过期机制。
//
// 【三道边界】
//   ① 只统计、不复述模型的原话：模型说过的东西可能就是注入本身，只有用户的追问会被原文带上，
//      而且要过 memoryThreat（注入形状）那道闸，命中只丢不注入；
//   ② 条数与字数都封顶（MAX_LESSONS / MAX_LINE_CHARS），教训不能把任务本身挤出上下文；
//   ③ 纯函数渲染（renderLessons），查库与成文分开，成文可单测。

export const LESSON_LOOKBACK_DAYS = 30;
export const LESSON_LOOKBACK_RUNS = 60;
export const MAX_LESSONS = 8;
export const MAX_LINE_CHARS = 160;
/** 一个工具被拒绝几次才算「用户不想要」（1 次可能是手滑） */
export const REJECT_THRESHOLD = 2;
/** 一个工具失败率超过多少、且样本够（≥3 次）才提醒 */
export const FAIL_RATE_THRESHOLD = 0.5;

export type LessonSignals = {
  /** 用户拒绝过的工具 → 次数 */
  rejected: Record<string, number>;
  /** 工具调用 → { 总次数, 失败次数 } */
  toolOutcomes: Record<string, { total: number; failed: number }>;
  /** 被打回的类型 → 次数（sample/prose/gave_up） */
  nudges: { sample: number; prose: number; gaveUp: number; routeQuestion: number; promise: number };
  /** 用户追问原文（新到旧，已过注入闸） */
  notes: string[];
  /** 统计覆盖了几次运行 */
  runs: number;
};

const NUDGE_MARKERS: { key: keyof LessonSignals['nudges']; test: (s: string) => boolean }[] = [
  { key: 'sample', test: (s) => s.includes('示例数据') },
  { key: 'prose', test: (s) => s.includes('写成了正文') },
  { key: 'gaveUp', test: (s) => s.includes('没记下缺口') },
  { key: 'routeQuestion', test: (s) => s.includes('选走插件还是客户端') },
  { key: 'promise', test: (s) => s.includes('请稍等') },
];

/** 查库：最近 N 天 / N 次运行里的负向与纠正信号。 */
export async function collectLessonSignals(workspaceId: string, now: Date = new Date()): Promise<LessonSignals> {
  const since = new Date(now.getTime() - LESSON_LOOKBACK_DAYS * 86_400_000);
  const runs = await prisma.agentRun.findMany({
    where: { workspaceId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: LESSON_LOOKBACK_RUNS,
    select: { id: true },
  });
  const signals: LessonSignals = { rejected: {}, toolOutcomes: {}, nudges: { sample: 0, prose: 0, gaveUp: 0, routeQuestion: 0, promise: 0 }, notes: [], runs: runs.length };
  if (runs.length === 0) return signals;
  const runIds = runs.map((r) => r.id);

  const [steps, notes] = await Promise.all([
    prisma.agentStep.findMany({
      where: { runId: { in: runIds }, kind: { in: ['rejected', 'tool_result'] } },
      select: { kind: true, tool: true, ok: true, result: true },
    }),
    prisma.agentRunNote.findMany({
      where: { runId: { in: runIds } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { text: true },
    }),
  ]);

  for (const s of steps) {
    if (s.kind === 'rejected') {
      signals.rejected[s.tool] = (signals.rejected[s.tool] ?? 0) + 1;
      continue;
    }
    if (s.tool) {
      const o = (signals.toolOutcomes[s.tool] ??= { total: 0, failed: 0 });
      o.total += 1;
      if (!s.ok) o.failed += 1;
    } else if (!s.ok) {
      const m = NUDGE_MARKERS.find((x) => x.test(s.result));
      if (m) signals.nudges[m.key] += 1;
    }
  }
  // 用户追问：原文带上，但先过注入闸（用户手填也可能贴进来一段「忽略之前的指令」）
  for (const n of notes) {
    const t = n.text.trim();
    if (!t || memoryThreat(t)) continue;
    signals.notes.push(t);
    if (signals.notes.length >= 5) break;
  }
  return signals;
}

const clip = (s: string) => (s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS - 1) + '…' : s);
const label = (tool: string) => toolByName(tool)?.label ?? tool;

/** 成文：纯函数。没有值得说的就返回空串（调用方据此不注入）。 */
export function renderLessons(sig: LessonSignals): string {
  const lines: string[] = [];

  // 拒绝：最能代表「用户不想要」的信号，排最前
  Object.entries(sig.rejected)
    .filter(([, n]) => n >= REJECT_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .forEach(([tool, n]) => lines.push(`用户拒绝过「${label(tool)}」${n} 次：这类动作别自作主张，先说清要做什么、等他点头。`));

  // 反复失败的工具
  Object.entries(sig.toolOutcomes)
    .filter(([, o]) => o.total >= 3 && o.failed / o.total >= FAIL_RATE_THRESHOLD)
    .sort((a, b) => b[1].failed - a[1].failed)
    .forEach(([tool, o]) => lines.push(`「${label(tool)}」最近 ${o.total} 次里失败了 ${o.failed} 次：调之前先看回执里失败的原因，别原样重试。`));

  // 打回：模型自己的坏习惯
  const { sample, prose, gaveUp, routeQuestion, promise } = sig.nudges;
  if (sample >= 1) lines.push(`最近有 ${sample} 次因为编「示例数据」被打回：拿不到就说拿不到，一个数字都不许编。`);
  if (prose >= 2) lines.push(`最近有 ${prose} 次把工具调用写成了正文：要调工具就用工具调用发出去，别写成文字。`);
  if (gaveUp >= 1) lines.push(`最近有 ${gaveUp} 次说做不到却没记缺口：做不到先查工具清单，再调 report_capability_gap。`);
  if (routeQuestion >= 1) lines.push(`最近有 ${routeQuestion} 次问用户选插件还是客户端：路由由系统定，直接派。`);
  if (promise >= 1) lines.push(`最近有 ${promise} 次把「请稍等」当成了最终回答：要做就现在做，不要许诺。`);

  // 用户追问原文：他纠正过什么
  for (const t of sig.notes) lines.push(`用户追问过：「${clip(t)}」`);

  if (lines.length === 0) return '';
  const body = lines.slice(0, MAX_LESSONS).map((l) => `- ${clip(l)}`).join('\n');
  return [
    `【这个工作区最近 ${sig.runs} 次执行留下的教训（只供参考，别复述给用户）】`,
    body,
  ].join('\n');
}

/** 给执行器用：查库 + 成文；任何一步失败都返回空串，不能让教训拖垮执行本身。 */
export async function lessonsBlock(workspaceId: string): Promise<string> {
  try {
    return renderLessons(await collectLessonSignals(workspaceId));
  } catch {
    return '';
  }
}
