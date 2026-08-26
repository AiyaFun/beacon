import { prisma } from '../db';
import { parseJson, toJson } from '../json';
import { channelOf, capOf } from './capability';
import { recordPublished } from './record';
import { resolvePlatformItemId } from './parse-url';
import { platformName } from '../constants';

// ── 发布计划：一篇稿子 → 每个平台一条任务 ────────────────────────────────────
//
// 【内容从哪来】一稿多平台（Draft.parentDraftId）已经在创作工坊里做过了：
// 派生稿是按平台改写过的版本。所以这里优先取派生稿，取不到才退回原稿——
// 并在任务上如实标一句「用的是原稿」，否则用户会以为小红书那条也是改写过的。

export type PlanTaskExtra = {
  tags?: string[];
  topics?: string[];
  firstComment?: string;
  /** 仅公众号：是否在写进草稿箱后一并提交群发（默认 false，群发不可撤销） */
  submitToPublish?: boolean;
  /** 内容取自原稿而非该平台的派生稿 */
  usedBaseDraft?: boolean;
};

export type BuildPlanInput = {
  workspaceId: string;
  accountId: string;
  draftId: string;
  memberId: string;
  platforms: string[];
  aigcConfirmed: boolean;
  coverAssetId?: string | null;
};

export type BuildPlanResult = { ok: true; planId: string } | { ok: false; error: string };

