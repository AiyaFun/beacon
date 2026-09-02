import { prisma } from '../db';
import { toJson } from '../json';
import { stepsSchema, parseSteps, stepLabel, stepCostly, type WorkflowStep } from './steps';
import { BUILTIN_WORKFLOWS } from './builtin';
import { createLogger } from '../logger';

const log = createLogger({ module: 'workflow-market' });

// ── 模板市场：内置 + 自建 + 安装 + 导入导出 ──────────────────────────────────
//
// 存储与「技能中心」同构（内置全局行 + 按租户安装），刻意不发明第二套机制：
// 两套市场意味着两套安装状态、两套权限判断、两处要改。

export type TemplateSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  isBuiltin: boolean;
  installed: boolean;
  /** 职责说明：什么时候该派它上。空串 = 没写，AI 不会主动派它 */
  persona: string;
  /** 跑之前得先有什么。空串 = 装上就能直接跑 */
  requires: string;
  steps: WorkflowStep[];
  stepLabels: string[];
  /** 跑一次会花钱的步数（界面上先把账说清楚） */
  costlySteps: number;
  /** pipeline（步骤定死）| autonomous（给它目标，自己安排怎么做） */
  mode: string;
  /** 自主型的配置（JSON，见 lib/agent/autonomous.ts）。流水线型为 null */
  agentConfig: string | null;
};

/**
 * 内置模板落库（幂等）。**在读的时候顺手做**，不依赖任何一次性种子脚本——
 * 生产库不会跑 prisma/seed.ts，靠脚本的话新装的实例就是一个空市场。
 *
 * 【每个读路径都该调它，别怕成本】三次 upsert 是几毫秒，而调用方
 *（页面渲染、AI 工具）本身动辄几十毫秒到几秒。不调的代价才是真的：
 * 2026-08-19 给内置模板补 persona 之后，只有 /workflows 页会同步，
 * AI 的 list_agents 在有人访问过那一页之前一直读到空职责——它一个内置智能体
 * 都派不动，而且不报错。
 *
 * 【曾经加过进程内「已同步」标记，撤了】收益是省掉那三次 upsert，代价是
 * 一个隐藏的跨调用状态：测试 beforeEach 清库之后标记还在，于是从第二个用例起
 * 内置模板永远不再落库（tests/workflow/market.test.ts 当场变红）。
 * 为几毫秒引入这种耦合不划算——真要优化，优化的是调用频率，不是给函数加记忆。
 */
export async function ensureBuiltinTemplates(): Promise<void> {
  for (const w of BUILTIN_WORKFLOWS) {
    try {
      await prisma.workflowTemplate.upsert({
        where: { slug: w.slug },
        create: {
          slug: w.slug,
          name: w.name,
          description: w.description,
          emoji: w.emoji,
          category: w.category,
          persona: w.persona,
          requires: w.requires ?? '',
          steps: toJson(w.steps),
          isBuiltin: true,
          tenantId: null,
        },
        // 内置模板的步骤以代码为准：用户改不了内置模板（要改就复制一份成自建的），
        // 所以这里覆盖是安全的，且能让下一版内置模板自动生效。
        // persona 也要进 update：只写 create 的话，**已经存在**的内置模板永远补不上职责
        // ——而所有现存部署的内置模板都是在加这个字段之前建的
        // requires 也要进 update：只写 create 的话，**已经存在**的内置模板永远补不上前置条件
        //（与 persona 当初栽的是同一个跟头）
        update: {
          name: w.name, description: w.description, emoji: w.emoji,
          persona: w.persona, requires: w.requires ?? '', steps: toJson(w.steps),
        },
      });
    } catch (err) {
      log.warn('内置模板落库失败', { slug: w.slug, error: (err as Error).message });
    }
  }
}

