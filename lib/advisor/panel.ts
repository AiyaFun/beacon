import { prisma } from '../db';
import { parseJson, toJson, type Metrics, engagementRate } from '../json';
import { readPersona, personaPromptBlock, personaCompleteness, type PersonaCard } from '../persona';
import { readFingerprint, fingerprintPromptBlock } from '../style';
import { materialContextForAccount } from '../material';
import { buildMemoryContext } from '../memory/core';
import { accountBaselineBlock, competitorContextBlock } from '../account-context';
import { llmComplete } from '../llm/gateway';
import { getSession } from '../session';
import { ACCOUNT_HEALTH_DIMENSIONS, platformName } from '../constants';

// ─────────────────────────────────────────────────────────────
// F10 选题智囊团 · 核心（12 人物混编 + 账号多维体检）
// 设计依据 research-12：并行独立发言（互不可见）+ 人物异质性带来多样性；
// 受众侧模拟第一反应，专家侧做带数据的 rubric 检查。Mock 下亦返回可用内容。
// ─────────────────────────────────────────────────────────────

export type AdvisorRole = 'audience' | 'expert';

export type AdvisorPersona = {
  key: string;
  name: string;
  role: AdvisorRole;
  emoji: string;
  stance: string; // 一句话世界观/立场
  focus: string[]; // 打分时的注意力分配
};

// 受众侧 5 席：覆盖「铁粉 / 新粉 / 流失 / 路人 / 付费」完整生命周期
const AUDIENCE_PANEL: AdvisorPersona[] = [
  {
    key: 'audience_core_fan',
    name: '铁粉阿May',
    role: 'audience',
    emoji: '🙋‍♀️',
    stance: '关注你很久了，只认你亲测过、能照抄的干货，套话一出现就划走',
    focus: ['是不是我等很久的选题', '有没有独家细节', '值不值得收藏'],
  },
  {
    key: 'audience_new_fan',
    name: '路过的新粉',
    role: 'audience',
    emoji: '👀',
    stance: '第一次刷到你，凭这一条决定要不要点关注',
    focus: ['前3秒抓不抓人', '看完想不想关注', '和别人有啥不一样'],
  },
  {
    key: 'audience_churn_fan',
    name: '有点腻的老粉',
    role: 'audience',
    emoji: '😪',
    stance: '你的套路我都熟了，再重复同一招我就取关',
    focus: ['是不是又是老一套', '有没有新鲜感', '会不会审美疲劳'],
  },
  {
    key: 'audience_passerby',
    name: '算法路人',
    role: 'audience',
    emoji: '🛑',
    stance: '完全不认识你，推荐流里三秒决定去留',
    focus: ['封面标题够不够勾', '内容形态适不适合这个平台', '会不会立刻划走'],
  },
  {
    key: 'audience_buyer',
    name: '准付费学员',
    role: 'audience',
    emoji: '💳',
    stance: '焦虑但谨慎，看完会盘算这内容值不值得为它花钱',
    focus: ['能不能解决我的具体问题', '有没有让我信任你的证据', '看完想不想进一步付费'],
  },
];

