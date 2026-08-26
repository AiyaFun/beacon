import { z } from 'zod';
import { SKILL_OUTPUT_KINDS } from '../skills';
import { SKILL_PLATFORM_OPTIONS } from '../skills/platform';
import { stepsSchema } from '../workflow/steps';

// ── beaconPack:1 —— 可分发单位的包格式 ──────────────────────────────────────
//
// 【为什么需要一份正式格式】此前「从网址导入技能」靠的是一条**宽松识别链**：
// 把任意 JSON 里 name/title、prompt/template/instructions/body/content 这些字段
// 挨个试一遍，猜中就当技能收下。那在「用户自己贴一个链接」的场景下够用，
// 但市场是另一回事——市场要回答的是：这是谁做的？版本几？装了会跑什么？
// 靠猜字段答不了这些，而答不了就没法做「有新版本可更新」「这条不兼容当前版本」。
//
// 【它刻意不做什么】
//   · **不含可执行代码**。包里只有提示词模板、步骤 JSON、人设文本这三类**数据**。
//     能力（agent 工具）与浏览器动作是代码白名单，永远不进包——那等于「下载代码执行」。
//   · **不做依赖解析**。技能引用技能、模板引用模板都不支持：一装装一串，
//     用户就说不清自己到底装了什么了。
//
// 【为什么是 zod 而不是 JSON Schema】导入的包是**不可信输入**，与用户自己填的表单同级。
// 项目里所有不可信输入都过 zod（工作流步骤、浏览器任务 payload），这里不另起一套。

/** 包格式版本。将来改结构时靠它分辨，而不是靠字段有没有。 */
export const PACK_VERSION = 1;

const platformKeys = SKILL_PLATFORM_OPTIONS.map((p) => p.key) as [string, ...string[]];

/** 语义化版本的一个窄子集：只允许 `主.次.修`，不接受预发布后缀。 */
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, '版本号要写成 1.0.0 这样的三段式');

const common = {
  /** 稳定标识。**更新时靠它认出「这是同一个东西的新版本」**，所以不许随版本变 */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'slug 只能是小写字母、数字和连字符'),
  name: z.string().min(1).max(40),
  description: z.string().max(200).default(''),
  emoji: z.string().max(4).default('🧩'),
  version: semver,
  /** 作者署名。市场里要显示「谁做的」，但它**不是身份凭证**——签名是另一回事 */
  author: z.string().max(40).default(''),
  /**
   * 最低要求的产品版本。装之前比一次，不兼容就明说而不是装完在运行时炸。
   * 留空 = 不限制。
   */
  minAppVersion: semver.optional(),
};

/**
 * 技能包：一段提示词模板 + 输出契约。
 *
 * `params` 是这次新加的：此前参数卡是**全局固定六个字段**，技能没法声明自己的参数
 *（口播稿要时长、封面要比例）。市场里技能千差万别，不给声明的地方，
 * 差异化配置就只能塞进「补充说明」那个自由文本框里，等于没有。
 */
export const skillPackSchema = z.object({
  ...common,
  kind: z.literal('skill'),
  platform: z.enum(platformKeys).default('generic'),
  outputKind: z.enum(SKILL_OUTPUT_KINDS as unknown as [string, ...string[]]).default('markdown'),
  /** 必须含 {{content}}：技能是作用在一段正文上的，没有它就无处安放输入 */
  promptTemplate: z.string().min(10).max(20_000).refine(
    (t) => /\{\{\s*content\s*\}\}/.test(t),
    '模板里必须有 {{content}} —— 技能是作用在一段正文上的',
  ),
  params: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,20}$/),
        label: z.string().min(1).max(20),
        type: z.enum(['text', 'select', 'number']).default('text'),
        options: z.array(z.string().max(20)).max(12).default([]),
        required: z.boolean().default(false),
      }),
    )
    .max(6)
    .default([]),
});

/** 工作流包（产品里叫「智能体」）：一串写死的步骤。 */
export const workflowPackSchema = z.object({
  ...common,
  kind: z.literal('workflow'),
  /** 什么时候该派它上。空着的话 AI 永远不会主动派它——市场里的模板尤其要写 */
  persona: z.string().max(300).default(''),
  category: z.string().max(20).default('custom'),
  steps: stepsSchema,
});

/** 人设包：一份写给模型的角色设定。 */
export const personaPackSchema = z.object({
  ...common,
  kind: z.literal('persona'),
  /** 直接进每次运行的系统提示词——**这是包里最危险的一类**，见 lib/market/install.ts 的说明 */
  persona: z.string().min(10).max(4_000),
});

export const packBodySchema = z.discriminatedUnion('kind', [skillPackSchema, workflowPackSchema, personaPackSchema]);

/** 完整的包：版本标记 + 包体。**版本标记必须在最外层**，一眼就能判「这是不是烽火台的包」。 */
export const packSchema = z.object({
  beaconPack: z.literal(PACK_VERSION),
  pack: packBodySchema,
});

export type SkillPack = z.infer<typeof skillPackSchema>;
export type WorkflowPack = z.infer<typeof workflowPackSchema>;
export type PersonaPack = z.infer<typeof personaPackSchema>;
export type PackBody = z.infer<typeof packBodySchema>;
export type Pack = z.infer<typeof packSchema>;

export type ParsePackResult = { ok: true; pack: PackBody } | { ok: false; error: string };

/**
 * 严格解析一个包。
 *
 * 与那条宽松识别链的分工说死：**市场来的一律走这里**，只有「用户自己贴一个链接」
 * 才允许退回去猜字段。宽松链留着是为了不砸掉已有的用法，但它不能成为
 * 绕过市场校验的近路——那样定这份格式就没有意义了。
 */
export function parsePack(raw: unknown): ParsePackResult {
  const parsed = packSchema.safeParse(raw);
  if (parsed.success) return { ok: true, pack: parsed.data.pack };

  const first = parsed.error.issues[0];
  const path = first?.path.filter((p) => p !== 'pack').join('.');
  // 把 zod 的整段 issues 翻成一句人话：原文对用户没有意义
  if (path === 'beaconPack' || !path) {
    return { ok: false, error: '这不是烽火台的包（最外层缺少 beaconPack:1 版本标记）' };
  }
  return { ok: false, error: `包格式不对（${path}：${first?.message ?? '格式错误'}）` };
}

/** 比较两个语义化版本。a 比 b 新返回正数。 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 装得上吗（只看版本要求；别的前置条件由 install 那侧判）。 */
export function versionSatisfied(minAppVersion: string | undefined, appVersion: string): boolean {
  if (!minAppVersion) return true;
  return compareVersion(appVersion, minAppVersion) >= 0;
}
