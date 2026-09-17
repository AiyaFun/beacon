// AI 操作用户日常浏览器：会话管理（2026-09-17）。
//
// 【这条通道长什么样】
//   AI 工具 ──写 pendingStep──> 库 <──轮询取走── 烽火台页面 ──postMessage──> 插件 ──> 目标页
//   AI 工具 <──轮询取走── 库 <──写 stepResult── 烽火台页面 <──postMessage── 插件 <── 结果
//
// **页面在中间当中继，这不是绕远路，是这条路全部安全性的来源**：动作只在用户打开着烽火台页面
// 时才流得动。他关掉页面 → 不再轮询 → lastSeenAt 不再刷新 → 会话作废。
// 「用户在不在场」因此是一个可验证的事实，不是一句承诺。
//
// 【为什么不复用 BrowserTask】那张表是「排队等浏览器下次醒来」：可重试、有租约、48 小时有效、
// 用户不在也会跑。这条路每一条语义都相反。混在一起的后果是某天有人给 op 加了重试，
// 于是「只在你看着时执行」这句话就悄悄不成立了。
import { prisma } from '../db';
import { parseJson } from '../json';
import { MAX_OP_STEPS, OP_SESSION_IDLE_SECONDS, type OpStep } from './actions';

export type OpLogEntry = {
  at: string;
  /** 动作名 + 给人看的一句话 */
  what: string;
  ok: boolean;
  note?: string;
};

export type OpSessionView = {
  id: string;
  origin: string;
  status: string;
  steps: number;
  log: OpLogEntry[];
  /** 停在这里等用户确认的那一步（不可逆动作） */
  awaitConfirm?: { label: string; why?: string } | null;
};

/** 会话还活着吗：状态是 active，且页面在 OP_SESSION_IDLE_SECONDS 内轮询过。 */
export function isAlive(s: { status: string; lastSeenAt: Date }, now = Date.now()): boolean {
  return s.status === 'active' && now - s.lastSeenAt.getTime() < OP_SESSION_IDLE_SECONDS * 1000;
}

function idleCutoff(now = Date.now()): Date {
  return new Date(now - OP_SESSION_IDLE_SECONDS * 1000);
}

/**
 * 开一条会话。**同一个人只允许有一条活着的**——新的把旧的顶掉。
 * 理由与 BrowserTask 的「重复任务以新为准」同一条：他又发起一次，多半是上一条卡住了。
 */
export async function startOpSession(input: {
  workspaceId: string;
  memberId: string;
  origin: string;
}): Promise<{ id: string }> {
  await prisma.browserOpSession.updateMany({
    where: { workspaceId: input.workspaceId, createdBy: input.memberId, status: 'active' },
    data: { status: 'superseded' },
  });
  const s = await prisma.browserOpSession.create({
    data: {
      workspaceId: input.workspaceId,
      createdBy: input.memberId,
      origin: input.origin,
      log: JSON.stringify([{ at: new Date().toISOString(), what: `开始操作 ${input.origin}`, ok: true }] satisfies OpLogEntry[]),
    },
    select: { id: true },
  });
  return s;
}

/** 这个人此刻活着的那条会话（页面轮询与 AI 工具都从这里认）。 */
export async function activeOpSession(workspaceId: string, memberId: string) {
  return prisma.browserOpSession.findFirst({
    where: { workspaceId, createdBy: memberId, status: 'active', lastSeenAt: { gt: idleCutoff() } },
    orderBy: { createdAt: 'desc' },
  });
}

async function appendLog(id: string, entry: OpLogEntry): Promise<void> {
  const cur = await prisma.browserOpSession.findUnique({ where: { id }, select: { log: true } });
  const log = parseJson<OpLogEntry[]>(cur?.log ?? '[]', []);
  log.push(entry);
  // 只留最近 60 条：日志是给人看「刚才它干了什么」，不是审计归档
  await prisma.browserOpSession.update({ where: { id }, data: { log: JSON.stringify(log.slice(-60)) } });
}