// 专家侧 7 席：每席绑定一种真实数据源，做结构化维度检查
const EXPERT_PANEL: AdvisorPersona[] = [
  {
    key: 'expert_algo_officer',
    name: '平台算法运营官',
    role: 'expert',
    emoji: '📊',
    stance: '一切服从平台分发逻辑，完播率与互动是硬指标',
    focus: ['选题在目标平台吃不吃流量红利', '标题封面怎么配', '前3秒钩子设计'],
  },
  {
    key: 'expert_deconstructor',
    name: '爆款拆解师',
    role: 'expert',
    emoji: '🔍',
    stance: '所有爆款都有结构，能套上验证过的钩子才敢做',
    focus: ['同赛道爆款结构', '能不能复用验证过的选题公式', '钩子够不够硬'],
  },
  {
    key: 'expert_contrarian',
    name: '逆向唱反调者',
    role: 'expert',
    emoji: '😈',
    stance: '大家都说好时我必须泼冷水，找出每个方向最大的失败风险',
    focus: ['这个选题为什么会翻车', '是不是伪热点', '会不会追风踩空'],
  },
  {
    key: 'expert_monetization',
    name: '变现顾问',
    role: 'expert',
    emoji: '💰',
    stance: '内容要服务于变现路径，离钱太远的选题不值得投入',
    focus: ['能不能自然埋转化钩子', '和商业目标的链路', '能否沉淀成付费产品'],
  },
  {
    key: 'expert_compliance',
    name: '合规审查员',
    role: 'expert',
    emoji: '🛡️',
    stance: '红线一步都不能踩，宁可保守也不冒险',
    focus: ['有没有触碰法律/平台红线', '灰区表述提示', '哪个平台能发哪个不能'],
  },
  {
    key: 'expert_data_analyst',
    name: '数据分析师',
    role: 'expert',
    emoji: '📈',
    stance: '不看感觉只看数据，用你的历史绩效说话',
    focus: ['哪类内容在涨', '这个方向与历史绩效的匹配度', '数据支不支持'],
  },
  {
    key: 'expert_competitor',
    name: '竞对操盘手',
    role: 'expert',
    emoji: '♟️',
    stance: '如果我是你的头部竞对，我最怕你打哪个差异化空缺',
    focus: ['竞对已占据的角度', '空白的差异化空间', '怎么反打对手'],
  },
];

export const ADVISOR_PANEL: AdvisorPersona[] = [...AUDIENCE_PANEL, ...EXPERT_PANEL];

export function panelByRole(role: AdvisorRole): AdvisorPersona[] {
  return ADVISOR_PANEL.filter((p) => p.role === role);
}

// ─────────────────────────────────────────────────────────────
// 人物卡 DB 化：账号级可自定义 + 采纳/否决自学习
// ─────────────────────────────────────────────────────────────

export const MAX_ENABLED_PERSONAS = 16; // 每场会诊 = 每人物一次 LLM 并发，上限防成本失控

// 权重规则住在叶子模块 weight.ts（learn.ts 的数据校准也要用，避免模块环），此处原样再导出保持调用点不变
export { advisorWeight, dataDeltaFromNotes, DEMOTION_EXEMPT } from './weight';
export type { LearnedNote } from './weight';
import type { LearnedNote } from './weight';
import { beijingDayKey } from '../beijing';

export type AdvisorPersonaRow = {
  id: string;
  key: string;
  name: string;
  role: AdvisorRole;
  emoji: string;
  stance: string;
  focus: string[];
  source: string; // builtin | custom
  enabled: boolean;
  weight: number;
  adoptedCount: number;
  rejectedCount: number;
  learnedNotes: LearnedNote[];
};

function toRow(p: {
  id: string; key: string; name: string; role: string; emoji: string; stance: string;
  focus: string; source: string; enabled: boolean; weight: number;
  adoptedCount: number; rejectedCount: number; learnedNotes: string;
}): AdvisorPersonaRow {
  return {
    ...p,
    role: (p.role === 'audience' ? 'audience' : 'expert') as AdvisorRole,
    focus: parseJson<string[]>(p.focus, []),
    learnedNotes: parseJson<LearnedNote[]>(p.learnedNotes, []),
  };
}

// 账号首次使用智囊团时，从内置 12 人模板落库；之后完全以 DB 为准（可增删改）
export async function ensureAdvisorPersonas(accountId: string): Promise<AdvisorPersonaRow[]> {
  const count = await prisma.advisorPersona.count({ where: { accountId } });
  if (count === 0) {
    await prisma.advisorPersona.createMany({
      data: ADVISOR_PANEL.map((p) => ({
        accountId,
        key: p.key,
        name: p.name,
        role: p.role,
        emoji: p.emoji,
        stance: p.stance,
        focus: toJson(p.focus),
        source: 'builtin',
      })),
    });
  }
  const rows = await prisma.advisorPersona.findMany({
    where: { accountId },
    orderBy: [{ weight: 'desc' }, { createdAt: 'asc' }],
  });
  return rows.map(toRow);
}

