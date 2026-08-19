import crypto from 'node:crypto';
import { prisma } from '../db';
import { llmComplete } from '../llm/gateway';
import { runCover } from '../cover/run';
import { onImageText, type CoverMeta } from '../cover/prompt';
import { MAX_SUBJECT_IMAGES, MAX_REFERENCE_IMAGES } from '../cover/rules';
import { checkText, redlineHits, redlineReason, type WordHit } from '../compliance/engine';
import { renderSkillTemplate } from './render';
import { aiFlavorBanBlock } from '../humanize/lexicon';
// 平台名映射抽到 client-safe 的 ./platform，与 SkillCenter 共用同一份（避免各写一份）
export { skillPlatformName } from './platform';

// 内容技能核心库（域14）：技能 = 提示词模板 + 输出契约，把草稿/终稿一键转成平台成品。
// 内置技能全租户可见、按租户安装；自定义技能归属租户。文本类技能运行走 llmComplete('generation')：
// 配额/BYOK/记账与其他生成路径同一套闸门，出口再过合规引擎（红线 = 导出硬闸同语义）。
// image 类技能（AI 封面）走 lib/cover/run.ts 的 runCover：先抽封面要素，再拼提示词生图、出图即打标，
// 配额/记账同一套闸门；红线只检会画到图上的标题文字（见 run.ts）。封面工位（/studio「标题与封面」）
// 走 /api/cover/generate 直接调 runCover，不经过这里的「已安装」门槛；这里保留 image 分支是给
// 仍从技能列表触发的路径与测试用。

// image = AI 生图封面（走 images/generations，非文本）。custom 技能暂不开放 image（见 createCustomSkill）。
export type SkillOutputKind = 'markdown' | 'html' | 'text' | 'image';

export const SKILL_OUTPUT_KINDS: SkillOutputKind[] = ['markdown', 'html', 'text', 'image'];

// 视觉类技能的 category：这类技能**不进自动预装**（图像更贵、并非人人要，按需装即可），
// 也不允许被创建成自定义技能。见 preinstallSkillsForPlatforms / createCustomSkill。
export const VISUAL_SKILL_CATEGORY = 'visual';

// 【对外契约】创作工坊分片按此 import，字段与签名不可改
export type SkillSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  platform: string;
  category: string;
  outputKind: SkillOutputKind;
  isBuiltin: boolean;
  installed: boolean;
  enabled: boolean; // 已安装且启用（未安装恒为 false）
};

type SkillRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  platform: string;
  category: string;
  outputKind: string;
  isBuiltin: boolean;
};

function asOutputKind(v: string): SkillOutputKind {
  return (SKILL_OUTPUT_KINDS as string[]).includes(v) ? (v as SkillOutputKind) : 'text';
}

function toSummary(skill: SkillRow, install?: { enabled: boolean } | null): SkillSummary {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    emoji: skill.emoji,
    platform: skill.platform,
    category: skill.category,
    outputKind: asOutputKind(skill.outputKind),
    isBuiltin: skill.isBuiltin,
    installed: !!install,
    enabled: !!install?.enabled,
  };
}

