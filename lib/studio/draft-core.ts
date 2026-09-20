import { prisma } from '../db';
import { emptyPersona, readPersona, personaPromptBlock } from '../persona';
import { buildAccountContext, type AccountContext } from '../account-context';
import { aiFlavorBanBlock } from '../humanize/lexicon';
import { platformName, type PlatformKey } from '../constants';
import { writeMemory } from '../memory/core';
import type { ChatMessage } from '../llm/types';
import { platformFormatBlock, platformHardSpec } from './platform-format';
import { ANGLE_SHAPE_LABELS, ANGLE_SHAPE_RULES, normalizeAngleShape } from '../topic/scoring';
import { buildBattleCards, formatViews, type BattleReference } from '../topic/battlecard';

// 初稿生成的**共享内核**：定位草稿 → 装上下文 → 拼 prompt → 落库，四段都在这里，
// 被两个入口共用：
//   · server action `actDraft`（非流式；深度模式两段式也走这里的定位与上下文）
//   · 流式路由 `/api/studio/draft/stream`（增量输出，边写边看）
//
// 为什么必须共用而不是各写一份：两个入口只要各自拼一次 prompt，就会在某次改动后
// **悄悄分叉**——用户会发现「流式生成」和「普通生成」写出来的东西不一样，
// 而没有任何测试会红。本项目已经因为并行实现同一件事踩过一次（reviewed 回写写了两份）。

export function safePersona(raw: string | null | undefined) {
  return { ...emptyPersona(), ...readPersona(raw ?? '{}') };
}

export const PLATFORM_STYLE: Record<string, string> = {
  douyin: '短视频口播稿：开头3秒强钩子，口语化短句，节奏快，结尾引导互动（点赞/关注）。',
  xiaohongshu: '小红书图文：标题带emoji与数字，正文分点、真实体验感，穿插关键词标签，结尾抛话题。',
  wechat: '公众号文章：观点清晰、逻辑分层、金句收尾，适合深度阅读，保留专业度。',
  bilibili: '中长视频脚本：有信息增量与人格化叙述，分章节推进，适度玩梗但不失干货。',
  shipinhao: '视频号口播稿：开头点明「对谁有用」，说人话不玩梗，观点完整可被转述——内容主要靠熟人转发扩散，要写成「值得转给朋友看」的样子；时长 1-3 分钟。',
  x: '推文体：一句话说清核心观点，凝练犀利，可拆成 thread，去除冗余修饰。',
  youtube: '长视频脚本：清晰的 intro-body-outro 结构，强调价值主张，引导订阅。',
  tiktok: '英文短视频口播稿：1 秒内给视觉钩子，句子短、主谓宾直给（观众多为非母语），全程不留可跳过的空段；结尾给一句让人想转发的话，而不是「点个关注」。',
};

// W-1 选题上下文包：把「为什么推荐这个选题 + 智囊团怎么说」随选题带进初稿 prompt。
export async function buildSelectionContext(
  topic: { rationale: string | null; sourceType: string; sourceRef: string | null } | null,
): Promise<string> {
  if (!topic) return '';
  const lines: string[] = [];
  const rationale = (topic.rationale ?? '').trim();
  if (rationale) lines.push(`【这个选题为什么值得做】${rationale}`);
  if (topic.sourceType === 'advisor' && topic.sourceRef) {
    const op = await prisma.advisorOpinion.findUnique({
      where: { id: topic.sourceRef },
      select: { personaName: true, suggestion: true, rationale: true },
    });
    if (op) lines.push(`【智囊团意见】${op.personaName}：${op.suggestion}（${op.rationale}）`);
  }
  return lines.join('\n');
}

/**
 * 选题在初稿里要用到的那几列。此前只带 rationale/sourceType/sourceRef，于是选题中心花一次精排定下的
 * 「答案结构」「已知事实」「时间窗口」全在起稿这一步丢掉了——稿子只能靠标题 + 一句切入角从头猜。
 */
export type DraftTopic = {
  id: string;
  title: string;
  angle: string;
  angleShape: string | null;
  rationale: string | null;
  evidence: string | null;
  windowHint: string | null;
  scores: string;
  sourceType: string;
  sourceRef: string | null;
};