// 人物的成长上下文：历史战绩 + 经验教训，注入其发言 prompt——这就是「采纳/否决时自我学习」的消费端。
// W-5 后又多了一层：被采纳的提案发布出去以后，数据跑赢还是跑输也会写进 learnedNotes，
// 人物成长从「用户嘴上说好」升级为「数据说了算」——这两类证据在 prompt 里分开陈述，不混为一谈。
function growthBlock(p: AdvisorPersonaRow): string {
  const verdictTotal = p.adoptedCount + p.rejectedCount;
  const proven = p.learnedNotes.filter((n) => n.verdict === 'data_proven');
  const failed = p.learnedNotes.filter((n) => n.verdict === 'data_failed');
  if (verdictTotal === 0 && proven.length + failed.length === 0) return '';
  const lines: string[] = [];
  if (verdictTotal > 0) {
    lines.push(
      `【你的历史战绩】过往提案被检验 ${verdictTotal} 次：采纳 ${p.adoptedCount} 次、否决 ${p.rejectedCount} 次（采纳率 ${Math.round((p.adoptedCount / verdictTotal) * 100)}%）。`,
    );
    const adopted = p.learnedNotes.filter((n) => n.verdict === 'adopted').slice(-3);
    const rejected = p.learnedNotes.filter((n) => n.verdict === 'rejected').slice(-3);
    if (adopted.length > 0) lines.push(`近期被采纳的方向：${adopted.map((n) => `「${n.text}」`).join('；')}`);
    if (rejected.length > 0) lines.push(`近期被否决的方向：${rejected.map((n) => `「${n.text}」`).join('；')}`);
  }
  if (proven.length + failed.length > 0) {
    lines.push(
      `【你的提案上线后的真实数据】跑赢账号基线 ${proven.length} 次、跑输 ${failed.length} 次（这是发布回流数据算的，不是用户的主观判断）。`,
    );
    if (proven.length > 0) lines.push(`被数据验证有效：${proven.slice(-3).map((n) => `「${n.text}」`).join('；')}`);
    if (failed.length > 0) lines.push(`未跑出基线：${failed.slice(-3).map((n) => `「${n.text}」`).join('；')}`);
  }
  lines.push('请吸取以上经验：靠近被采纳、被数据验证有效的风格与颗粒度，避免重蹈被否决与跑输的类型，但不要因此放弃你的人物立场。');
  return lines.join('\n');
}

// P1-7 会诊连续性：把最近的会诊结论带进这一场，避免每次都从零开始、反复推荐同一个方向。
// 只取「真实会诊」（summary 带 ⚠ 前缀的是 Mock/兜底场次，结论不作数）——演示内容不能反过来当历史经验用。
export async function recentSessionsBlock(accountId: string, take = 2): Promise<string> {
  const sessions = await prisma.advisorSession.findMany({
    where: { accountId, status: 'done' },
    orderBy: { createdAt: 'desc' },
    take: take + 3, // 多取几场，过滤掉 Mock 场次后仍够数
    include: { opinions: { where: { adopted: true }, take: 3, orderBy: { createdAt: 'asc' } } },
  });
  const usable = sessions.filter((s) => !(s.summary ?? '').startsWith('⚠')).slice(0, take);
  if (usable.length === 0) return '';
  const lines = usable.map((s) => {
    const when = beijingDayKey(s.createdAt);
    const seed = s.topicSeed?.trim() ? `议题「${s.topicSeed.trim()}」` : '开放式议题';
    const adopted = s.opinions.map((o) => `「${o.suggestion.slice(0, 40)}」`).join('；');
    return `- ${when} ${seed}：${adopted ? `已采纳 ${adopted}` : '当时没有任何提案被采纳'}`;
  });
  return [
    '【近期会诊回顾】',
    ...lines,
    '请在此基础上推进：已被采纳的方向不要原样重复（可以深化或指出后续风险），当时无人被采纳说明那一轮的角度都没打动账号主，请换思路。',
  ].join('\n');
}

