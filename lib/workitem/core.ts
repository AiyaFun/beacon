import { prisma } from '../db';
import { WORK_STAGES, type WorkStage, type WorkItemView, isWorkStage, canAdvance, advanceRequirement } from './stages';

export type { WorkItemView } from './stages';

// ── 内容工单：串起 选题 → 草稿 → 运行 → 发布 → 复盘，但**不复制**任何一方的正文或状态 ──
//
// 【关联而非双写】草稿正文在 DraftVersion，发布状态在 PublishTask/PublishRecord，成本在 LlmCallLog。
// 工单只记 id 与流程状态。界面上要看正文就点过去看，这里永远不会出现「工单说已发布、发布页说没发」。
//
// 【驳回必须带原因，返工不覆盖旧交付】驳回 = 阶段退回起稿 + reworkCount+1 + 事件带原因；
// 草稿版本只增不减，返工后的新版本追加在后面，旧版本仍能回看（DraftVersion.seq）。

type Row = NonNullable<Awaited<ReturnType<typeof prisma.contentWorkItem.findFirst>>>;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type EventInput = { kind: string; fromStage?: string | null; toStage?: string | null; note?: string; refKind?: string; refId?: string; memberId?: string | null };

async function addEvent(workItemId: string, e: EventInput, db: Tx | typeof prisma = prisma) {
  await db.workItemEvent.create({
    data: { workItemId, kind: e.kind, fromStage: e.fromStage ?? null, toStage: e.toStage ?? null, note: (e.note ?? '').slice(0, 1000), refKind: e.refKind ?? null, refId: e.refId ?? null, memberId: e.memberId ?? null },
  });
}

/**
 * 状态变更与事件**同一个事务**，且带期望阶段的乐观抢占（2026-09-11 审计修正）：
 *   updateMany where {id, workspaceId, status:'open', stage: expected} → count 必须为 1，否则别人已经先改了。
 * 第一版是「先读 stage、再按 id 无条件 update、再插事件」——两个人同时验收与驳回都会成功，留下矛盾事件。
 */
async function changeStage(
  workspaceId: string, id: string, expected: string,
  data: Record<string, unknown>, event: EventInput,
): Promise<{ ok: boolean; error?: string }> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.contentWorkItem.updateMany({ where: { id, workspaceId, status: 'open', stage: expected }, data });
    if (r.count !== 1) return { ok: false, error: '这单刚被别人改过（阶段已变），刷新后再操作' };
    await addEvent(id, event, tx);
    return { ok: true };
  });
}

export type CreateWorkItemInput = {
  title: string;
  accountId: string;
  agentTemplateId?: string | null;
  ownerMemberId?: string | null;
  dueAt?: Date | null;
  inputs?: string;
  acceptance?: string;
  topicId?: string | null;
  draftId?: string | null;
};

export async function createWorkItem(workspaceId: string, memberId: string, input: CreateWorkItemInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: '工单得有个标题' };
  const account = await prisma.creatorAccount.findFirst({ where: { id: input.accountId, workspaceId }, select: { id: true } });
  if (!account) return { ok: false, error: '账号不属于当前工作区' };
  if (input.draftId) {
    const d = await prisma.draft.findFirst({ where: { id: input.draftId, accountId: input.accountId }, select: { id: true } });
    if (!d) return { ok: false, error: '这篇草稿不属于这个账号' };
  }
  // 带草稿建单直接从「起稿」开始；只有选题（或什么都没有）从「候选选题」开始
  const stage: WorkStage = input.draftId ? 'drafting' : 'topic';
  const row = await prisma.contentWorkItem.create({
    data: {
      workspaceId, accountId: input.accountId, title, stage,
      agentTemplateId: input.agentTemplateId ?? null, ownerMemberId: input.ownerMemberId ?? memberId,
      dueAt: input.dueAt ?? null, inputs: (input.inputs ?? '').slice(0, 4000), acceptance: (input.acceptance ?? '').slice(0, 2000),
      topicId: input.topicId ?? null, draftId: input.draftId ?? null, createdBy: memberId,
    },
  });
  await addEvent(row.id, { kind: 'created', toStage: stage, memberId });
  return { ok: true, id: row.id };
}

