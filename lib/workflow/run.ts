import { prisma } from '../db';
import { toJson, parseJson } from '../json';
import { llmComplete } from '../llm/gateway';
import { generateRecommendations } from '../pipeline';
import { resolveDraftTarget, loadDraftContext, buildDraftMessages, persistDraftVersion } from '../studio/draft-core';
import { runSkill } from '../skills';
import { runCover } from '../cover/run';
import { planScenes, runIllustration } from '../illustration/run';
import { buildPublishPlan } from '../publish/plan';
import { parseSteps, stepLabel, type WorkflowStep } from './steps';
import { createLogger } from '../logger';

const log = createLogger({ module: 'workflow' });

// ── 工作流执行器：把一串已有能力按模板顺序跑一遍 ──────────────────────────────
//
// 【三条规矩】
// 1. **一步失败就停**，并如实记下停在哪一步。继续往下跑只会在错误的基础上继续花钱
//    （比如初稿没生成成功，后面的封面/配图全是围着一篇空稿转）。
// 2. **发布那步只建计划，绝不真的发**。真发永远要用户在发布面板里自己确认——
//    模板是可以被分享的，一个分享来的模板不该有能力把你的稿子发出去。
// 3. 每一步都走各自已有的闸（配额、平台预算、合规红线、RBAC 由调用方保证），
//    这里不新开任何绕过通道。

export type StepLog = { kind: string; label: string; ok: boolean; message: string; at: string };

export type WorkflowContext = {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberId: string;
  /** 从哪篇草稿接着做；没有就由 draft 步新建 */
  draftId?: string | null;
};

export type WorkflowRunView = {
  runId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  draftId: string | null;
  stepIndex: number;
  logs: StepLog[];
  error?: string;
};

async function readDraftContent(draftId: string): Promise<{ title: string; platform: string; content: string } | null> {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
  });
  if (!draft) return null;
  return { title: draft.title, platform: draft.platform, content: draft.versions[0]?.content ?? '' };
}

/** 跑一步。返回这一步的结果 + 可能更新的 draftId。 */
async function runStep(
  ctx: WorkflowContext,
  step: WorkflowStep,
  state: { draftId: string | null },
): Promise<{ ok: boolean; message: string }> {
  switch (step.kind) {
    case 'topic': {
      const r = await generateRecommendations(ctx.accountId, ctx.workspaceId, step.count);
      return { ok: r.created > 0, message: r.created > 0 ? `生成 ${r.created} 条选题` : '没有生成出新选题（可能候选池是空的）' };
    }

    case 'draft': {
      // 与创作工坊「AI 写初稿」同一条链路（resolveDraftTarget → 上下文 → 生成 → 存版本），
      // 不另写一份提示词——两份提示词早晚会漂成两种文风。
      const target = await resolveDraftTarget({
        accountId: ctx.accountId,
        draftId: state.draftId ?? null,
        topicId: step.topicId,
      });
      if (!target.ok) return { ok: false, message: target.error };
      state.draftId = target.target.draftId;

      const dctx = await loadDraftContext({ workspaceId: ctx.workspaceId, accountId: ctx.accountId, target: target.target });
      const { messages, temperature } = buildDraftMessages(target.target, dctx);
      const res = await llmComplete(ctx.tenantId, 'generation', messages, { temperature });
      if (res.mocked) {
        // Mock 的初稿是示例文案。写进草稿会让后面每一步都围着假内容转，且用户很可能直接拿去发。
        return { ok: false, message: '还没接入真实模型（这一步只会产出示例内容），已停在这里' };
      }
      await persistDraftVersion({
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        draftId: target.target.draftId,
        topicTitle: target.target.topicTitle,
        content: res.text,
        label: '工作流模板生成的初稿',
      });
      return { ok: true, message: `初稿写好了（${res.text.length} 字）` };
    }

    case 'skill': {
      if (!state.draftId) return { ok: false, message: '还没有草稿，技能没有可作用的正文' };
      const draft = await readDraftContent(state.draftId);
      if (!draft?.content.trim()) return { ok: false, message: '草稿还没有正文' };

      const skill = await prisma.contentSkill.findFirst({
        where: { slug: step.slug, enabled: true, OR: [{ isBuiltin: true }, { tenantId: ctx.tenantId }] },
      });
      if (!skill) return { ok: false, message: `找不到技能「${step.slug}」（可能没安装或已下架）` };

      const r = await runSkill({ tenantId: ctx.tenantId, skillId: skill.id, content: draft.content, title: draft.title });
      if (!r.ok) return { ok: false, message: r.error };
      if (r.mocked) return { ok: false, message: `技能「${skill.name}」这次只拿到示例内容（未接真实模型），没有写进草稿` };

      await persistDraftVersion({
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        draftId: state.draftId,
        topicTitle: draft.title,
        content: r.output,
        label: `工作流：${skill.name}`,
      });
      return { ok: true, message: `${skill.name} 跑完，已存成新版本` };
    }

    case 'cover': {
      if (!state.draftId) return { ok: false, message: '还没有草稿，没法出封面' };
      const draft = await readDraftContent(state.draftId);
      if (!draft) return { ok: false, message: '草稿不见了' };
      const r = await runCover({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        draftId: state.draftId,
        platform: draft.platform,
        specKey: step.specKey,
        styleKey: step.styleKey,
        meta: { mainTitle: draft.title },
        fallbackTitle: draft.title,
      });
      if (!r.ok) return { ok: false, message: r.error };
      return { ok: true, message: `出了 ${r.images.length} 张封面` };
    }

    case 'illustration': {
      if (!state.draftId) return { ok: false, message: '还没有草稿，没法出配图' };
      const draft = await readDraftContent(state.draftId);
      if (!draft?.content.trim()) return { ok: false, message: '草稿还没有正文，拆不出画面' };
      const scenes = await planScenes(ctx.tenantId, {
        title: draft.title,
        content: draft.content,
        count: step.count,
        platform: draft.platform,
      });
      if (scenes.length === 0) return { ok: false, message: '没拆出画面清单（未接真实模型时会这样）' };
      const r = await runIllustration({
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        draftId: state.draftId,
        platform: draft.platform,
        styleKey: step.styleKey,
        scenes,
      });
      if (!r.ok) return { ok: false, message: r.error };
      return { ok: true, message: `出了 ${r.images.length} 张配图` };
    }

    case 'publish': {
      if (!state.draftId) return { ok: false, message: '还没有草稿，没法建发布计划' };
      // aigcConfirmed 传 true 是**这一步的语义**：建计划不等于发布，
      // 真正的对外发布在发布面板里另有一次确认（且公众号群发还要再勾一次）。
      const r = await buildPublishPlan({
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        draftId: state.draftId,
        memberId: ctx.memberId,
        platforms: step.platforms,
        aigcConfirmed: true,
      });
      if (!r.ok) return { ok: false, message: r.error };
      return { ok: true, message: `发布计划已建好（${step.platforms.length} 个平台），去创作工坊点「一键发布」逐个确认` };
    }
  }
}

