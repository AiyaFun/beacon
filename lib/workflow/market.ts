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
  steps: WorkflowStep[];
  stepLabels: string[];
  /** 跑一次会花钱的步数（界面上先把账说清楚） */
  costlySteps: number;
};

/**
 * 内置模板落库（幂等）。**在读的时候顺手做**，不依赖任何一次性种子脚本——
 * 生产库不会跑 prisma/seed.ts，靠脚本的话新装的实例就是一个空市场。
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
          steps: toJson(w.steps),
          isBuiltin: true,
          tenantId: null,
        },
        // 内置模板的步骤以代码为准：用户改不了内置模板（要改就复制一份成自建的），
        // 所以这里覆盖是安全的，且能让下一版内置模板自动生效。
        update: { name: w.name, description: w.description, emoji: w.emoji, steps: toJson(w.steps) },
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
      // 自建模板天然可用（是自己建的），内置的要装
      installed: r.isBuiltin ? installed.has(r.id) : true,
      steps,
      stepLabels: steps.map(stepLabel),
      costlySteps: steps.filter(stepCostly).length,
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
  steps: unknown;
};

export async function createTemplate(
  tenantId: string,
  memberId: string,
  input: CreateTemplateInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = input.name.trim().slice(0, 40);
  if (!name) return { ok: false, error: '模板得有个名字' };

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
      emoji: (input.emoji ?? '🧩').slice(0, 4),
      category: (input.category ?? 'custom').slice(0, 20),
      steps: toJson(parsed.data),
      isBuiltin: false,
      createdBy: memberId,
    },
  });
  return { ok: true, id: row.id };
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
  let data: { beaconWorkflow?: number; name?: string; description?: string; emoji?: string; category?: string; steps?: unknown };
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
    emoji: data.emoji,
    category: data.category,
    steps: data.steps,
  });
}