type OpinionDraft = { suggestion: string; rationale: string; mocked?: boolean };

// 单个人物发言：并行调用，人物间互不可见（各自独立 prompt）
// roleContext：该人物专属的真实数据块（数据席看基线/体检、竞对席看竞对作品）——按 focus 差异化下发，
// 不全员广播，避免 12-16 席并发把 token 成本成倍放大（P0-6）。
async function speakAs(
  tenantId: string | null,
  persona: Pick<AdvisorPersonaRow, 'name' | 'role' | 'stance' | 'focus'>,
  sharedContext: string,
  seed?: string,
  growth?: string,
  roleContext?: string,
  draftMode = false,
): Promise<OpinionDraft> {
  const roleLabel = persona.role === 'audience' ? '典型受众/粉丝画像' : '专业顾问';
  const sys = [
    `你正在参加一次内容账号的选题智囊团会诊。你扮演的人物视角是「${persona.name}」（${roleLabel}）。`,
    `你的立场：${persona.stance}`,
    `你打量选题时最在意：${persona.focus.join('、')}`,
    growth || '',
    persona.role === 'audience'
      ? '注意：你是被模拟的粉丝画像，只能表达「我作为这类观众预计会怎么反应」，不能代表真实用户调研。'
      : '注意：请从你的专业维度给出结构化判断，紧扣你的关注点。',
  ].filter(Boolean).join('\n');
  const user = [
    sharedContext,
    roleContext ? roleContext : null,
    draftMode
      ? `【本次议题】评这篇已写好的草稿${seed ? `（补充要求：${seed}）` : ''}——不是想新选题，是让它更好。`
      : seed
        ? `【本次议题】${seed}`
        : '【本次议题】开放式——帮这个账号想选题方向。',
    '',
    draftMode
      ? `请只以「${persona.name}」这一个人物视角，针对上面的草稿正文给出 1 条最该改的修改意见（具体到改哪里、怎么改），不要重写全文。`
      : `请只以「${persona.name}」这一个人物视角，给出 1 条你最想推荐的选题方向和理由。`,
    roleContext ? '你手上有上方的真实数据，请让你的建议明确建立在这些数据之上，不要空谈。' : null,
    draftMode
      ? '严格输出 JSON：{"suggestion":"一句话修改意见（指明改动位置与改法）","rationale":"为什么这么改（结合你的立场与关注点）"}'
      : '严格输出 JSON：{"suggestion":"一句话选题方向（具体可执行）","rationale":"你之所以这么建议的理由（结合你的立场与关注点）"}',
  ].filter((x) => x !== null).join('\n');

  const res = await llmComplete(
    tenantId,
    'advisor',
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { json: true, temperature: 0.9 },
  );
  const parsed = parseJson<Partial<OpinionDraft>>(res.text, {});
  const suggestion = parsed.suggestion && String(parsed.suggestion).trim();
  const rationale = parsed.rationale && String(parsed.rationale).trim();
  // mocked 判定（此前 review 指出智囊团整条丢弃了 mocked 信号）：真降级(res.mocked/degraded)
  // 或真实响应缺关键字段走了兜底文案，都算「非真实会诊」，必须让上层能提示，别当真结论采纳。
  const usedFallback = !suggestion || !rationale;
  return {
    suggestion: suggestion || `以「${persona.name}」的视角看，建议围绕账号最擅长的方向做一条更具体、可照做的选题。`,
    rationale: rationale || `基于我的立场「${persona.stance}」，这个方向最贴近我关心的：${persona.focus.join('、')}。`,
    mocked: res.mocked || Boolean(res.degraded) || usedFallback,
  };
}