/**
 * AI 工具下发一步。返回 false = 会话不能再用了（人走了 / 步数用尽 / 被顶掉）。
 * **不排队**：同一时刻只有一步待执行，上一步没被取走就不下发新的。
 */
export async function pushStep(id: string, step: OpStep): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = await prisma.browserOpSession.findUnique({ where: { id } });
  if (!s) return { ok: false, error: '这条操作会话不存在' };
  if (!isAlive(s)) {
    return {
      ok: false,
      error: s.status !== 'active'
        ? `这条操作会话已经${s.status === 'aborted' ? '被你中止' : '结束'}了`
        : '烽火台页面已经关掉或切走了，操作通道断了——这条路只在你看着的时候有效。回到烽火台页面再让我继续。',
    };
  }
  if (s.steps >= MAX_OP_STEPS) {
    return { ok: false, error: `这次操作已经走了 ${MAX_OP_STEPS} 步还没完成，先停下来。把要做的事说得更具体一点，或者你自己接手。` };
  }
  if (s.pendingStep) return { ok: false, error: '上一步还没执行完' };
  await prisma.browserOpSession.update({
    where: { id },
    data: { pendingStep: JSON.stringify(step), stepResult: null, steps: { increment: 1 } },
  });
  return { ok: true };
}

/** 页面轮询：取走待执行的一步（取走即清空，同一步绝不发两次），并刷新「人还在」。 */
export async function takeStep(id: string): Promise<OpStep | null> {
  const s = await prisma.browserOpSession.findUnique({ where: { id }, select: { pendingStep: true } });
  const raw = s?.pendingStep;
  await prisma.browserOpSession.update({ where: { id }, data: { lastSeenAt: new Date(), ...(raw ? { pendingStep: null } : {}) } });
  return raw ? parseJson<OpStep>(raw, null as unknown as OpStep) : null;
}

/** 页面交回这一步的结果。needConfirm 的结果会同时把会话停在等确认状态。 */
export async function putResult(
  id: string,
  result: Record<string, unknown>,
  logEntry: OpLogEntry,
): Promise<void> {
  const awaiting = result && result.needConfirm === true
    ? JSON.stringify({ label: String(result.label ?? ''), why: String(result.why ?? '') })
    : null;
  await prisma.browserOpSession.update({
    where: { id },
    data: { stepResult: JSON.stringify(result), lastSeenAt: new Date(), awaitConfirm: awaiting },
  });
  await appendLog(id, logEntry);
}

/** AI 工具取走结果。没有就返回 null（调用方继续轮询）。 */
export async function takeResult(id: string): Promise<Record<string, unknown> | null> {
  const s = await prisma.browserOpSession.findUnique({ where: { id }, select: { stepResult: true } });
  if (!s?.stepResult) return null;
  await prisma.browserOpSession.update({ where: { id }, data: { stepResult: null } });
  return parseJson<Record<string, unknown>>(s.stepResult, {});
}

/** 结束会话。aborted = 用户喊停或页面关了；done = 正常做完。 */
export async function endOpSession(id: string, status: 'done' | 'aborted', note?: string): Promise<void> {
  await prisma.browserOpSession.update({
    where: { id },
    data: { status, pendingStep: null, awaitConfirm: null },
  });
  await appendLog(id, { at: new Date().toISOString(), what: status === 'done' ? '操作完成' : '操作已中止', ok: status === 'done', ...(note ? { note } : {}) });
}

export function toView(s: {
  id: string; origin: string; status: string; steps: number; log: string; awaitConfirm: string | null;
}): OpSessionView {
  return {
    id: s.id,
    origin: s.origin,
    status: s.status,
    steps: s.steps,
    log: parseJson<OpLogEntry[]>(s.log, []),
    awaitConfirm: s.awaitConfirm ? parseJson<{ label: string; why?: string }>(s.awaitConfirm, { label: '' }) : null,
  };
}