async function findOwn(workspaceId: string, id: string): Promise<Row | null> {
  return prisma.contentWorkItem.findFirst({ where: { id, workspaceId } });
}

/** 推进一步。缺前置对象就说缺什么，不推。 */
export async function advanceWorkItem(workspaceId: string, id: string, memberId: string, to: string): Promise<{ ok: boolean; error?: string }> {
  const row = await findOwn(workspaceId, id);
  if (!row) return { ok: false, error: '工单不存在' };
  if (row.status !== 'open') return { ok: false, error: '这单已经关了' };
  if (!isWorkStage(to) || !isWorkStage(row.stage)) return { ok: false, error: '阶段不合法' };
  if (!canAdvance(row.stage, to)) return { ok: false, error: `不能从「${row.stage}」直接到「${to}」，一次只能推一步` };
  if (to === 'ready') return { ok: false, error: '进「待发布」要走验收，不是推进' };
  const req = advanceRequirement(to);
  if (req.field && !row[req.field]) return { ok: false, error: req.why };
  return changeStage(workspaceId, id, row.stage, { stage: to, ...(to === 'retro' ? { status: 'done' } : {}) }, { kind: 'stage', fromStage: row.stage, toStage: to, memberId });
}

/** 验收：只在审校阶段；要有草稿。验收人记在事件里。 */
export async function acceptWorkItem(workspaceId: string, id: string, memberId: string, note = ''): Promise<{ ok: boolean; error?: string }> {
  const row = await findOwn(workspaceId, id);
  if (!row) return { ok: false, error: '工单不存在' };
  if (row.stage !== 'review') return { ok: false, error: '只有「审校」阶段能验收' };
  if (!row.draftId) return { ok: false, error: '没有草稿没法验收' };
  return changeStage(workspaceId, id, 'review', { stage: 'ready', acceptedAt: new Date(), rejectReason: null }, { kind: 'accept', fromStage: 'review', toStage: 'ready', note, memberId, refKind: 'draft', refId: row.draftId });
}

/** 驳回：必须带原因；退回起稿；返工 +1；旧交付不动。 */
export async function rejectWorkItem(workspaceId: string, id: string, memberId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  const why = reason.trim();
  if (!why) return { ok: false, error: '驳回必须写原因，否则返工的人不知道改什么' };
  const row = await findOwn(workspaceId, id);
  if (!row) return { ok: false, error: '工单不存在' };
  if (row.stage !== 'review') return { ok: false, error: '只有「审校」阶段能驳回' };
  return changeStage(workspaceId, id, 'review', { stage: 'drafting', rejectReason: why.slice(0, 1000), reworkCount: { increment: 1 }, acceptedAt: null }, { kind: 'reject', fromStage: 'review', toStage: 'drafting', note: why, memberId, refKind: row.draftId ? 'draft' : undefined, refId: row.draftId ?? undefined });
}

export async function cancelWorkItem(workspaceId: string, id: string, memberId: string, note = ''): Promise<{ ok: boolean; error?: string }> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.contentWorkItem.updateMany({ where: { id, workspaceId, status: 'open' }, data: { status: 'cancelled' } });
    if (r.count === 0) return { ok: false, error: '工单不存在或已关闭' };
    await addEvent(id, { kind: 'stage', toStage: 'cancelled', note, memberId }, tx);
    return { ok: true };
  });
}