// 哪些席位吃真实数据：数据席看历史绩效基线+体检结论，竞对席看订阅竞对作品。
// 兑现人物卡承诺——「数据分析师」stance 自称「用你的历史绩效说话」，此前 prompt 里根本没有数据。
const DATA_PERSONA_KEYS = new Set(['expert_data_analyst', 'expert_algo_officer']);
const COMPETITOR_PERSONA_KEYS = new Set(['expert_competitor', 'expert_deconstructor']);

// 数据席的专属上下文：跨平台真实基线 + 六维体检一句话诊断。无数据则返回空串（不喂占位噪声）。
async function buildAdvisorDataBlock(
  accountId: string,
  account: { personaCard: string; platform: string } | null,
): Promise<string> {
  const [baseline, posts, publishRecords] = await Promise.all([
    accountBaselineBlock(accountId),
    prisma.ownPost.findMany({ where: { accountId }, select: { metrics: true, platform: true } }),
    prisma.publishRecord.findMany({ where: { accountId }, select: { metrics: true, platform: true, fromRecommend: true } }),
  ]);
  const parts: string[] = [];
  if (baseline) parts.push(baseline);
  if (account && (posts.length > 0 || publishRecords.length > 0)) {
    const scores = accountHealth({ personaCard: account.personaCard, platform: account.platform }, posts, publishRecords);
    parts.push(`【账号体检结论】${sixDimScorecard(scores).verdict}`);
  }
  if (parts.length === 0) return '';
  return ['【真实数据参考（仅你的专家席位可见，请据此发言而非空谈）】', ...parts].join('\n');
}

// W-6 草稿会诊：把已成稿的正文摆上桌，人物按各自 focus 提修改意见。
// 与选题会诊共用同一套人物/上下文/落库结构，只换「议题材料」与产出要求——
// 不另起一套引擎，避免两处人物成长逻辑漂移。
const DRAFT_EXCERPT_CHARS = 1800;

async function draftMaterialBlock(accountId: string, draftId: string): Promise<{ block: string; title: string } | null> {
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 }, topic: true },
  });
  if (!draft) return null;
  const content = draft.versions[0]?.content?.trim() ?? '';
  if (!content) return null;
  const excerpt = content.length > DRAFT_EXCERPT_CHARS ? `${content.slice(0, DRAFT_EXCERPT_CHARS)}……（正文过长已截断）` : content;
  const lines = [
    `【本次会诊材料：草稿《${draft.title}》（目标平台 ${platformName(draft.platform)}）】`,
    draft.topic?.angle ? `原定切入角：${draft.topic.angle}` : '',
    '正文如下：',
    excerpt,
  ].filter(Boolean);
  return { block: lines.join('\n'), title: draft.title };
}

