'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession, withSession } from '@/lib/session';
import { ingestHot, crawlCompetitors, generateRecommendations } from '@/lib/pipeline';
import { replenishEvergreen } from '@/lib/topic/sources/evergreen';
import { markInspirationUsed } from '@/lib/topic/sources/inspiration';
import { writeMemory } from '@/lib/memory/core';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';

// F4 选题引擎 · 本目录专属 server actions

// 「按设计拒绝」类错误（配额用尽 / 权限不足）：Next 15 生产会脱敏抛到 error boundary 的 message，
// 把配额自救文案冲成通用英文串。生成推荐要真烧 LLM，配额随时可能用尽，故在此转结构化返回
// （ActionButton 的 r.ok===false 分支原样红字展示）；权限不足由 requireRole 直接抛，真 bug 继续抛给 boundary。
function isDesignedRejection(e: unknown): e is QuotaExceededError | RbacError {
  return e instanceof QuotaExceededError || e instanceof RbacError;
}

// 一键「生成今日推荐」：采集热榜 → 采集竞对 → 两阶段打分生成推荐
export async function actGenerate(): Promise<{ created: number } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'topic.manage'); // 写库 + 烧 LLM，只读角色不得触发
  await ingestHot();
  await crawlCompetitors(s.workspaceId, 'manual');
  try {
    const r = await generateRecommendations(s.accountId, s.workspaceId);
    revalidatePath('/topics');
    revalidatePath('/');
    return r;
  } catch (e) {
    if (isDesignedRejection(e)) return { ok: false, error: e.message };
    throw e;
  }
}

// 补充常青储备：与「生成今日推荐」刻意分开的两个动作。
// 今日推荐是热点驱动、每天重来；常青储备是水位线驱动、补一次用很久（sources/evergreen.ts）。
// 混成一个按钮会让用户每天为同一批常青题重复付精排的钱。
export async function actReplenishEvergreen(): Promise<{ created: number; reason?: string } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  try {
    const r = await replenishEvergreen({ accountId: s.accountId, workspaceId: s.workspaceId });
    revalidatePath('/topics');
    // 补不出货时把原因原样回给用户（缺赛道词、题库已推完）。按钮只在储备低于水位线时才渲染，
    // 所以走到这里基本都是真需要用户处理的阻塞，说清楚比默默显示「已生成 0 条」有用。
    if (r.created === 0 && r.reason) return { ok: false as const, error: r.reason };
    return r;
  } catch (e) {
    if (isDesignedRejection(e)) return { ok: false, error: e.message };
    throw e;
  }
}

// 团队投票：对候选选题表态「想做 / 不想做」。一人一票，再投即改票，投同一个值即撤票。
//
// ⚠️ 票数**不进任何算法**：它是人的协调信号，不是质量信号——三个人都想做不代表它会火。
// 把团队偏好混进内容潜力的分里，等于用一个不可验证的东西污染一个可验证的东西。
export async function actVoteTopic(
  topicId: string,
  value: 'up' | 'down',
): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  // 归属校验：只能给本账号下的选题投票，不能拿到别人的 id 就投
  const topic = await prisma.topicIdea.findFirst({ where: { id: topicId, accountId: s.accountId }, select: { id: true } });
  if (!topic) return { ok: false, error: '选题不存在' };

  const existing = await prisma.topicVote.findUnique({
    where: { topicId_memberId: { topicId, memberId: s.memberId } },
    select: { id: true, value: true },
  });
  if (existing?.value === value) {
    // 再点一次同一个 = 撤票。比另做一个「取消」按钮省一次点击，且符合直觉。
    await prisma.topicVote.delete({ where: { id: existing.id } });
  } else if (existing) {
    await prisma.topicVote.update({ where: { id: existing.id }, data: { value } });
  } else {
    await prisma.topicVote.create({ data: { topicId, memberId: s.memberId, value } });
  }
  revalidatePath('/topics');
  return { ok: true };
}

// 采纳选题：state → accepted，并写入偏好记忆（正向信号）
export async function actAccept(topicId: string) {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  // 归属校验 + 改状态走同一个短事务（RLS 生效路径，见 lib/session.ts）；
  // 后面的写记忆/出队是独立的旁路写入，不进这个事务——它们失败也不该把「已采纳」回滚掉。
  const topic = await withSession(async (_s, tx) => {
    const t = await tx.topicIdea.findFirst({ where: { id: topicId, accountId: s.accountId } });
    if (!t) return null;
    await tx.topicIdea.update({ where: { id: t.id }, data: { state: 'accepted' } });
    return t;
  });
  if (!topic) return { ok: false };
  // 灵感转成选题被采纳 → 该条灵感出队。收集箱是流动暂存区，不出队的话
  // 同一条灵感会在往后每一轮推荐里反复冒出来。
  if (['inspiration', 'comment', 'rival-comment'].includes(topic.sourceType ?? '') && topic.sourceRef) {
    await markInspirationUsed(topic.sourceRef);
  }
  await writeMemory({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    type: 'preference',
    content: `用户采纳了选题「${topic.title}」，认可切入角：${topic.angle}`,
    confidence: 0.4,
  });
  revalidatePath('/topics');
  // ⚠️ 采纳一成功，这条就不在「已推荐」分区了，整张卡片会被重渲染卸载——
  // 所以「去工坊起这篇稿」这个后续入口**不能挂在卡片里**（挂了就是一闪即逝，用户点不到）。
  // 它由页面级的 AcceptedBar 承接：客户端组件的 state 不随 RSC 重渲染丢失。
  // 实测过：即使这里不 revalidate，Next 15 的 server action 一样会重渲当前路由，躲不掉。
  return { ok: true };
}