export async function buildPublishPlan(input: BuildPlanInput): Promise<BuildPlanResult> {
  if (!input.aigcConfirmed) return { ok: false, error: '请先确认「AI 使用声明」再发布' };
  const platforms = [...new Set(input.platforms.filter(Boolean))];
  if (platforms.length === 0) return { ok: false, error: '至少选一个平台' };

  const draft = await prisma.draft.findFirst({
    where: { id: input.draftId, accountId: input.accountId },
    include: {
      versions: { orderBy: { seq: 'desc' }, take: 1 },
      children: { include: { versions: { orderBy: { seq: 'desc' }, take: 1 } } },
    },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };

  const baseContent = draft.versions[0]?.content ?? '';
  if (!baseContent.trim()) return { ok: false, error: '这篇稿子还没有正文' };

  const plan = await prisma.publishPlan.create({
    data: {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      draftId: draft.id,
      createdBy: input.memberId,
      aigcConfirmed: true,
    },
  });

  for (const platform of platforms) {
    // 该平台的专属版本：原稿自己就是这个平台的，或者有一份派生稿
    const derived =
      draft.platform === platform
        ? { title: draft.title, content: baseContent, used: false }
        : (() => {
            const child = draft.children.find((c) => c.platform === platform);
            const content = child?.versions[0]?.content;
            return child && content
              ? { title: child.title, content, used: false }
              : { title: draft.title, content: baseContent, used: true };
          })();

    const extra: PlanTaskExtra = { usedBaseDraft: derived.used };
    await prisma.publishTask.create({
      data: {
        planId: plan.id,
        platform,
        channel: channelOf(platform),
        // 内容已经备好了，但离「发出去」还差平台那一步——状态词必须能区分这两件事
        status: 'ready',
        title: derived.title,
        content: derived.content,
        extra: toJson(extra),
        coverAssetId: input.coverAssetId ?? draft.coverAssetId ?? null,
      },
    });
  }
  return { ok: true, planId: plan.id };
}

export type TaskView = {
  id: string;
  platform: string;
  platformLabel: string;
  channel: string;
  status: string;
  title: string;
  content: string;
  extra: PlanTaskExtra;
  error: string | null;
  publishedUrl: string | null;
  requires: string;
  why: string;
  calibrated: boolean;
};

type TaskRow = {
  id: string;
  platform: string;
  channel: string;
  status: string;
  title: string;
  content: string;
  extra: string;
  error: string | null;
  publishedUrl: string | null;
};

function toTaskView(t: TaskRow): TaskView {
  const cap = capOf(t.platform);
  return {
    id: t.id,
    platform: t.platform,
    platformLabel: platformName(t.platform) || t.platform,
    channel: t.channel,
    status: t.status,
    title: t.title,
    content: t.content,
    extra: parseJson<PlanTaskExtra>(t.extra, {}),
    error: t.error,
    publishedUrl: t.publishedUrl,
    requires: cap.requires,
    why: cap.why,
    calibrated: cap.calibrated !== false,
  };
}

export async function readPlan(workspaceId: string, planId: string) {
  const plan = await prisma.publishPlan.findFirst({
    where: { id: planId, workspaceId },
    include: { tasks: { orderBy: { createdAt: 'asc' } } },
  });
  if (!plan) return null;
  return {
    id: plan.id,
    draftId: plan.draftId,
    status: plan.status,
    tasks: plan.tasks.map(toTaskView),
  };
}

export type PlanSummary = {
  id: string;
  draftId: string;
  draftTitle: string;
  status: string;
  createdAt: Date;
  tasks: TaskView[];
};

/**
 * 发布中心那一页要的清单：**当前账号**最近的发布计划，连同每条任务。
 *
 * 按 accountId 过滤而不是只按 workspaceId：一个工作区可以有好几个创作账号，
 * 混在一起列出来，用户会在「我的抖音号」页面上看到给公众号排的任务
 * （同 /data 的口径；跨账号看不见东西这个坑本项目已经踩过，页面上要写明只看当前账号）。
 */
export async function listPlans(
  scope: { workspaceId: string; accountId: string },
  opts: { status?: string; take?: number } = {},
): Promise<PlanSummary[]> {
  const plans = await prisma.publishPlan.findMany({
    where: {
      workspaceId: scope.workspaceId,
      accountId: scope.accountId,
      ...(opts.status ? { status: opts.status } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 10,
    include: { tasks: { orderBy: { createdAt: 'asc' } } },
  });
  if (plans.length === 0) return [];

  // 草稿标题单独查：PublishPlan 只存 draftId（没建关系），而列表里不写标题
  // 就成了一串 cuid，用户认不出哪条是哪篇。
  const drafts = await prisma.draft.findMany({
    where: { id: { in: [...new Set(plans.map((p) => p.draftId))] } },
    select: { id: true, title: true },
  });
  const titleOf = new Map(drafts.map((d) => [d.id, d.title]));

  return plans.map((p) => ({
    id: p.id,
    draftId: p.draftId,
    // 草稿被删了就如实说，不编一个标题
    draftTitle: titleOf.get(p.draftId) ?? '（草稿已删除）',
    status: p.status,
    createdAt: p.createdAt,
    tasks: p.tasks.map(toTaskView),
  }));
}

// ── 回执：插件/用户告诉我们这条任务走到哪一步了 ──────────────────────────────
//
// 【最要紧的一条】filled ≠ published。插件只能把内容填进创作后台，
// 点不点发布是用户的事。把 filled 当 published 记，用户会以为稿子已经出去了。

export type ReceiptStatus = 'filled' | 'published' | 'failed' | 'skipped';

export type ReceiptInput = {
  workspaceId: string;
  taskId: string;
  status: ReceiptStatus;
  url?: string | null;
  error?: string | null;
};

export type ReceiptResult = { ok: true; warnings: string[] } | { ok: false; error: string };

/**
 * 全部任务都走到终态就把计划关掉。
 *
 * 终态含跳过与失败：用户可能就是不想发那个平台了，或者那条通道今天走不通——
 * 两种都不该让计划一直挂在「进行中」。三条终态分支都要调它（少调一条就是一个
 * 永远关不掉的计划，而这种错不报任何异常）。
 */
async function closePlanIfSettled(planId: string): Promise<void> {
  const rest = await prisma.publishTask.count({
    where: { planId, status: { notIn: ['published', 'skipped', 'failed'] } },
  });
  if (rest === 0) {
    await prisma.publishPlan.update({ where: { id: planId }, data: { status: 'done' } });
  }
}

export async function applyTaskReceipt(input: ReceiptInput): Promise<ReceiptResult> {
  const task = await prisma.publishTask.findFirst({
    where: { id: input.taskId, plan: { workspaceId: input.workspaceId } },
    include: { plan: true },
  });
  if (!task) return { ok: false, error: '发布任务不存在' };

  const now = new Date();
  if (input.status === 'filled') {
    await prisma.publishTask.update({
      where: { id: task.id },
      data: { status: 'filled', filledAt: now, error: null },
    });
    return { ok: true, warnings: [] };
  }
  if (input.status === 'failed' || input.status === 'skipped') {
    await prisma.publishTask.update({
      where: { id: task.id },
      data: { status: input.status, error: (input.error ?? '').slice(0, 300) || null },
    });
    // 跳过/失败也是终态。少了这一句，「三个平台里跳过了最后一个」的计划会**永远**停在
    // 进行中——发布中心那一页于是长期挂着一条其实没有任何待办的计划。
    await closePlanIfSettled(task.planId);
    return { ok: true, warnings: [] };
  }

  // published：这一步才真正落进发布记录
  const url = (input.url ?? '').trim();

  // 重复投递的回执要当场吃掉。插件会重试（断网/用户又点了一次「我发完了」），
  // 而 published 这条分支带副作用：写发布记录 + 推进草稿/选题状态 + 重写发布时刻。
  // 发布时刻被改成重试那一刻，会直接污染发布时机分析（lib/insight/timing.ts）。
  // 例外：先报了没链接、后来才拿到链接——那条要放行，它带来的是新信息。
  if (task.status === 'published' && (!url || url === task.publishedUrl)) {
    return { ok: true, warnings: [] };
  }
  const parsed = url ? resolvePlatformItemId(url, task.platform) : { platformItemId: null, warning: null };
  const draft = await prisma.draft.findUnique({
    where: { id: task.plan.draftId },
    include: { topic: true },
  });
  if (!draft) return { ok: false, error: '这条任务对应的草稿已经不在了' };

  const { warnings } = await recordPublished({
    workspaceId: input.workspaceId,
    accountId: task.plan.accountId,
    draft: {
      id: draft.id,
      title: task.title,
      // 归属到**这条任务的平台**，不是草稿的平台：一稿多平台时两者不同，
      // 记错平台会让数据回流去错误的平台找作品，回流永远失败且看不出原因。
      platform: task.platform,
      topicId: draft.topicId,
      topicAngle: draft.topic?.angle ?? null,
      topicSourceType: draft.topic?.sourceType ?? null,
    },
    content: task.content,
    url: url || null,
    platformItemId: parsed.platformItemId,
  });

  await prisma.publishTask.update({
    where: { id: task.id },
    data: {
      status: 'published',
      publishedAt: now,
      publishedUrl: url || null,
      platformItemId: parsed.platformItemId,
      error: null,
    },
  });

  await closePlanIfSettled(task.planId);

  const allWarnings = [...warnings];
  if (parsed.warning) allWarnings.push(parsed.warning);
  return { ok: true, warnings: allWarnings };
}