export async function listTemplates(tenantId: string): Promise<TemplateSummary[]> {
  await ensureBuiltinTemplates();
  const [rows, installs] = await Promise.all([
    prisma.workflowTemplate.findMany({
      where: { enabled: true, OR: [{ isBuiltin: true }, { tenantId }] },
      orderBy: [{ isBuiltin: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.workflowInstall.findMany({ where: { tenantId } }),
  ]);
  const installed = new Set(installs.filter((i) => i.enabled).map((i) => i.templateId));

  return rows.map((r) => {
    const steps = parseSteps(r.steps);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      emoji: r.emoji,
      category: r.category,
      isBuiltin: r.isBuiltin,
      persona: r.persona,
      requires: r.requires,
      // 自建模板天然可用（是自己建的），内置的要装
      installed: r.isBuiltin ? installed.has(r.id) : true,
      steps,
      stepLabels: steps.map(stepLabel),
      costlySteps: steps.filter(stepCostly).length,
      mode: r.mode,
      agentConfig: r.agentConfig,
    };
  });
}

export async function installTemplate(tenantId: string, templateId: string): Promise<{ ok: boolean; error?: string }> {
  const t = await prisma.workflowTemplate.findFirst({
    where: { id: templateId, enabled: true, OR: [{ isBuiltin: true }, { tenantId }] },
  });
  if (!t) return { ok: false, error: '模板不存在' };
  await prisma.workflowInstall.upsert({
    where: { tenantId_templateId: { tenantId, templateId } },
    create: { tenantId, templateId, enabled: true },
    update: { enabled: true },
  });
  return { ok: true };
}

export async function uninstallTemplate(tenantId: string, templateId: string): Promise<{ ok: boolean }> {
  await prisma.workflowInstall.updateMany({ where: { tenantId, templateId }, data: { enabled: false } });
  return { ok: true };
}

export type CreateTemplateInput = {
  name: string;
  description?: string;
  emoji?: string;
  category?: string;
  /** 职责说明：什么时候该派它上。写了 AI 才会在对话里主动派它 */
  persona?: string;
  steps: unknown;
  /** 内部标记：importTemplate 走进来的豁免职责必填（分享的 JSON 缺职责不拒收） */
  fromImport?: boolean;
};

export async function createTemplate(
  tenantId: string,
  memberId: string,
  input: CreateTemplateInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = input.name.trim().slice(0, 40);
  if (!name) return { ok: false, error: '模板得有个名字' };

  // 【为什么职责说明必填】AI 助手在对话里靠它决定「用户这句话该派谁」（lib/agent/tools.ts）。
  // 没写职责的智能体等于把最短的那条调用路（对话直接说目标）永久关掉——用户装了它、
  // 却永远等不到 AI 派它，最后的结论是「这功能不好用」。与其事后在卡片上亮警示，
  // 不如创建时就把话说清。**导入不受此限**（fromImport）：别人分享的 JSON 缺职责不该拒收，
  // 收进来之后卡片上的警示会引导补写。
  if (!input.fromImport && !(input.persona ?? '').trim()) {
    return { ok: false, error: '写一句职责说明（什么时候该派它上）——没写的话 AI 不会在对话里主动派它' };
  }

  const parsed = stepsSchema.safeParse(input.steps);
  if (!parsed.success) {
    // 把 zod 的第一条错误翻成人话：整段 issues 对用户没有意义
    const first = parsed.error.issues[0];
    return { ok: false, error: `步骤配置不对（${first?.path.join('.') || '第一步'}：${first?.message ?? '格式错误'}）` };
  }

  // slug 用租户前缀，避免自建模板与内置模板撞名（slug 是全局唯一键）
  const base = `t-${tenantId.slice(0, 6)}-${name.replace(/\s+/g, '-').slice(0, 20)}`;
  let slug = base;
  for (let i = 2; await prisma.workflowTemplate.findUnique({ where: { slug } }); i++) {
    slug = `${base}-${i}`;
    if (i > 50) return { ok: false, error: '同名模板太多了，换个名字' };
  }

  const row = await prisma.workflowTemplate.create({
    data: {
      tenantId,
      slug,
      name,
      description: (input.description ?? '').slice(0, 200),
      // 职责说明会进模型上下文（AI 靠它决定派谁），截断而不是打回——
      // 用户写长了不该整个创建失败，那是「截断不打回」那条规矩
      persona: (input.persona ?? '').slice(0, 300),
      emoji: (input.emoji ?? '🧩').slice(0, 4),
      category: (input.category ?? 'custom').slice(0, 20),
      steps: toJson(parsed.data),
      isBuiltin: false,
      createdBy: memberId,
    },
  });
  return { ok: true, id: row.id };
}

/**
 * 给智能体写职责说明：什么时候该派它上。
 *
 * **内置模板也允许改**（不像删除只限自建）：内置的职责是平台写的通用说法，
 * 而「什么时候该派它」高度依赖这个团队自己的活法。改动只落在这个租户的那一行吗？
 * ——不，内置模板是全租户共用一行，所以这里**只允许改自建的**。
 * 内置的想改，先「另存为自己的」再改（导出/导入已有这条路）。
 */
export async function setTemplatePersona(
  tenantId: string,
  templateId: string,
  persona: string,
): Promise<{ ok: boolean; error?: string }> {
  const t = await prisma.workflowTemplate.findUnique({ where: { id: templateId }, select: { tenantId: true, isBuiltin: true } });
  if (!t) return { ok: false, error: '智能体不存在' };
  if (t.isBuiltin || t.tenantId !== tenantId) {
    return { ok: false, error: '内置智能体的职责由平台维护；想改成你团队的说法，先导出成自己的再改' };
  }
  await prisma.workflowTemplate.update({
    where: { id: templateId },
    // 截断不打回：写长了不该整个保存失败
    data: { persona: persona.trim().slice(0, 300) },
  });
  return { ok: true };
}

export async function deleteTemplate(tenantId: string, templateId: string): Promise<{ ok: boolean; error?: string }> {
  // 只能删自己建的：内置模板是全局行，删掉会影响所有租户
  const r = await prisma.workflowTemplate.deleteMany({ where: { id: templateId, tenantId, isBuiltin: false } });
  return r.count > 0 ? { ok: true } : { ok: false, error: '只能删除自己创建的模板' };
}

/** 导出成一段可分享的 JSON（不含任何租户信息——分享出去的东西不该带上你是谁）。 */
export async function exportTemplate(tenantId: string, templateId: string): Promise<string | null> {
  const t = await prisma.workflowTemplate.findFirst({
    where: { id: templateId, OR: [{ isBuiltin: true }, { tenantId }] },
  });
  if (!t) return null;
  return JSON.stringify(
    {
      beaconWorkflow: 1,
      name: t.name,
      description: t.description,
      // 职责说明是「AI 什么时候派它」的判据，分享出去不带它 = 对方装到的是个
      // 永远不会被对话派单的哑巴（2026-09-01 查出导出/导入两头都在丢这个字段）
      persona: t.persona,
      emoji: t.emoji,
      category: t.category,
      steps: parseSteps(t.steps),
    },
    null,
    2,
  );
}

export async function importTemplate(
  tenantId: string,
  memberId: string,
  json: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  let data: { beaconWorkflow?: number; name?: string; description?: string; persona?: string; emoji?: string; category?: string; steps?: unknown };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return { ok: false, error: '这不是一段合法的 JSON' };
  }
  if (data.beaconWorkflow !== 1) return { ok: false, error: '这不是烽火台的工作流模板（缺少版本标记）' };
  if (!data.name) return { ok: false, error: '模板缺少名字' };
  // 导入的步骤同样要过 schema：别人给的 JSON 与用户自己填的一样不可信
  return createTemplate(tenantId, memberId, {
    name: data.name,
    description: data.description,
    persona: data.persona,
    emoji: data.emoji,
    category: data.category,
    steps: data.steps,
    fromImport: true,
  });
}

/**
 * 建人设时把内置智能体装上。
 *
 * 【为什么要有这个】技能一直有预装（lib/skills 的 preinstallSkillsForPlatforms，
 * 建人设时按主战平台装上），智能体却没有——两边口径不对称，而后果是单向的：
 * 全库 WorkflowInstall 一行都没有，也就是说**没有任何租户装过智能体**。
 * 于是产品自带的三条开箱即用模板，对每一个用户都是「看得见、用不上」，
 * 而 AI 的 list_agents 只列已装的，它会永远回答「这个团队还没装任何智能体」。
 *
 * 【装 ≠ 跑，所以这件事是安全的】安装只是让它出现在可派清单里，一分钱都不花。
 * 真正花钱的是用户点「跑一遍」或 AI 派活（那一步另有确认闸）。
 *
 * 【只在「一条都没装过」时做】与技能预装同一条判据：用户手工卸载过之后，
 * 不该在他下次改人设时又给装回来——那是替他做决定。
 */
export async function preinstallBuiltinTemplates(tenantId: string): Promise<number> {
  const already = await prisma.workflowInstall.count({ where: { tenantId } });
  if (already > 0) return 0;

  await ensureBuiltinTemplates();
  const rows = await prisma.workflowTemplate.findMany({
    where: { isBuiltin: true, enabled: true },
    select: { id: true },
  });
  if (rows.length === 0) return 0;

  // 不用 skipDuplicates：上面的 already>0 已经保证这个租户一条安装记录都没有
  //（而且 sqlite 不支持这个参数，写了本地就跑不起来——与技能预装同一个坑）
  await prisma.workflowInstall.createMany({
    data: rows.map((r) => ({ tenantId, templateId: r.id, enabled: true })),
  });
  return rows.length;
}