function toDraftTopic(t: {
  id: string; title: string; angle: string; angleShape: string | null; rationale: string | null;
  evidence: string | null; windowHint: string | null; scores: string; sourceType: string; sourceRef: string | null;
}): DraftTopic {
  return {
    id: t.id, title: t.title, angle: t.angle, angleShape: t.angleShape, rationale: t.rationale,
    evidence: t.evidence, windowHint: t.windowHint, scores: t.scores, sourceType: t.sourceType, sourceRef: t.sourceRef,
  };
}

export type DraftTarget = {
  draftId: string;
  topic: DraftTopic | null;
  topicTitle: string;
  topicAngle: string;
  platform: PlatformKey;
  persona: ReturnType<typeof safePersona>;
  personaCard: string | null;
};

/**
 * 定位（必要时新建）本次要写的草稿。**有副作用**：无草稿时会建一份并把选题置为 drafting，
 * 所以每次生成只能调一次——两个入口各调一次会凭空多出一份草稿。
 */
export async function resolveDraftTarget(input: {
  accountId: string;
  draftId: string | null;
  topicId?: string;
  /**
   * 新建草稿时指定平台。只有**调用方明确知道要写给哪个平台**时才传——
   * 工作流模板就是这种：「小红书日更三件套」的第一步写死了 xiaohongshu。
   *
   * 【不传会怎样】退回人设的主战平台，人设没填就是 douyin。
   * 这不只是标签错：初稿提示词第一句是「为「抖音」平台创作一篇初稿文案」，
   * 还会带上抖音的内容形态——于是「小红书日更三件套」的第一步
   * **写出来的是一篇抖音文案**，第二步再拿小红书排版技能去排它。
   *
   * 【为什么不能覆盖已有草稿的平台】用户在创作工坊里把一篇稿子定成公众号，
   * 工作流不该因为模板写了别的就把它改掉。所以下面的取值顺序是
   * 「已有草稿 > 调用方指定 > 人设默认」。
   */
  platform?: PlatformKey;
}): Promise<{ ok: true; target: DraftTarget } | { ok: false; error: string }> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: input.accountId } });
  if (!account) return { ok: false, error: '未找到账号' };
  const persona = safePersona(account.personaCard);

  let draft = input.draftId
    ? await prisma.draft.findFirst({ where: { id: input.draftId, accountId: input.accountId }, include: { topic: true } })
    : null;

  let topicTitle = draft?.topic?.title ?? draft?.title ?? '';
  let topicAngle = draft?.topic?.angle ?? '';
  const platform = (draft?.platform ??
    input.platform ??
    (persona.platforms[0] as PlatformKey | undefined) ??
    'douyin') as PlatformKey;

  if (!draft) {
    const topic = input.topicId
      ? await prisma.topicIdea.findFirst({
          where: { id: input.topicId, accountId: input.accountId, state: { in: ['drafting', 'accepted', 'recommended'] } },
        })
      : await prisma.topicIdea.findFirst({
          where: { accountId: input.accountId, state: { in: ['accepted', 'drafting', 'recommended'] } },
          orderBy: [{ totalScore: 'desc' }, { createdAt: 'desc' }],
        });
    if (!topic) return { ok: false, error: '没有可用选题，请先到选题中心采纳一个方向' };
    topicTitle = topic.title;
    topicAngle = topic.angle;
    draft = await prisma.draft.create({
      data: { accountId: input.accountId, topicId: topic.id, title: topic.title, platform, status: 'editing' },
      include: { topic: true },
    });
    await prisma.topicIdea.update({ where: { id: topic.id }, data: { state: 'drafting' } });
  }

  return {
    ok: true,
    target: {
      draftId: draft.id,
      topic: draft.topic ? toDraftTopic(draft.topic) : null,
      topicTitle,
      topicAngle,
      platform,
      persona,
      personaCard: account.personaCard,
    },
  };
}

export type DraftContext = {
  accountCtx: AccountContext;
  selectionCtx: string;
  /** 选题方案块（buildPlanBlock）：切入角 / 答案结构 / 已知事实 / 时间窗口 / 同题参考。没有选题时为空串 */
  planCtx: string;
};