/** 把一个业务对象挂到工单上（草稿 / 选题 / 发布计划 / 发布记录）。只挂 id，不复制。 */
export async function linkWorkItem(
  workspaceId: string, id: string, memberId: string,
  ref: { kind: 'draft' | 'topic' | 'publish_plan' | 'publish_record'; refId: string },
): Promise<{ ok: boolean; error?: string }> {
  const row = await findOwn(workspaceId, id);
  if (!row) return { ok: false, error: '工单不存在' };
  const field = ref.kind === 'draft' ? 'draftId' : ref.kind === 'topic' ? 'topicId' : ref.kind === 'publish_plan' ? 'publishPlanId' : 'publishRecordId';
  if (ref.kind === 'draft') {
    const d = await prisma.draft.findFirst({ where: { id: ref.refId, accountId: row.accountId }, select: { id: true } });
    if (!d) return { ok: false, error: '这篇草稿不属于这单的账号' };
  }
  if (ref.kind === 'publish_plan') {
    const p = await prisma.publishPlan.findFirst({ where: { id: ref.refId, workspaceId }, select: { id: true } });
    if (!p) return { ok: false, error: '发布计划不属于当前工作区' };
  }
  if (ref.kind === 'topic') {
    const t = await prisma.topicIdea.findFirst({ where: { id: ref.refId, accountId: row.accountId }, select: { id: true } });
    if (!t) return { ok: false, error: '这条选题不属于这单的账号' };
  }
  if (ref.kind === 'publish_record') {
    const p = await prisma.publishRecord.findFirst({ where: { id: ref.refId, accountId: row.accountId }, select: { id: true } });
    if (!p) return { ok: false, error: '这条发布记录不属于这单的账号' };
  }
  return prisma.$transaction(async (tx) => {
    const r = await tx.contentWorkItem.updateMany({ where: { id, workspaceId, status: 'open' }, data: { [field]: ref.refId } });
    if (r.count !== 1) return { ok: false, error: '工单已关闭' };
    await addEvent(id, { kind: 'link', refKind: ref.kind, refId: ref.refId, memberId }, tx);
    return { ok: true };
  });
}

/** 记下为这单派过的运行。运行结束后 syncFromRuns 会把它做出来的草稿/发布计划挂上来。 */
export async function attachRun(workspaceId: string, id: string, runId: string, memberId: string | null): Promise<void> {
  const row = await findOwn(workspaceId, id);
  if (!row) return;
  // 关系表 + 唯一键：并发派两次也只记一条，不再读改写 JSON
  try {
    await prisma.$transaction(async (tx) => {
      await tx.workItemRun.create({ data: { workItemId: id, runId } });
      await addEvent(id, { kind: 'dispatch', refKind: 'run', refId: runId, memberId }, tx);
    });
  } catch {
    // 唯一键撞上 = 已经挂过，静默即可（事件也已经有了）
  }
}

/**
 * 从派过的运行里把产物挂上来（草稿、发布计划）。**只补空位，不覆盖**：
 * 工单已经挂了一篇草稿时，再跑出来的草稿不会顶掉它（那是返工要人来决定的事）。
 */
export async function syncFromRuns(workspaceId: string, id: string): Promise<void> {
  const row = await findOwn(workspaceId, id);
  if (!row) return;
  const ids = (await prisma.workItemRun.findMany({ where: { workItemId: id }, select: { runId: true } })).map((r) => r.runId);
  if (ids.length === 0) return;
  const artifacts = await prisma.agentArtifact.findMany({ where: { runId: { in: ids }, kind: { in: ['draft', 'publish_plan'] } }, orderBy: { createdAt: 'asc' } });
  const patch: { draftId?: string; publishPlanId?: string } = {};
  if (!row.draftId) {
    const d = artifacts.find((a) => a.kind === 'draft');
    if (d) patch.draftId = d.refId;
  }
  if (!row.publishPlanId) {
    const p = artifacts.find((a) => a.kind === 'publish_plan');
    if (p) patch.publishPlanId = p.refId;
  }
  if (Object.keys(patch).length === 0) return;
  await prisma.contentWorkItem.update({ where: { id }, data: patch });
  for (const [k, v] of Object.entries(patch)) await addEvent(id, { kind: 'link', refKind: k === 'draftId' ? 'draft' : 'publish_plan', refId: v, note: '从运行产物自动挂上' });
}

export async function listWorkItems(workspaceId: string, opts: { status?: 'open' | 'done' | 'cancelled' | 'all'; take?: number } = {}): Promise<WorkItemView[]> {
  const status = opts.status ?? 'open';
  const rows = await prisma.contentWorkItem.findMany({
    where: { workspaceId, ...(status === 'all' ? {} : { status }) },
    orderBy: [{ updatedAt: 'desc' }],
    take: opts.take ?? 100,
    include: { events: { orderBy: { createdAt: 'asc' }, take: 30 }, runs: { select: { runId: true } } },
  });
  return hydrate(workspaceId, rows);
}

