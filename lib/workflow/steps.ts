import { z } from 'zod';
import { parseJson } from '../json';
import { PLATFORMS, type PlatformKey } from '../constants';

// 平台名必须是系统认识的那几个之一。
//
// 【为什么不能是自由字符串】写错一个字母不会报错，只会**静默退回账号主平台**
// （人设没填就是抖音）——分享来的模板里一个 'xhs' 拼错成 'xhss'，
// 用户看到的是一条跑完了、但整篇按抖音调性写的稿子，而且没有任何地方提示他。
// 收窄之后，错的平台名在保存/导入模板那一刻就被挡下来。
const platformKey = z.enum(Object.keys(PLATFORMS) as [PlatformKey, ...PlatformKey[]]);

// ── 工作流的「一步」是什么 ──────────────────────────────────────────────────
//
// 步骤类型刻意**收得很窄**：每一种都对应系统里一个已经存在、已经有配额与合规闸的动作。
// 不做「自由脚本步」——那等于把任意代码执行挂在模板里，且任何人分享的模板都能跑它。

export const STEP_KINDS = ['topic', 'draft', 'skill', 'cover', 'illustration', 'publish', 'analyze', 'notify'] as const;
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
    platform: platformKey.optional(),
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
    platforms: z.array(platformKey).min(1).max(8),
  }),
  z.object({
    kind: z.literal('analyze'),
    /**
     * 分析什么。三个都是**只读**的现成结论，不新采数据：
     *   performance = 我最近作品跑得怎么样
     *   rivals      = 我盯的那些对家最近在发什么
     *   readers     = 读者在评论区反复问什么
     * 拿到之后交给模型写成一段人话简报，存进资讯库。
     */
    target: z.enum(['performance', 'rivals', 'readers']),
  }),
  z.object({
    kind: z.literal('notify'),
    /**
     * 把这条流水线的结果推到已配置的群机器人。
     *
     * 【它推给谁】按工作区找**已启用且订阅了「智能体跑完」这个事件**的集成。
     * 三种情况都会「一条都没发」而且不报错：没配机器人 / 配了但没勾这个事件 / 发送失败。
     * 所以执行结果里必须把这三种分开说——只写一句「已推送」是这条链上最容易长出来的静默错。
     */
    title: z.string().max(60).optional(),
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
  analyze: '出一份简报',
  notify: '推到群里',
};

const ANALYZE_LABEL: Record<'performance' | 'rivals' | 'readers', string> = {
  performance: '我的作品表现',
  rivals: '对家最近在发什么',
  readers: '读者在关心什么',
};

export function stepLabel(step: WorkflowStep): string {
  const base = KIND_LABEL[step.kind];
  if (step.kind === 'skill') return `${base}：${step.slug}`;
  if (step.kind === 'topic') return `${base}（${step.count} 条）`;
  if (step.kind === 'illustration') return `${base}（${step.count} 张）`;
  if (step.kind === 'publish') return `${base}（${step.platforms.join('、')}）`;
  if (step.kind === 'analyze') return `${base}：${ANALYZE_LABEL[step.target]}`;
  return base;
}

/**
 * 这一步花不花钱。界面上要在跑之前把总账说清楚——
 * 「一键跑完」最容易变成「一键把额度烧完」，用户有权先看见再决定。
 */
export function stepCostly(step: WorkflowStep): boolean {
  // publish 只建计划（纯写库）、notify 只发一条消息（纯 HTTP），两者都不烧模型额度。
  // analyze 要把查到的数据交给模型写成简报，算钱。
  return step.kind !== 'publish' && step.kind !== 'notify';
}
