import { prisma } from '../db';
import { QuotaExceededError } from '../quota';
import { toJson, parseJson } from '../json';
import { llmComplete } from '../llm/gateway';
import { generateRecommendations } from '../pipeline';
import { resolveDraftTarget, loadDraftContext, buildDraftMessages, persistDraftVersion } from '../studio/draft-core';
import { runSkill } from '../skills';
import { runCover } from '../cover/run';
import { planScenes, runIllustration } from '../illustration/run';
import { buildPublishPlan } from '../publish/plan';
import { buildBrief } from './brief';
import { pushEvent, beaconUrl } from '../bot';
import { notify } from '../notify';
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

/**
 * `code`：按设计拒绝的那类失败要能被**调用方分辨**，不能只留一句人话。
 * 定时智能体靠它区分「这个月配额用完了」和「这条模板坏了」——前者下个月自己就好，
 * 后者才该累加失败次数直到自动停用。只靠 message 做字符串匹配迟早会随文案漂移。
 */
export type StepLog = {
  kind: string;
  label: string;
  ok: boolean;
  message: string;
  at: string;
  code?: 'QUOTA_EXCEEDED';
};

/** 谁把这次运行发起的。运行中心据此告诉用户「这条要不要管、去哪儿管」。 */
export type WorkflowTrigger = 'manual' | 'schedule' | 'agent';

export type WorkflowContext = {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberId: string;
  /** 从哪篇草稿接着做；没有就由 draft 步新建 */
  draftId?: string | null;
  /**
   * 触发来源，缺省 manual。
   *
   * **不做成必填**是刻意的：页面手点是最常见也最默认的那条路，让它保持零心智；
   * 而定时与 AI 那两条路径各只有一个调用点，写死一个值不会漏（用例钉着）。
   */
  trigger?: WorkflowTrigger;
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
/**
 * 步骤之间共享的东西。
 *
 * draftId 是原本就有的那一个：draft 步写它，后面 skill/cover/publish 读它。
 * briefs 是 analyze 步的产出——notify 步要拿它去推。刻意做成**内存里传**而不是落库：
 * 一份没人看的简报不值得占一行，而 notify 紧跟在 analyze 后面。
 */
type StepState = {
  draftId: string | null;
  briefs: { title: string; text: string }[];
};

async function runStep(
  ctx: WorkflowContext,
  step: WorkflowStep,
  state: StepState,
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
        // 模板写了给哪个平台写，就按哪个平台写。
        // 【真机撞到的】漏传这一个字段，三条内置智能体全部走人设默认（人设没填就是抖音）：
        // 「小红书日更三件套」第一步的提示词是「为「抖音」平台创作一篇初稿文案」，
        // 出来的稿子标着抖音、按抖音调性写，第二步才被小红书排版技能接手。
        // 字段一直在 WorkflowStep 里、UI 也渲染了，只是从来没接上。
        platform: step.platform,
      });
      if (!target.ok) {
        // 【为什么在这里补一句而不是改 resolveDraftTarget】那个函数创作工坊也在用，
        // 那边用户就在选题页旁边，一句「去选题中心采纳一个」足够。
        // 而在**工作流里**撞到它的用户刚点完「跑一遍」，他要知道的是
        // 「这条模板跑不了，能换哪条」——不说的话他只会以为这个智能体坏了。
        const hint = target.error.includes('没有可用选题')
          ? `${target.error}。或者改用「选题 → 图文组图」，那条会自己先跑一轮选题。`
          : target.error;
        return { ok: false, message: hint };
      }
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

    case 'analyze': {
      // 只读库里已有的数据出一份人话简报。**刻意不去采新数据**——
      // 要新数据是采集那条链的事，混进来会让「看一眼」变成几分钟的采集
      const r = await buildBrief(
        { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, accountId: ctx.accountId },
        step.target,
      );
      if (!r.ok) return { ok: false, message: r.error };
      if (r.mocked) {
        // 没接真模型时 llmComplete 会兜底编一段像模像样的文字。
        // 把它当简报存下来再推到群里，就是拿示例内容冒充结论
        return { ok: false, message: `${r.title}：没有接入真实模型，这次不出简报（示例内容不能当结论）` };
      }
      // 存进资讯库，下一步 notify 才有东西可推；也让用户事后能翻回来看
      state.briefs.push({ title: r.title, text: r.text });
      return { ok: true, message: `${r.title}：简报已生成（${r.text.length} 字）` };
    }

    case 'notify': {
      const briefs = state.briefs;
      const draftTitle = state.draftId
        ? (await prisma.draft.findUnique({ where: { id: state.draftId }, select: { title: true } }))?.title
        : null;
      if (briefs.length === 0 && !draftTitle) {
        return { ok: false, message: '这一步没有可推的内容（前面既没出简报也没出稿子）' };
      }

      const title = step.title || briefs[0]?.title || '智能体跑完了';
      const lines = briefs.length > 0
        ? briefs.flatMap((b) => [b.title, b.text])
        : [`《${draftTitle}》已经写好了`];

      const r = await pushEvent(ctx.workspaceId, 'agent_done', {
        kind: 'card',
        title,
        lines,
        link: { text: '去看看', url: beaconUrl(state.draftId ? '/studio' : '/library') },
      });

      // 站内通知一定要发：机器人可能一个都没配，那样用户什么都收不到
      await notify({
        workspaceId: ctx.workspaceId,
        accountId: ctx.accountId,
        kind: 'system',
        title,
        body: lines.join(' / ').slice(0, 400),
        link: state.draftId ? '/studio' : '/library',
      });

      // 【sent:0 有三种完全不同的含义】没配机器人 / 配了但没勾「智能体跑完」这个事件 /
      // 推了但发送失败。只回一句「已推送」是这条链上最容易长出来的静默错——
      // 用户以为群里收到了，其实一条都没发
      if (r.sent === 0) {
        return {
          ok: true,
          message: r.failed > 0
            ? `群机器人发送失败 ${r.failed} 次，已改用站内通知（去「推送与机器人」页看看配置）`
            : '没有群机器人收到（没配，或配了但没勾「智能体跑完」这个推送事件），已改用站内通知',
        };
      }
      return { ok: true, message: `已推给 ${r.sent} 个群机器人${r.failed > 0 ? `（另有 ${r.failed} 个失败）` : ''}` };
    }
  }
}