// 拒绝选题：state → rejected + 记原因，并写入偏好记忆（负向信号）
export async function actReject(topicId: string, reason: string) {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  const clean = reason.trim() || '未说明原因';
  const topic = await prisma.topicIdea.findFirst({ where: { id: topicId, accountId: s.accountId } });
  if (!topic) return { ok: false };
  await prisma.topicIdea.update({
    where: { id: topic.id },
    data: { state: 'rejected', rejectReason: clean },
  });
  await writeMemory({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    type: 'preference',
    content: `用户拒绝了选题「${topic.title}」，原因：${clean}`,
    confidence: 0.4,
  });
  revalidatePath('/topics');
  return { ok: true };
}

// ── 批量采纳 / 批量拒绝 ──────────────────────────────────────────────
// 此前只有单条动作：50 条待处理选题就得点 50 次（每次一个 server action + 一次 revalidate）。
//
// 刻意复用单条的 actAccept/actReject 而不是写一套批量 SQL：
// 采纳/拒绝不只是改一个 state，还要写偏好记忆、灵感出队——这些副作用是「越用越懂我」的养料。
// 绕过它们做 updateMany 会让批量操作**悄悄不学任何东西**，那才是最坏的结果。
// 代价是 N 次往返，但上限 50 条、且是用户显式批量操作，可以接受。
const MAX_BULK = 50;

export async function actBulkAccept(topicIds: string[]): Promise<{ ok: boolean; done: number; failed: number }> {
  const ids = [...new Set(topicIds.filter(Boolean))].slice(0, MAX_BULK);
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    // 单条失败（已被处理/不属于本账号）不该中断整批
    try {
      const r = await actAccept(id);
      if (r.ok) done++;
      else failed++;
    } catch {
      failed++;
    }
  }
  revalidatePath('/topics');
  return { ok: true, done, failed };
}

export async function actBulkReject(topicIds: string[], reason: string): Promise<{ ok: boolean; done: number; failed: number }> {
  const ids = [...new Set(topicIds.filter(Boolean))].slice(0, MAX_BULK);
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const r = await actReject(id, reason);
      if (r.ok) done++;
      else failed++;
    } catch {
      failed++;
    }
  }
  revalidatePath('/topics');
  return { ok: true, done, failed };
}

// 单条重新评分：给「AI 调用失败被 Mock 兜底」的选题一个补救入口。
//
// 为什么必须有：精排是一次性的，30s 超时这类瞬时故障会让那条选题的六维分**永久**是占位值
// （真机 2026-07-30：一次生成 6 条，两条因超时降级）。finePrompt 现在会自动重试一次，
// 但两次都赶上抖动仍会落到占位分——那时用户需要能自己再点一次，而不是把整批推荐重生成
// （重生成会连带清掉已采纳/已拒绝之外的全部推荐，代价完全不对等）。
export async function actRescoreTopic(topicId: string): Promise<{ ok: true; stillDegraded: boolean } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'topic.manage'); // 烧 LLM
  const topic = await prisma.topicIdea.findFirst({ where: { id: topicId, accountId: s.accountId } });
  if (!topic) return { ok: false, error: '选题不存在或不属于当前账号' };

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  if (!account) return { ok: false, error: '账号不存在' };

  try {
    const { finePrompt } = await import('@/lib/topic/scoring');
    const { readPersona } = await import('@/lib/persona');
    const { buildAccountContext } = await import('@/lib/account-context');
    const persona = readPersona(account.personaCard);
    const ctx = await buildAccountContext({
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      account,
      blocks: ['fingerprint', 'baseline', 'memory'],
      memoryQuery: [persona.niche, persona.identity].filter(Boolean).join(' '),
    });
    // 证据字段原样带回：它们是查库查出来的事实，不该因为重评分就丢掉
    const scored = await finePrompt(
      s.tenantId,
      {
        title: topic.title,
        heat: 0,
        sourceType: topic.sourceType,
        sourceRef: topic.sourceRef ?? undefined,
        queue: topic.queue as never,
        evidence: topic.evidence ?? undefined,
        windowHint: topic.windowHint ?? undefined,
        blueSea: topic.blueSea ?? undefined,
      },
      persona,
      ctx.parts.memory ?? '',
      [ctx.parts.fingerprint, ctx.parts.baseline].filter(Boolean).join('\n\n'),
    );
    await prisma.topicIdea.update({
      where: { id: topic.id },
      data: {
        angle: scored.angle,
        rationale: scored.rationale,
        scores: JSON.stringify(scored.scores),
        totalScore: scored.totalScore,
        mocked: scored.mocked,
        degraded: scored.llmDegraded,
      },
    });
    revalidatePath('/topics');
    revalidatePath('/');
    return { ok: true, stillDegraded: scored.mocked };
  } catch (e) {
    if (isDesignedRejection(e)) return { ok: false, error: e.message };
    throw e;
  }
}