export async function runWorkflow(ctx: WorkflowContext, templateId: string): Promise<WorkflowRunView> {
  const template = await prisma.workflowTemplate.findFirst({
    where: { id: templateId, enabled: true, OR: [{ isBuiltin: true }, { tenantId: ctx.tenantId }] },
  });
  if (!template) throw new Error('模板不存在或未启用');
  const steps = parseSteps(template.steps);
  if (steps.length === 0) throw new Error('这个模板没有可执行的步骤');

  const run = await prisma.workflowRun.create({
    data: {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      templateId: template.id,
      draftId: ctx.draftId ?? null,
      status: 'running',
    },
  });

  const state = { draftId: ctx.draftId ?? null };
  const logs: StepLog[] = [];
  let failed: string | null = null;

  for (const [i, step] of steps.entries()) {
    let result: { ok: boolean; message: string };
    try {
      result = await runStep(ctx, step, state);
    } catch (err) {
      // 配额/预算这类「按设计拒绝」的错误也走这里：它们的 message 本身就是给用户的指引，
      // 原样记进日志比吞掉换一句「执行失败」有用得多。
      log.warn('工作流步骤抛错', { kind: step.kind, error: (err as Error).message });
      result = { ok: false, message: (err as Error).message.slice(0, 300) };
    }
    logs.push({
      kind: step.kind,
      label: stepLabel(step),
      ok: result.ok,
      message: result.message,
      at: new Date().toISOString(),
    });
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { stepIndex: i + 1, log: toJson(logs), draftId: state.draftId },
    });
    if (!result.ok) {
      failed = `第 ${i + 1} 步「${stepLabel(step)}」没过：${result.message}`;
      break; // 一步失败就停：在错的基础上继续跑只会继续花钱
    }
  }

  const status = failed ? 'failed' : 'done';
  await prisma.workflowRun.update({
    where: { id: run.id },
    data: { status, error: failed, log: toJson(logs), draftId: state.draftId },
  });

  return {
    runId: run.id,
    status,
    draftId: state.draftId,
    stepIndex: logs.length,
    logs,
    error: failed ?? undefined,
  };
}

export async function readWorkflowRun(workspaceId: string, runId: string): Promise<WorkflowRunView | null> {
  const run = await prisma.workflowRun.findFirst({ where: { id: runId, workspaceId } });
  if (!run) return null;
  return {
    runId: run.id,
    status: run.status as WorkflowRunView['status'],
    draftId: run.draftId,
    stepIndex: run.stepIndex,
    logs: parseJson<StepLog[]>(run.log, []),
    error: run.error ?? undefined,
  };
}
