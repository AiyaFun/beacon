import { z } from 'zod';
import { parseJson } from '../json';

// ── 工作流的「一步」是什么 ──────────────────────────────────────────────────
//
// 步骤类型刻意**收得很窄**：每一种都对应系统里一个已经存在、已经有配额与合规闸的动作。
// 不做「自由脚本步」——那等于把任意代码执行挂在模板里，且任何人分享的模板都能跑它。

export const STEP_KINDS = ['topic', 'draft', 'skill', 'cover', 'illustration', 'publish'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const stepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('topic'),
    /** 生成几条选题推荐 */
    count: z.number().int().min(1).max(12).default(6),
  }),
  z.object({
    kind: z.literal('draft'),
    /** 目标平台；留空 = 跟随账号主平台 */
    platform: z.string().max(30).optional(),
    /** 指定选题 id；留空 = 用分数最高的那条 */
    topicId: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('skill'),
    /** 技能 slug（内置或本租户自建）。跑完把结果存成新版本 */
    slug: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('cover'),
    styleKey: z.string().max(40).optional(),
    specKey: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal('illustration'),
    count: z.number().int().min(1).max(6).default(3),
    styleKey: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal('publish'),
    /** 要发哪些平台。发布**只建计划，不真的发**——真发那一步永远要用户自己确认 */
    platforms: z.array(z.string().max(30)).min(1).max(8),
  }),
]);

export type WorkflowStep = z.infer<typeof stepSchema>;

export const stepsSchema = z.array(stepSchema).min(1).max(10);

export function parseSteps(raw: string | null | undefined): WorkflowStep[] {
  const parsed = stepsSchema.safeParse(parseJson<unknown[]>(raw, []));
  // 坏模板不该把整页打挂：解析不了就当成空模板，界面上会显示「这个模板没有步骤」。
  return parsed.success ? parsed.data : [];
}

const KIND_LABEL: Record<StepKind, string> = {
  topic: '生成选题推荐',
  draft: '写初稿',
  skill: '跑技能',
  cover: '出封面',
  illustration: '出正文配图',
  publish: '建发布计划',
};

export function stepLabel(step: WorkflowStep): string {
  const base = KIND_LABEL[step.kind];
  if (step.kind === 'skill') return `${base}：${step.slug}`;
  if (step.kind === 'topic') return `${base}（${step.count} 条）`;
  if (step.kind === 'illustration') return `${base}（${step.count} 张）`;
  if (step.kind === 'publish') return `${base}（${step.platforms.join('、')}）`;
  return base;
}

/**
 * 这一步花不花钱。界面上要在跑之前把总账说清楚——
 * 「一键跑完」最容易变成「一键把额度烧完」，用户有权先看见再决定。
 */
export function stepCostly(step: WorkflowStep): boolean {
  return step.kind !== 'publish';
}
