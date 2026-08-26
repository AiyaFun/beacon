'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { toJson, parseJson } from '@/lib/json';
import { buildPublishPlan, readPlan, applyTaskReceipt, type PlanTaskExtra } from '@/lib/publish/plan';
import { publishToWechat } from '@/lib/publish/wechat-mp';
import { publishToWeibo } from '@/lib/publish/weibo';
import { capOf } from '@/lib/publish/capability';

// 一键发布的 server action 层。权限一律 content.publish（与登记发布同一道闸，viewer 不得触发）。
//
// 【为什么从 studio/ 挪到这里】发布有了自己的一页（/publish）之后，同一批动作被两处调用：
// 创作工坊里那个「写完就发」的抽屉，和发布中心这一页。动作留在 studio/ 下会让人以为
// 它属于工坊，于是在发布中心那边再抄一份——两份 revalidate、两份权限判断、两份状态词，
// 正是本项目反复栽跟头的形状。所以：动作在 /publish 收口，工坊那边 import 过去用。

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
  revalidatePath('/publish');
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

  // 微博：走 OAuth token 发一条博文（≤140 字 + 单图 + 必带回链，三条都是微博的规则）。
  // 与公众号那条路的**根本区别**：公众号写进的是草稿箱（可撤可改），微博这一发就是公开发布，
  // 所以它直接落 published，而不是像公众号那样停在 submitted 等用户回填链接。
  if (task.platform === 'weibo') {
    const wb = await publishToWeibo({
      workspaceId: s.workspaceId,
      accountId: task.plan.accountId,
      content: task.content,
      coverAssetId: task.coverAssetId,
    });
    if (!wb.ok) {
      await prisma.publishTask.update({
        where: { id: task.id },
        data: { status: 'failed', error: wb.error.slice(0, 300) },
      });
      revalidatePath('/studio');
      revalidatePath('/publish');
      return { ok: false, error: wb.error };
    }
    // 发出去了就是发出去了：走与插件回执同一段落库逻辑，不另写一份
    const r2 = await applyTaskReceipt({
      workspaceId: s.workspaceId,
      taskId: task.id,
      status: 'published',
      url: wb.url,
    });
    revalidatePath('/studio');
    revalidatePath('/publish');
    revalidatePath('/data');
    return {
      ok: true,
      note: `已发到微博：${wb.url}${r2.ok && r2.warnings.length ? `（${r2.warnings.join(' ')}）` : ''}`,
    };
  }

  if (task.platform !== 'wechat') return { ok: false, error: '这个平台的接口直发还没接' };

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
  revalidatePath('/publish');
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
  revalidatePath('/publish');
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
  revalidatePath('/publish');
  revalidatePath('/data');
  return { ok: true, warning: r.warnings.length ? r.warnings.join(' ') : undefined };
}