/**
 * 选题**方案**块（2026-09-15）。用户的话：「点击起稿的内容效果没有很高——已经有对应的格式还有方案」。
 *
 * 选题中心一次精排已经定了：切入角（angle）、答案结构（angleShape：清单/对比/流程/定义/判断，
 * 每种都有「算写实了」的判据 ANGLE_SHAPE_RULES）、「为什么是你/为什么是现在」的事实证据（evidence，
 * 候选源产出、不是编的）、时间窗口（windowHint）；作战卡还查出了订阅竞对做过同题的作品。
 * 此前这些一样都没进初稿提示词，稿子只能拿标题 + 一句切入角从头猜，出来就是面面俱到的综述。
 * 这里把它们拼成一份「照着写」的方案，事实只许来自这里和账号上下文。
 */
export function buildPlanBlock(topic: DraftTopic, references: BattleReference[] = []): string {
  const shape = normalizeAngleShape(topic.angleShape);
  const lines = ['【这条选题的方案（选题中心已经定了，照它写，别另起炉灶）】'];
  if (topic.angle.trim()) lines.push(`- 切入角（唯一主线，不要写成面面俱到的综述）：${topic.angle.trim()}`);
  if (shape) lines.push(`- 答案结构：${ANGLE_SHAPE_LABELS[shape]}——${ANGLE_SHAPE_RULES[shape]}`);
  if (topic.evidence?.trim()) lines.push(`- 已知事实（来自账号历史数据 / 热榜时间线 / 读者评论，不是推测；稿子里的事实只许来自这里和账号素材）：${topic.evidence.trim()}`);
  if (topic.windowHint?.trim()) lines.push(`- 时间窗口：${topic.windowHint.trim()}（可以点出「就是现在」的意义，但别写具体日期）`);
  if (topic.rationale?.trim()) lines.push(`- 为什么值得做：${topic.rationale.trim()}`);
  if (references.length) {
    const refs = references.slice(0, 3).map((r) => `《${r.title}》（${platformName(r.platform)}${r.views > 0 ? ` · ${formatViews(r.views)} 播放` : ''}）`);
    lines.push(`- 同题参考（订阅竞对近 30 天做过的；只用来避开同质化、找到他们没说的那一层，不许照抄）：${refs.join('；')}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * 「怎么写才不像机器」。每一条都对应真机初稿里出现过的毛病：
 * 「### 📌【目标客群】」式栏目、每段一个 emoji、「我亲自去体验了一下」（素材库里根本没有）、
 * 「那么问题来了」「欢迎在评论区分享你的看法哦😊」收尾、「最近发现了一种…」起手。
 * 禁用词表（aiFlavorBanBlock）管的是词，这里管的是**结构与编造**。
 */
export const DRAFT_HYGIENE_BLOCK = [
  '【怎么写才不像机器】',
  '- 不要按「开头钩子 → 分点小标题 → 总结 → 互动提问」的模板铺排，也不要给每段配一个 emoji 或【栏目名】；要点顺着说，像一个人在讲一件事',
  '- 素材库和已知事实里没有的亲身经历、数字、身份，一个都不要编：没有「我亲自试过」的记录就不要写「我亲自试过」，宁可少一段',
  '- 第一句就进正题：不要「最近发现了」「今天来聊聊」「大家好」这类起手式',
  '- 结尾要么是一句立得住的判断，要么是一个具体到能回答的问题；不要「总结」「那么问题来了」「欢迎在评论区留言」',
  '- 除非上面的平台格式明确允许，不用小标题、不用 markdown（#、**、---）、不用【】',
  '- 不用「首先/其次/最后」「一方面/另一方面」这类路标词；不用「不仅…而且」「不是…而是」「既…又」这类对仗——密集对仗是读者最先认出 AI 的地方',
  '- 写具体：一个真场景、一个有名字的东西、一个只来自方案或素材的数字，胜过三句概括；允许有立场、允许说「我不太确定」、允许一句题外话',
  '- 句子可以不完整，段落长短不齐，关键的一句可以单独成段；不要每段都是三四句、每句都是二十来字',
].join('\n');

/** 账号上下文（指纹/原句样本/口头禅/素材/记忆）+ 选题上下文包 + 选题方案。两种模式都要用。 */
export async function loadDraftContext(input: {
  workspaceId: string;
  accountId: string;
  target: DraftTarget;
}): Promise<DraftContext> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: input.accountId } });
  const accountCtx = await buildAccountContext({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    account: account ?? undefined,
    platform: input.target.platform,
    blocks: ['fingerprint', 'exemplar', 'voice', 'catchphrase', 'material', 'memory'],
    memoryQuery: [input.target.topicTitle, input.target.topicAngle].filter(Boolean).join(' '),
  });
  const selectionCtx = await buildSelectionContext(input.target.topic);
  let planCtx = '';
  if (input.target.topic) {
    const t = input.target.topic;
    let references: BattleReference[] = [];
    try {
      // 作战卡的「同题参考」：订阅竞对近 30 天做过的同题作品。拿不到就不给，方案块照样成立
      const cards = await buildBattleCards(input.workspaceId, input.accountId, [{ id: t.id, title: t.title, scores: t.scores }]);
      references = cards.get(t.id)?.references ?? [];
    } catch { /* 参考样本只是锦上添花 */ }
    planCtx = buildPlanBlock(t, references);
  }
  return { accountCtx, selectionCtx, planCtx };
}

/** 普通（非深度）初稿的 prompt。流式与非流式逐字相同——这正是把它拎出来的原因。 */
export function buildDraftMessages(target: DraftTarget, ctx: DraftContext): { messages: ChatMessage[]; temperature: number } {
  const shape = normalizeAngleShape(target.topic?.angleShape);
  return {
    temperature: 0.8,
    messages: [
      {
        role: 'system',
        content: [
          `你是账号的内容创作助手，为「${platformName(target.platform)}」平台写一篇能直接发出去的初稿。`,
          personaPromptBlock(target.persona),
          ctx.accountCtx.text,
          ctx.selectionCtx,
          // 方案（选题中心定的切入角/答案结构/事实/窗口/同题参考）与格式（字数/标题/分段/标签/结尾）：
          // 2026-09-15 之前两样都没有，稿子靠模型自觉，出来是同一副公众号腔
          ctx.planCtx,
          platformFormatBlock(target.platform),
          aiFlavorBanBlock(),
          DRAFT_HYGIENE_BLOCK,
          '要求：贴合人设与目标平台，优先复用素材库里的真实经历与被验证的擅长方向增强差异化；方案里的切入角是唯一主线。只输出正文，不要解释、不要附标题以外的任何标签。',
          '语感要求：句子长短要有起伏，不要句句工整、段段等长；该说人话的地方就说半句话。',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      {
        role: 'user',
        content: [
          `选题：${target.topicTitle}`,
          `差异化切入角：${target.topicAngle || '（自行确定）'}`,
          shape ? `答案结构：${ANGLE_SHAPE_LABELS[shape]}` : '',
          // 硬指标在 user 消息里再钉一次：system 块被长上下文稀释后，最先被忘掉的
          // 就是字数、标题行、话题标签这三样——而它们恰恰是「一眼看出不是这个平台的」那几样。
          `本篇硬指标：${platformHardSpec(target.platform)}`,
        ].filter(Boolean).join('\n'),
      },
    ],
  };
}

/** 把生成结果落成新一版（版本号、diff 文案、状态、偏好记忆，两个入口共用同一套写法）。 */
export async function persistDraftVersion(input: {
  workspaceId: string;
  accountId: string;
  draftId: string;
  topicTitle: string;
  content: string;
  label?: string;
}): Promise<{ seq: number }> {
  const last = await prisma.draftVersion.findFirst({ where: { draftId: input.draftId }, orderBy: { seq: 'desc' } });
  const seq = (last?.seq ?? 0) + 1;
  await prisma.draftVersion.create({
    data: {
      draftId: input.draftId,
      seq,
      authorType: 'ai',
      content: input.content,
      diffFromPrev:
        input.label || (last ? `AI 基于选题「${input.topicTitle}」重新生成一版初稿（第${seq}版）` : 'AI 生成的首版初稿'),
    },
  });
  await prisma.draft.update({ where: { id: input.draftId }, data: { status: 'editing', updatedAt: new Date() } });
  await writeMemory({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    type: 'preference',
    content: `用户为选题「${input.topicTitle}」触发了 AI 初稿生成`,
    confidence: 0.3,
  });
  return { seq };
}
