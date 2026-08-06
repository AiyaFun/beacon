import { prisma } from '../db';
import { emptyPersona, readPersona, personaPromptBlock } from '../persona';
import { buildAccountContext, type AccountContext } from '../account-context';
import { aiFlavorBanBlock } from '../humanize/lexicon';
import { platformName, type PlatformKey } from '../constants';
import { writeMemory } from '../memory/core';
import type { ChatMessage } from '../llm/types';

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

export type DraftTarget = {
  draftId: string;
  topic: { rationale: string | null; sourceType: string; sourceRef: string | null } | null;
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
}): Promise<{ ok: true; target: DraftTarget } | { ok: false; error: string }> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: input.accountId } });
  if (!account) return { ok: false, error: '未找到账号' };
  const persona = safePersona(account.personaCard);

  let draft = input.draftId
    ? await prisma.draft.findFirst({ where: { id: input.draftId, accountId: input.accountId }, include: { topic: true } })
    : null;

  let topicTitle = draft?.topic?.title ?? draft?.title ?? '';
  let topicAngle = draft?.topic?.angle ?? '';
  const platform = (draft?.platform ?? (persona.platforms[0] as PlatformKey | undefined) ?? 'douyin') as PlatformKey;

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
      topic: draft.topic ? { rationale: draft.topic.rationale, sourceType: draft.topic.sourceType, sourceRef: draft.topic.sourceRef } : null,
      topicTitle,
      topicAngle,
      platform,
      persona,
      personaCard: account.personaCard,
    },
  };
}

export type DraftContext = { accountCtx: AccountContext; selectionCtx: string };

/** 账号上下文（指纹/原句样本/口头禅/素材/记忆）+ 选题上下文包。两种模式都要用。 */
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
    blocks: ['fingerprint', 'exemplar', 'catchphrase', 'material', 'memory'],
    memoryQuery: [input.target.topicTitle, input.target.topicAngle].filter(Boolean).join(' '),
  });
  const selectionCtx = await buildSelectionContext(input.target.topic);
  return { accountCtx, selectionCtx };
}

/** 普通（非深度）初稿的 prompt。流式与非流式逐字相同——这正是把它拎出来的原因。 */
export function buildDraftMessages(target: DraftTarget, ctx: DraftContext): { messages: ChatMessage[]; temperature: number } {
  return {
    temperature: 0.8,
    messages: [
      {
        role: 'system',
        content: [
          `你是账号的内容创作助手，为「${platformName(target.platform)}」平台创作一篇初稿文案。`,
          personaPromptBlock(target.persona),
          ctx.accountCtx.text,
          ctx.selectionCtx,
          aiFlavorBanBlock(),
          '要求：结构完整（钩子-正文-引导），贴合人设与目标平台，优先复用素材库里的真实经历与被验证的擅长方向增强差异化，控制在合理篇幅。只输出正文。',
          '语感要求：句子长短要有起伏，不要句句工整、段段等长；该说人话的地方就说半句话。',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      { role: 'user', content: `选题：${target.topicTitle}\n差异化切入角：${target.topicAngle || '（自行确定）'}` },
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