// 召集智囊团：启用人物并行发言 → 落库 AdvisorSession + AdvisorOpinion
// 人物来自账号级 DB 配置（可自定义身份）；每个人物的 prompt 注入其历史战绩与经验教训（自学习）。
// draftId（W-6）：改为对这篇草稿会诊——人物给的是修改意见而不是新选题方向。
export async function convene(
  accountId: string,
  workspaceId: string,
  seed?: string,
  draftId?: string,
  /**
   * 计费与限流用的租户。**在没有请求上下文的地方调用时必须显式传**
   *（后台跑的 AI 执行、worker、群机器人——那里 getSession() 必然失败）。
   *
   * 不传就退回从会话取，取不到则为 null；而 null 会让 assertLlmQuota 与
   * assertNotDemo **直接放行**——一场十几席的会诊一个配额都不计，
   * 演示租户也拦不住。这不是「优雅降级」，是白送。
   */
  tenantIdOverride?: string | null,
): Promise<string> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');
  const draftMaterial = draftId ? await draftMaterialBlock(accountId, draftId) : null;
  if (draftId && !draftMaterial) throw new Error('草稿不存在或还没有正文——先生成一版初稿再开会诊');
  const memoryContext = await buildMemoryContext(
    workspaceId,
    accountId,
    seed?.trim() || draftMaterial?.title || undefined,
  );

  let tenantId: string | null = tenantIdOverride ?? null;
  if (tenantId === null && tenantIdOverride === undefined) {
    // 只有「调用方没说」时才去翻会话。显式传了 null 就是真的没有租户，别再自作主张
    try {
      tenantId = (await getSession()).tenantId;
    } catch {
      tenantId = null;
    }
  }

  const fp = readFingerprint(account?.styleFingerprint ?? '{}');
  const [materialCtx, historyCtx] = await Promise.all([
    materialContextForAccount(accountId),
    recentSessionsBlock(accountId),
  ]);
  const sharedContext = [
    '【会诊背景】以下是本账号的人设与长期记忆，所有人物共享同一份背景，但彼此看不到对方发言。',
    personaPromptBlock(persona),
    fingerprintPromptBlock(fp),
    materialCtx,
    historyCtx,
    memoryContext || '（暂无长期记忆）',
    draftMaterial?.block ?? '',
  ].filter(Boolean).join('\n');

  // 触发场景判定：草稿会诊固定 draft_review；否则连续被拒→repeated_reject；冷启动→cold_start
  const trigger = draftMaterial ? 'draft_review' : await inferTrigger(accountId);

  const all = await ensureAdvisorPersonas(accountId);
  const panel = all.filter((p) => p.enabled).slice(0, MAX_ENABLED_PERSONAS);

  // 真实数据块按人物 focus 差异化下发（P0-6）：只有需要它的席位在场时才查库。
  const needData = panel.some((p) => DATA_PERSONA_KEYS.has(p.key));
  const needCompetitor = panel.some((p) => COMPETITOR_PERSONA_KEYS.has(p.key));
  const [dataBlock, competitorBlock] = await Promise.all([
    needData ? buildAdvisorDataBlock(accountId, account) : Promise.resolve(''),
    needCompetitor ? competitorContextBlock(workspaceId) : Promise.resolve(''),
  ]);
  const roleContextFor = (key: string): string => {
    if (DATA_PERSONA_KEYS.has(key)) return dataBlock;
    if (COMPETITOR_PERSONA_KEYS.has(key)) return competitorBlock;
    return '';
  };

  // 并行发言（多数席位成功即可，失败人物给兜底）
  const drafts = await Promise.all(
    panel.map(async (p) => {
      try {
        return {
          persona: p,
          draft: await speakAs(tenantId, p, sharedContext, seed, growthBlock(p), roleContextFor(p.key), Boolean(draftMaterial)),
        };
      } catch {
        return {
          persona: p,
          draft: {
            suggestion: draftMaterial
              ? `（${p.name}本次发言未能生成，已按其立场给出兜底意见）请按其关注点再过一遍这篇草稿。`
              : `（${p.name}本次发言未能生成，已按其立场给出兜底方向）围绕账号强项做一条更具体的选题。`,
            rationale: p.stance,
            mocked: true, // 发言异常兜底，非真实会诊
          } as OpinionDraft,
        };
      }
    }),
  );

  const audienceCount = drafts.filter((d) => d.persona.role === 'audience').length;
  const expertCount = drafts.length - audienceCount;
  // 有任一席位是演示/兜底内容就在（已入库的）summary 里如实提示——零 schema 改动地补上
  // review 指出的「智囊团无 Mock 提示」缺口，避免用户把演示内容当真实多人会诊结论采纳。
  const anyMocked = drafts.some((d) => d.draft.mocked);
  const mockNote = anyMocked ? '⚠ 本次部分人物为演示内容（AI 未接入或未能生成结构化结果），请勿当作真实会诊结论。 ' : '';
  const summary = draftMaterial
    ? `${mockNote}${drafts.length} 位人物读完草稿《${draftMaterial.title}》并各提了 1 条修改意见：受众侧 ${audienceCount} 席说读感，专家侧 ${expertCount} 席挑毛病。采纳的意见可一键改进正文（在创作工坊生成新版本）。`
    : `${mockNote}${drafts.length} 位人物完成并行会诊：受众侧 ${audienceCount} 席给出第一反应，专家侧 ${expertCount} 席多维把关。逐条采纳或否决——结果会写入记忆、更新人物权重与经验，人物在下次会诊中据此成长。`;

  const session = await prisma.advisorSession.create({
    data: {
      accountId,
      trigger,
      topicSeed: seed?.trim() || null,
      draftRef: draftId ?? null,
      status: 'done',
      summary,
    },
  });

  await prisma.advisorOpinion.createMany({
    data: drafts.map((d) => ({
      sessionId: session.id,
      personaKey: d.persona.key,
      personaName: d.persona.name,
      personaRole: d.persona.role,
      stance: d.persona.stance,
      suggestion: d.draft.suggestion,
      rationale: d.draft.rationale,
      adopted: null,
    })),
  });

  return session.id;
}