// 技能中心全量视图：内置（全租户可见）+ 本租户自定义，带 installed/enabled 标记
export async function listSkillsForTenant(tenantId: string): Promise<SkillSummary[]> {
  const [skills, installs] = await Promise.all([
    prisma.contentSkill.findMany({
      where: { enabled: true, OR: [{ tenantId: null, isBuiltin: true }, { tenantId }] },
      orderBy: [{ isBuiltin: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.skillInstall.findMany({ where: { tenantId } }),
  ]);
  const bySkill = new Map(installs.map((i) => [i.skillId, i]));
  return skills.map((skl) => toSummary(skl, bySkill.get(skl.id) ?? null));
}

// 创作工坊视图：仅已安装且启用的技能
export async function listInstalledSkills(tenantId: string): Promise<SkillSummary[]> {
  const installs = await prisma.skillInstall.findMany({
    where: { tenantId, enabled: true },
    include: { skill: true },
    orderBy: { createdAt: 'asc' },
  });
  return installs
    // 兜底过滤：技能已下架、或残留了别家租户的安装关系（正常流程不会出现）都不给出
    .filter((i) => i.skill.enabled && (i.skill.tenantId === null || i.skill.tenantId === tenantId))
    .map((i) => toSummary(i.skill, i));
}

// 安装：幂等（重复安装只是重新启用）；不许装别的租户的自定义技能
export async function installSkill(tenantId: string, skillId: string): Promise<void> {
  const skill = await prisma.contentSkill.findUnique({ where: { id: skillId } });
  if (!skill || !skill.enabled) throw new Error('这个技能不存在或已下架');
  if (skill.tenantId && skill.tenantId !== tenantId) throw new Error('不能安装其他团队的自定义技能');
  await prisma.skillInstall.upsert({
    where: { tenantId_skillId: { tenantId, skillId } },
    update: { enabled: true },
    create: { tenantId, skillId },
  });
}

// 卸载：幂等（没装过也不报错）
export async function uninstallSkill(tenantId: string, skillId: string): Promise<void> {
  await prisma.skillInstall.deleteMany({ where: { tenantId, skillId } });
}

// 创建自定义技能：本质是一段提示词模板；创建即自动安装
export async function createCustomSkill(
  tenantId: string,
  input: {
    name: string;
    description: string;
    platform: string;
    promptTemplate: string;
    outputKind: 'markdown' | 'html' | 'text';
    emoji?: string;
  },
): Promise<SkillSummary> {
  const name = (input.name ?? '').trim();
  const description = (input.description ?? '').trim();
  const promptTemplate = (input.promptTemplate ?? '').trim();
  if (!name) throw new Error('给技能起个名字吧');
  if (!description) throw new Error('用一句话描述这个技能是干什么的');
  if (!promptTemplate) throw new Error('提示词模板不能为空');
  if (!/\{\{\s*content\s*\}\}/.test(promptTemplate)) {
    throw new Error('提示词模板里需要包含 {{content}} 占位符（代表你的正文），否则 AI 拿不到你的内容');
  }
  // 自定义技能只开放文本三态。image（AI 生图封面）暂不开放自定义：它不是纯提示词模板，
  // 还牵扯图像配额/成本与参考图管线，v1 仅内置提供。
  if (!(['markdown', 'html', 'text'] as string[]).includes(input.outputKind)) {
    throw new Error('输出形态只能是 markdown / html / text');
  }
  const skill = await prisma.contentSkill.create({
    data: {
      tenantId,
      // 自定义技能 slug 约定：custom-<cuid>（c 开头 + 时间戳 + 随机，保证唯一且可辨识）
      slug: `custom-c${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`,
      name: name.slice(0, 40),
      description: description.slice(0, 200),
      emoji: (input.emoji ?? '').trim().slice(0, 8) || '✨',
      platform: (input.platform ?? '').trim() || 'generic',
      category: 'format',
      promptTemplate: promptTemplate.slice(0, 6000),
      outputKind: input.outputKind,
      isBuiltin: false,
    },
  });
  await installSkill(tenantId, skill.id);
  return toSummary(skill, { enabled: true });
}

export type RunSkillResult =
  | {
      ok: true;
      output: string;
      outputKind: string;
      mocked: boolean;
      skillName: string;
      riskLevel: string;
      hits: unknown[];
      // ↓ 仅 image 技能填：生成的封面图（已打隐式 AIGC 标识的 data URL）+ 抽到的封面要素 + 实际用的提示词。
      images?: { url: string; mime: string }[];
      coverMeta?: CoverMeta;
      imagePrompt?: string;
    }
  | { ok: false; error: string };

// image 技能的运行选项。`referenceImages` 是旧口径（第一张视为主体、其余视为背景）；
// 新代码请分开传 subjectImages / backgroundImages。带参考图必须 portraitConsent=true（服务端重算）。
export type CoverRunOptions = {
  style?: string;
  specKey?: string;
  fontKey?: string;
  decors?: string[];
  extra?: string;
  textless?: boolean;
  meta?: { mainTitle?: string; subTitle?: string };
  referenceImages?: string[];
  subjectImages?: string[];
  backgroundImages?: string[];
  portraitConsent?: boolean;
};

// 技能输出的合规闸（独立成层便于单测）：红线命中 → 拒绝（与导出硬闸同语义、同口径）；
// 其余命中（warn/suggest）原样返回给 UI 展示，不拦。
export async function gateSkillOutput(
  output: string,
  platform: string,
  tenantId: string | null,
): Promise<{ ok: false; error: string } | { ok: true; riskLevel: string; hits: WordHit[] }> {
  const redline = await redlineHits(output);
  if (redline.length) return { ok: false, error: redlineReason(redline) };
  const compliance = await checkText(output, platform, tenantId);
  return { ok: true, riskLevel: compliance.riskLevel, hits: compliance.hits };
}

// 运行技能：渲染模板 → llmComplete（generation 路由，同一套配额闸门）→ 出口合规检查。
// LLM 为 Mock 时照常返回，但 mocked 必须透传（UI 要标「演示结果」）。
export async function runSkill(opts: {
  tenantId: string;
  skillId: string;
  content: string;
  title?: string;
  persona?: string;
  context?: string; // 账号完整上下文（指纹/原句样本/口头禅/素材/记忆），供模板 {{context}} 占位符使用（W-2）
  brief?: string; // 本次运行的临时要求（平台/篇幅/语气/指定素材），供模板 {{brief}} 占位符使用
  cover?: CoverRunOptions; // 仅 image 技能用：封面风格 / 参考图 / 留白版
}): Promise<RunSkillResult> {
  const content = (opts.content ?? '').trim();
  if (!content) return { ok: false, error: '正文是空的，先在草稿里写点内容再用技能' };

  // 技能与安装关系都以 opts.skillId 为键，无依赖，一次并行取（省一个来回）
  const [skill, install] = await Promise.all([
    prisma.contentSkill.findUnique({ where: { id: opts.skillId } }),
    prisma.skillInstall.findUnique({
      where: { tenantId_skillId: { tenantId: opts.tenantId, skillId: opts.skillId } },
    }),
  ]);
  if (!skill || !skill.enabled) return { ok: false, error: '这个技能不存在或已下架' };
  if (skill.tenantId && skill.tenantId !== opts.tenantId) return { ok: false, error: '不能使用其他团队的自定义技能' };
  if (!install || !install.enabled) return { ok: false, error: `「${skill.name}」还没安装，先到技能中心装上再用` };

  const prompt = renderSkillTemplate(skill.promptTemplate, {
    content,
    title: opts.title,
    persona: opts.persona,
    context: opts.context,
    brief: opts.brief,
  });

  // image 技能走独立管线：抽封面要素 → 拼图像提示词 → 生图。渲染后的模板在这里当“抽取指令”。
  if (skill.outputKind === 'image') {
    return runCoverSkill({
      tenantId: opts.tenantId,
      skillName: skill.name,
      platform: skill.platform,
      instruction: prompt,
      title: opts.title ?? '',
      cover: opts.cover,
    });
  }

  let res;
  try {
    res = await llmComplete(
      opts.tenantId,
      'generation',
      [
        {
          role: 'system',
          content: [
            '你是资深新媒体内容编辑。严格按照用户给出的任务要求把素材加工成成品，只输出成品本身，不要解释、不要加前后说明。',
            // 去 AI 味的负面清单接在这里：技能是「一键出成品」的最后一道工序，
            // 前面初稿再像人，一遍排版技能把套话灌回去也白搭。
            aiFlavorBanBlock(),
          ].join('\n\n'),
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.5 },
    );
  } catch (e) {
    // 配额超限等「按设计拒绝」的错误：如实告知，不降级不吞
    return { ok: false, error: (e as Error).message };
  }

  const output = res.text.trim();
  if (!output) return { ok: false, error: '模型没有返回内容，请稍后重试' };

  const gate = await gateSkillOutput(output, skill.platform, opts.tenantId);
  if (!gate.ok) return gate;

  return {
    ok: true,
    output,
    outputKind: asOutputKind(skill.outputKind),
    mocked: res.mocked,
    skillName: skill.name,
    riskLevel: gate.riskLevel,
    hits: gate.hits,
  };
}

// 封面技能运行：委托给 lib/cover/run.ts 的 runCover（同一条管线，Route Handler 也走它）。
// 这里只做两件事：把旧口径的 referenceImages 拆成主体/背景，和把结果收敛成 RunSkillResult。
async function runCoverSkill(opts: {
  tenantId: string;
  skillName: string;
  platform: string;
  instruction: string; // 渲染后的技能模板，作为“抽封面要素”的指令
  title: string;
  cover?: CoverRunOptions;
}): Promise<RunSkillResult> {
  const c = opts.cover ?? {};
  const legacy = (c.referenceImages ?? []).slice(0, MAX_REFERENCE_IMAGES);
  const subjectImages = c.subjectImages ?? legacy.slice(0, MAX_SUBJECT_IMAGES);
  const backgroundImages = c.backgroundImages ?? legacy.slice(MAX_SUBJECT_IMAGES);

  const r = await runCover({
    tenantId: opts.tenantId,
    platform: opts.platform,
    specKey: c.specKey,
    styleKey: c.style,
    fontKey: c.fontKey,
    decors: c.decors,
    extra: c.extra,
    textless: c.textless,
    meta: c.meta,
    instruction: opts.instruction,
    fallbackTitle: opts.title,
    subjectImages,
    backgroundImages,
    portraitConsent: c.portraitConsent,
  });
  if (!r.ok) return { ok: false, error: r.error };

  return {
    ok: true,
    output: onImageText(r.meta), // “成品文本” = 封面上的标题（存版本 / 复制用）
    outputKind: 'image',
    mocked: r.mocked, // 抽标题那步是否 Mock；图像本身从不 Mock
    skillName: opts.skillName,
    riskLevel: r.riskLevel,
    hits: r.hits,
    images: r.images.map((i) => ({ url: i.url, mime: i.mime })),
    coverMeta: r.meta,
    imagePrompt: r.imagePrompt,
  };
}

// 按人设的主战平台预装内置技能。
//
// 为什么要有：新注册用户建完人设进创作工坊，「出成品」整块是空的——
// 「还没有安装技能——去技能中心装上…」。可他刚刚才亲口告诉过系统主战平台是哪两个，
// 让他再跑一趟技能中心逐个点「安装」，是把已知的信息又推回给用户去做一遍。
//
// 三条克制：
//   1. 只在这个租户**从未装过任何技能**时才动手。装过又卸掉是明确的选择，不能覆盖；
//   2. 只装内置技能（tenantId=null），不碰别人的自定义技能；
//   3. 静默失败——预装是锦上添花，绝不能让保存人设这件事失败。
export async function preinstallSkillsForPlatforms(tenantId: string, platforms: string[]): Promise<number> {
  if (platforms.length === 0) return 0;
  const already = await prisma.skillInstall.count({ where: { tenantId } });
  if (already > 0) return 0;
  const skills = await prisma.contentSkill.findMany({
    // 视觉类（AI 封面）不进预装：图像更贵、并非人人要，交给用户在技能中心按需安装。
    where: { tenantId: null, enabled: true, platform: { in: platforms }, category: { not: VISUAL_SKILL_CATEGORY } },
    select: { id: true },
  });
  if (skills.length === 0) return 0;
  // 不需要 skipDuplicates：上面的 already>0 已经保证这个租户一条安装记录都没有
  // （而且 sqlite 不支持这个参数，写了本地就跑不起来）。
  await prisma.skillInstall.createMany({ data: skills.map((s) => ({ tenantId, skillId: s.id })) });
  return skills.length;
}
