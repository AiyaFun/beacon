'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { toJson, parseJson } from '@/lib/json';
import { buildPublishPlan, readPlan, applyTaskReceipt, type PlanTaskExtra } from '@/lib/publish/plan';
import { publishToWechat } from '@/lib/publish/wechat-mp';
import { capOf } from '@/lib/publish/capability';

// 一键发布的 server action 层。权限一律 content.publish（与登记发布同一道闸，viewer 不得触发）。

export async function actCreatePublishPlan(input: {
  draftId: string;
  platforms: string[];
  aigcConfirmed: boolean;
}): Promise<{ ok: boolean; planId?: string; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.publish');
  const r = await buildPublishPlan({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    draftId: input.draftId,
    memberId: s.memberId,
    platforms: input.platforms,
    aigcConfirmed: input.aigcConfirmed,
  });
  if (!r.ok) return r;
  revalidatePath('/studio');
  return { ok: true, planId: r.planId };
}

export async function actReadPublishPlan(planId: string) {
  const s = await getSession();
  const plan = await readPlan(s.workspaceId, planId);
  if (!plan) return { ok: false as const, error: '发布计划不存在' };
  return { ok: true as const, plan };
}

/** 最近一次发布计划（草稿面板重新打开时接着看，而不是又建一个新的）。 */
export async function actLatestPlanForDraft(draftId: string) {
  const s = await getSession();
  const row = await prisma.publishPlan.findFirst({
    where: { workspaceId: s.workspaceId, draftId, status: 'open' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!row) return { ok: true as const, plan: null };
  const plan = await readPlan(s.workspaceId, row.id);
  return { ok: true as const, plan };
}

/**
 * 走官方接口的任务（目前只有公众号）。
 *
 * submitToPublish 默认 false —— 群发不可撤销且订阅号每天只有一次机会，
 * 必须是用户显式勾的，不能由代码替他决定。
 */
export async function actRunApiPublish(
  taskId: string,
  opts: { submitToPublish?: boolean } = {},
): Promise<{ ok: boolean; error?: string; note?: string }> {
  const s = await getSession();
  requireRole(s, 'content.publish');

  const task = await prisma.publishTask.findFirst({
    where: { id: taskId, plan: { workspaceId: s.workspaceId } },
    include: { plan: true },
  });
  if (!task) return { ok: false, error: '发布任务不存在' };
  if (capOf(task.platform).channel !== 'api') return { ok: false, error: '这个平台没有官方接口直发通道' };
  if (task.platform !== 'wechat') return { ok: false, error: '暂时只有公众号支持接口直发' };

  const account = await prisma.creatorAccount.findUnique({ where: { id: task.plan.accountId } });
  const r = await publishToWechat({
    workspaceId: s.workspaceId,
    accountId: task.plan.accountId,
    title: task.title,
    content: task.content,
    coverAssetId: task.coverAssetId,
    author: account?.name ?? '',
    submitToPublish: opts.submitToPublish === true,
  });

  if (!r.ok) {
    await prisma.publishTask.update({ where: { id: task.id }, data: { status: 'failed', error: r.error.slice(0, 300) } });
    revalidatePath('/studio');
    return { ok: false, error: r.error };
  }

  const extra = parseJson<PlanTaskExtra>(task.extra, {});
  await prisma.publishTask.update({
    where: { id: task.id },
    data: {
      // 只提交到草稿箱 → submitted（**不是** published：还没群发出去）；
      // 勾了一并群发 → 仍记 submitted，等用户回填文章链接再转 published——
      // 群发是异步的（微信排队+审核），此刻宣布「已发布」是在替平台打包票。
      status: 'submitted',
      externalRef: r.mediaId,
      error: null,
      extra: toJson({ ...extra, submitToPublish: opts.submitToPublish === true }),
    },
  });
  revalidatePath('/studio');
  return {
    ok: true,
    note: opts.submitToPublish
      ? '已写进公众号草稿箱并提交群发。微信侧要排队/审核，发出后把文章链接贴回来即可开始回流数据。'
      : '已写进公众号草稿箱。到公众号后台确认排版后点发布，再把文章链接贴回来。',
  };
}

/** 人工标记一条任务（复制走了手动发的、或插件没覆盖的平台）。 */
export async function actMarkPublishTask(
  taskId: string,
  status: 'filled' | 'published' | 'failed' | 'skipped',
  url?: string,
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const s = await getSession();
  requireRole(s, 'content.publish');
  const r = await applyTaskReceipt({ workspaceId: s.workspaceId, taskId, status, url: url ?? null });
  if (!r.ok) return r;
  revalidatePath('/studio');
  revalidatePath('/data');
  return { ok: true, warning: r.warnings.length ? r.warnings.join(' ') : undefined };
}