/**
 * 建一条运行记录，但**先不跑**。
 *
 * 【为什么要把「建行」与「执行」拆开】AI 助手派一个智能体时，它要先把自己挂起来
 * 等这条工作流的结果——而挂起时得说清「我在等哪一条」，也就是必须先拿到 runId。
 * 原来 runWorkflow 是「自己建行、自己一口气跑到底」，调用方在投递前根本拿不到 id：
 * 先跑再挂 = 跑完了才挂上去，那时候叫醒的人早就走了，**这次运行永远醒不来**。
 *
 * 拆开之后次序是：建行 → 挂起（记下 runId）→ 触发执行 → 跑完叫醒。
 */
export async function createWorkflowRun(ctx: WorkflowContext, templateId: string): Promise<string> {
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
      trigger: ctx.trigger ?? 'manual',
    },
  });
  return run.id;
}

/** 建行 + 立刻跑完（页面手点、定时触发走这条：用户在看着，同步跑完才知道卡在哪一步）。 */
export async function runWorkflow(ctx: WorkflowContext, templateId: string): Promise<WorkflowRunView> {
  const runId = await createWorkflowRun(ctx, templateId);
  return executeWorkflowRun(ctx, runId);
}

/** 跑一条已经建好的运行记录。 */
export async function executeWorkflowRun(ctx: WorkflowContext, runId: string): Promise<WorkflowRunView> {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('运行记录不存在');
  const template = await prisma.workflowTemplate.findUnique({ where: { id: run.templateId } });
  if (!template) throw new Error('模板不存在');
  const steps = parseSteps(template.steps);

  const state: StepState = { draftId: run.draftId ?? null, briefs: [] };
  const logs: StepLog[] = [];
  let failed: string | null = null;

  for (const [i, step] of steps.entries()) {
    let result: { ok: boolean; message: string; code?: StepLog['code'] };
    try {
      result = await runStep(ctx, step, state);
    } catch (err) {
      // 配额/预算这类「按设计拒绝」的错误也走这里：它们的 message 本身就是给用户的指引，
      // 原样记进日志比吞掉换一句「执行失败」有用得多。
      // 额外记 code：定时智能体要靠它把「配额用完」与「模板坏了」分开处置。
      log.warn('工作流步骤抛错', { kind: step.kind, error: (err as Error).message });
      result = {
        ok: false,
        message: (err as Error).message.slice(0, 300),
        code: err instanceof QuotaExceededError ? 'QUOTA_EXCEEDED' : undefined,
      };
    }
    logs.push({
      kind: step.kind,
      label: stepLabel(step),
      ok: result.ok,
      message: result.message,
      at: new Date().toISOString(),
      ...(result.code ? { code: result.code } : {}),
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

  // 【有 AI 执行正挂在这条工作流上等结果的话，叫醒它】
  // 动态 import：workflow 是底层模块，静态引 agent 会绕成环（同 browser-task 那边的做法）。
  // 不叫的话，派了智能体的那次执行会一直停在「等它跑完」——而它其实早跑完了。
  try {
    const { wakeRunsWaitingOn, workflowWaitToken } = await import('../agent/wake');
    await wakeRunsWaitingOn(workflowWaitToken(run.id), {
      ok: status === 'done',
      summary: failed ?? `智能体「${template.name}」跑完了：${logs.map((l) => l.label).join(' → ')}`,
      data: { runId: run.id, status, steps: logs.map((l) => ({ label: l.label, ok: l.ok, message: l.message })) },
    });
  } catch (err) {
    // 叫醒失败不能把这次工作流带走：它自己已经跑完并落库了。
    // 挂着的那条运行还有读路径自愈（settleIfResolved）与 24 小时到期兜底。
    log.warn('叫醒等待这条工作流的 AI 执行失败', { runId: run.id, error: (err as Error).message });
  }

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