export async function getWorkItem(workspaceId: string, id: string): Promise<WorkItemView | null> {
  const row = await prisma.contentWorkItem.findFirst({ where: { id, workspaceId }, include: { events: { orderBy: { createdAt: 'asc' }, take: 100 }, runs: { select: { runId: true } } } });
  if (!row) return null;
  return (await hydrate(workspaceId, [row]))[0] ?? null;
}

type RowWithEvents = Row & { events: { id: string; kind: string; fromStage: string | null; toStage: string | null; note: string; memberId: string | null; createdAt: Date }[]; runs: { runId: string }[] };

async function hydrate(workspaceId: string, rows: RowWithEvents[]): Promise<WorkItemView[]> {
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const memberIds = [...new Set([...rows.map((r) => r.ownerMemberId), ...rows.flatMap((r) => r.events.map((e) => e.memberId))].filter((v): v is string => !!v))];
  const tplIds = [...new Set(rows.map((r) => r.agentTemplateId).filter((v): v is string => !!v))];
  const draftIds = [...new Set(rows.map((r) => r.draftId).filter((v): v is string => !!v))];
  const runIds = [...new Set(rows.flatMap((r) => r.runs.map((x) => x.runId)))];
  const [accounts, members, tpls, drafts, runs] = await Promise.all([
    prisma.creatorAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true } }),
    memberIds.length ? prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } }) : [],
    tplIds.length ? prisma.workflowTemplate.findMany({ where: { id: { in: tplIds } }, select: { id: true, name: true, emoji: true } }) : [],
    draftIds.length ? prisma.draft.findMany({ where: { id: { in: draftIds } }, select: { id: true, title: true, _count: { select: { versions: true } } } }) : [],
    runIds.length ? prisma.agentRun.findMany({ where: { id: { in: runIds }, workspaceId }, select: { id: true, status: true, goal: true } }) : [],
  ]);
  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const memName = new Map(members.map((m) => [m.id, m.name]));
  const tplName = new Map(tpls.map((t) => [t.id, `${t.emoji} ${t.name}`]));
  const draftOf = new Map(drafts.map((d) => [d.id, d]));
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const now = Date.now();
  return rows.map((r) => {
    const ids = r.runs.map((x) => x.runId);
    const d = r.draftId ? draftOf.get(r.draftId) : undefined;
    return {
      id: r.id, title: r.title, stage: (isWorkStage(r.stage) ? r.stage : 'topic'), status: r.status,
      accountId: r.accountId, accountName: accName.get(r.accountId),
      ownerMemberId: r.ownerMemberId, ownerName: r.ownerMemberId ? memName.get(r.ownerMemberId) : undefined,
      agentTemplateId: r.agentTemplateId, agentName: r.agentTemplateId ? tplName.get(r.agentTemplateId) : undefined,
      dueAt: r.dueAt ? r.dueAt.toISOString() : null,
      overdue: !!r.dueAt && r.status === 'open' && r.dueAt.getTime() < now && r.stage !== 'published' && r.stage !== 'retro',
      inputs: r.inputs, acceptance: r.acceptance,
      topicId: r.topicId, draftId: r.draftId, draftTitle: d?.title, draftVersions: d?._count.versions,
      publishPlanId: r.publishPlanId, publishRecordId: r.publishRecordId,
      runIds: ids,
      runs: ids.map((id) => runOf.get(id)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ id: x.id, status: x.status, goal: x.goal, href: `/assistant?run=${x.id}` })),
      rejectReason: r.rejectReason, reworkCount: r.reworkCount,
      acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
      events: r.events.map((e) => ({ id: e.id, kind: e.kind, fromStage: e.fromStage, toStage: e.toStage, note: e.note, memberId: e.memberId, memberName: e.memberId ? memName.get(e.memberId) : undefined, at: e.createdAt.toISOString() })),
    };
  });
}

export { WORK_STAGES };