// 触发场景启发式：近 14 天推荐拒绝占比高→repeated_reject；无历史发布→cold_start；否则 manual
async function inferTrigger(accountId: string): Promise<string> {
  const since = new Date(Date.now() - 14 * 86400000);
  const [rejected, accepted, published] = await Promise.all([
    prisma.topicIdea.count({ where: { accountId, state: 'rejected', createdAt: { gte: since } } }),
    prisma.topicIdea.count({ where: { accountId, state: { in: ['accepted', 'drafting'] }, createdAt: { gte: since } } }),
    prisma.publishRecord.count({ where: { accountId } }),
  ]);
  const total = rejected + accepted;
  if (total >= 5 && accepted / total < 0.15) return 'repeated_reject';
  if (published === 0) return 'cold_start';
  return 'manual';
}

// ─────────────────────────────────────────────────────────────
// 多维评估：账号项目级「体检报告」六维
// ─────────────────────────────────────────────────────────────

export type HealthScores = Record<string, number>;

export type Scorecard = {
  scores: HealthScores;
  total: number;
  verdict: string; // 一句话诊断
  weakest: { key: string; name: string; score: number };
  strongest: { key: string; name: string; score: number };
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// 变异系数越小越稳定（0 方差=满分稳定）
function stability(xs: number[]): number {
  if (xs.length < 2) return 60;
  const m = mean(xs);
  if (m <= 0) return 40;
  const variance = mean(xs.map((x) => (x - m) ** 2));
  const cv = Math.sqrt(variance) / m;
  return clamp(100 - cv * 120);
}

// 用真实数据 + 启发式打六维分。posts=自有作品，publishRecords=发布回流
export function accountHealth(
  account: { personaCard: string; platform: string } | null,
  posts: { metrics: string; platform: string }[],
  publishRecords: { metrics: string; platform: string; fromRecommend: boolean }[],
): HealthScores {
  const persona: PersonaCard = readPersona(account?.personaCard ?? '{}');

  // 1) 定位清晰度：人设完整度 + 内容边界是否闭环（能做/不能做都定义 = 定位清晰）
  const boundaryBonus = (persona.canDo.length > 0 ? 8 : 0) + (persona.cantDo.length > 0 ? 8 : 0);
  const positioning = clamp(personaCompleteness(persona) * 0.84 + boundaryBonus);

  // 2) 内容质量稳定度：自有作品互动率的稳定性 + 完播率均值
  // 只统计算得出互动率的作品。抖音等平台没有播放量，engagementRate 返回 null——
  // 把 null 当 0 塞进来会让「稳定度」看起来剧烈波动，凭空扣掉内容质量分。
  const engs = posts
    .map((p) => engagementRate(parseJson<Metrics>(p.metrics, {})))
    .filter((e): e is number => e !== null);
  const completions = posts
    .map((p) => parseJson<Metrics>(p.metrics, {}).completion ?? 0)
    .filter((c) => c > 0);
  const quality = posts.length
    ? clamp(stability(engs) * 0.6 + mean(completions) * 100 * 0.4 + 8)
    : 45;

  // 3) 算法适配度：完播率均值（高=算法友好）+ 平台覆盖广度
  const platformSet = new Set<string>([
    ...posts.map((p) => p.platform),
    ...publishRecords.map((r) => r.platform),
    ...persona.platforms,
  ]);
  const coverage = Math.min(3, platformSet.size) / 3; // 覆盖 3+ 平台记满
  const algoFit = clamp((mean(completions) * 100 || 42) * 0.7 + coverage * 30);

  // 4) 粉丝结构：发布回流的互动率 + 评论占比（评论多=活跃真粉，非路人脉冲）
  const prMetrics = publishRecords.map((r) => parseJson<Metrics>(r.metrics, {}));
  const prEng = mean(prMetrics.map((m) => engagementRate(m)).filter((e): e is number => e !== null));
  const commentRatio = mean(
    prMetrics.map((m) => {
      const inter = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.collects ?? 0);
      return inter > 0 ? (m.comments ?? 0) / inter : 0;
    }),
  );
  const audience = publishRecords.length ? clamp(prEng * 100 * 6 + commentRatio * 100 * 1.5 + 30) : 40;

  // 5) 变现潜力：商业价值主张清晰度 + 推荐位转化占比 + 平台矩阵多样性
  const hasBiz = persona.valueProp.trim().length > 0 ? 30 : 0;
  const fromRecommendRatio = publishRecords.length
    ? publishRecords.filter((r) => r.fromRecommend).length / publishRecords.length
    : 0;
  const monetization = clamp(hasBiz + fromRecommendRatio * 25 + coverage * 25 + prEng * 100 * 2 + 10);

  // 6) 风险敞口（分数越高=越安全）：内容边界越清晰、平台越不集中 = 风险越低
  const redlineGuard = persona.cantDo.length >= 2 ? 30 : persona.cantDo.length === 1 ? 18 : 5;
  const concentration = platformSet.size <= 1 ? 0 : Math.min(1, (platformSet.size - 1) / 2); // 单平台依赖=高风险
  const risk = clamp(40 + redlineGuard + concentration * 25);

  return {
    positioning,
    quality,
    algoFit,
    audience,
    monetization,
    risk,
  };
}

// 把六维分聚合成总评 + 一句话诊断（展示层）
export function sixDimScorecard(scores: HealthScores): Scorecard {
  const dims = ACCOUNT_HEALTH_DIMENSIONS.map((d) => ({ ...d, score: scores[d.key] ?? 0 }));
  const total = clamp(mean(dims.map((d) => d.score)));
  const sorted = [...dims].sort((a, b) => a.score - b.score);
  const weakest = sorted[0];
  const strongest = sorted[sorted.length - 1];

  let grade = '需要重塑';
  if (total >= 80) grade = '基本盘扎实';
  else if (total >= 65) grade = '稳中有短板';
  else if (total >= 50) grade = '及格待打磨';

  const verdict = `综合体检 ${total} 分（${grade}）。最强项是「${strongest.name}」，最该补的是「${weakest.name}」——建议就这一维召开专项会诊或采纳对应人物提案。`;

  return {
    scores,
    total,
    verdict,
    weakest: { key: weakest.key, name: weakest.name, score: weakest.score },
    strongest: { key: strongest.key, name: strongest.name, score: strongest.score },
  };
}
