'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { emptyPersona, readPersona, personaPromptBlock } from '@/lib/persona';
import { buildAccountContext } from '@/lib/account-context';
import { llmComplete } from '@/lib/llm/gateway';
import { QuotaExceededError } from '@/lib/quota';
import { AIGC_LABEL, checkText, ensureAigcLabel, redlineHits, redlineReason, type WordHit } from '@/lib/compliance/engine';
import { writeMemory } from '@/lib/memory/core';
import { platformName, type PlatformKey } from '@/lib/constants';
import { exportDeliverable, downloadSkillFile, verifyAigcLabelInFile, injectAigcDocProps } from '@/lib/llm/skills';
import { renderLocalDeliverable, renderCards } from '@/lib/deliverable/registry';
import { CARD_THEME_LIST, DEFAULT_CARD_THEME, type Card, type CardThemeKey } from '@/lib/deliverable/card';
import { aigcMetadataJson } from '@/lib/compliance/aigc';
import { runSkill, type CoverRunOptions } from '@/lib/skills';
import { injectPngAigcMetadata } from '@/lib/deliverable/png-meta';
import { recordDiffPreference } from '@/lib/memory/diff';
import { resolveExportClaudeKey } from './export-key';
import { requireRole, RbacError } from '@/lib/rbac';
import { resolvePlatformItemId } from '@/lib/publish/parse-url';
import { buildBaseline, type MetricBaseline } from '@/lib/algorithm/coach';
import { analyzeContent, type ContentFinding } from '@/lib/algorithm/content-optimizer';
import { humanizeReport, humanizeProblemBlock, type HumanizeReport } from '@/lib/humanize/score';
import { aiFlavorBanBlock } from '@/lib/humanize/lexicon';
import { checkFactDrift } from '@/lib/humanize/factcheck';
import {
  buildTitlePrompt,
  parseTitleMatrix,
  diagnoseTitle,
  type TitleCandidate,
  type CoverSuggestion,
  type TitleDiagnosis,
} from '@/lib/studio/title';
import { familyPlatforms } from '@/lib/studio/family';
import { buildOutlinePrompt, buildVoicePrompt, cleanOutline, stripStageLabels } from '@/lib/studio/two-stage';
import {
  safePersona,
  PLATFORM_STYLE,
  buildSelectionContext,
  resolveDraftTarget,
  loadDraftContext,
  buildDraftMessages,
  persistDraftVersion,
} from '@/lib/studio/draft-core';
import { buildSkillBriefBlock, type SkillBrief } from '@/lib/skills/brief';
import type { Metrics } from '@/lib/json';

// 「按设计拒绝」类错误：配额用尽（QuotaExceededError）与权限不足（RbacError）。
// Next 15 生产构建会脱敏抛到 error boundary 的错误 message —— 配额那句「可升级套餐 / 配自己的 Key」
// 自救文案会被替换成通用英文串 + digest，用户在最后防线上再也救不回来。故这类错误必须在 action 层
// catch，转成可序列化的结构化返回（Next 不脱敏 action 的返回值），前端按 error 字段原样红字展示。
// 其余异常（真 bug）继续抛给 boundary，不掩盖。
function isDesignedRejection(e: unknown): e is QuotaExceededError | RbacError {
  return e instanceof QuotaExceededError || e instanceof RbacError;
}

// 登记发布：存定稿正文（可随时重新复制回去）+ 解析发布链接拿 platformItemId + 形成记忆学习信号
//
// platformItemId 是自动回流的**唯一入口**：lib/jobs/handlers.ts 的 backfill_metrics 只捞
// platformItemId 非空的记录。不写它 = 这条记录永远只能手动回填。
//
// AC③「AI 声明确认项必选」：input.aigcConfirmed !== true 即拒绝（与 /data 路径同口径）。
export async function actRegisterPublish(
  draftId: string,
  input: { url?: string; aigcConfirmed?: boolean } = {},
): Promise<{ ok: boolean; error?: string; warning?: string; platformItemId?: string }> {
  const s = await getSession();
  requireRole(s, 'content.publish'); // 登记发布即对外发布动作，viewer 不得触发
  if (input.aigcConfirmed !== true) return { ok: false, error: '请先确认「AI 使用声明」后再登记' };
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 }, topic: true },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };
  const content = draft.versions[0]?.content ?? '';
  const fromRecommend = !!draft.topicId && ['hot', 'competitor', 'advisor'].includes(draft.topic?.sourceType ?? '');

  // 链接解析失败不阻断登记（用户可能就是想先记一笔），但必须如实告知后果
  const warnings: string[] = [];
  let platformItemId: string | null = null;
  if (input.url && input.url.trim()) {
    const r = resolvePlatformItemId(input.url, draft.platform);
    platformItemId = r.platformItemId;
    if (r.warning) warnings.push(r.warning);
  } else {
    warnings.push('未填发布链接，未解析出作品 ID，这条记录的数据自动回流将不可用（需手动回填）。');
  }

  // 有作品ID → upsert 到 (accountId, platformItemId) 唯一键：若用户先在数据看板填过这条，
  // 就合并到同一条而不是各建一条（否则 learn 基线把同一篇算两次、/data 篇数翻倍）。
  // 无作品ID → 建独立记录并打 needsBackfill：自动回流缺入口，/data 顶部据此提醒补链接。
  const needsBackfill = platformItemId === null;
  if (platformItemId !== null) {
    await prisma.publishRecord.upsert({
      where: { accountId_platformItemId: { accountId: s.accountId, platformItemId } },
      create: {
        accountId: s.accountId,
        topicId: draft.topicId,
        draftId: draft.id,
        platform: draft.platform,
        title: draft.title,
        contentText: content,
        platformItemId,
        needsBackfill: false,
        fromRecommend,
      },
      // 补上登记侧才有的正文/标题/选题归因并解除缺链接标记；不动已回填的 metrics。
      update: {
        topicId: draft.topicId,
        draftId: draft.id,
        title: draft.title,
        contentText: content,
        needsBackfill: false,
        fromRecommend,
      },
    });
  } else {
    await prisma.publishRecord.create({
      data: {
        accountId: s.accountId,
        topicId: draft.topicId,
        draftId: draft.id,
        platform: draft.platform,
        title: draft.title,
        contentText: content,
        platformItemId: null,
        needsBackfill: true,
        fromRecommend,
      },
    });
  }
  await prisma.draft.update({ where: { id: draft.id }, data: { status: 'published' } });
  if (draft.topicId) {
    await prisma.topicIdea.update({ where: { id: draft.topicId }, data: { state: 'published' } }).catch(() => {});
  }
  // 记忆学习：发布即形成偏好/绩效信号，反哺后续推荐与语义召回
  if (draft.topic?.angle) {
    await writeMemory({ workspaceId: s.workspaceId, accountId: s.accountId, type: 'preference', content: `采用并发布了切入角：${draft.topic.angle}`, confidence: 0.4 });
  }
  await writeMemory({ workspaceId: s.workspaceId, accountId: s.accountId, type: 'performance', content: `发布《${draft.title}》到${platformName(draft.platform)}`, confidence: 0.3 });
  revalidatePath('/studio');
  revalidatePath('/data');
  return {
    ok: true,
    platformItemId: platformItemId ?? undefined,
    warning: warnings.length ? warnings.join(' ') : undefined,
  };
}

// 把成稿导出为 PPTX/DOCX（导出内容内置 AIGC 标识）。
// 默认走**本地渲染**（lib/deliverable/registry.ts）：模型只产大纲、排版由确定性代码做，
// 任意模型可用、不出境、版式可复现；租户配了 Claude 渠道时才改走 Anthropic Agent Skills。
// ⚠️ 只开放**能自动校验 AIGC 标识**的 OOXML 格式：PDF 正文是子集字体的字形 ID，
// 无法回环校验标识是否真进了文件，交付无标识文件即违反《标识办法》第四条——
// 与其交付一个「可能违法」的 PDF，不如暂时下线该出口（要重开需先能可靠校验/嵌入中文标识）。
const EXPORTABLE_FORMATS = ['pptx', 'docx'] as const;
type ExportableFormat = (typeof EXPORTABLE_FORMATS)[number];

export async function actExportDeliverable(
  draftId: string,
  format: ExportableFormat,
): Promise<{
  ok: boolean;
  filename?: string;
  dataBase64?: string;
  labelVerified?: boolean; // 标识是否**经过实际校验**
  warning?: string;
  error?: string;
}> {
  const s = await getSession();
  // 导出会真金白银调用 Anthropic Agent Skill 生成交付物，是内容产出动作而非只读浏览，故按 content.create 收口
  requireRole(s, 'content.create');
  // 服务端硬闸：拒绝任何不在白名单里的格式（挡住有人绕过 UI 直接请求 pdf 等不可校验格式）
  if (!(EXPORTABLE_FORMATS as readonly string[]).includes(format)) {
    return { ok: false, error: '该格式暂不支持导出：当前仅支持能自动校验 AIGC 标识的 Word / 演示文稿。' };
  }
  // 三级取 key：env → 租户 BYOK 的 Claude 渠道 → null。
  // 两种格式都有本地零依赖渲染器（docx 见 lib/llm/skills.ts，pptx 见 lib/deliverable/pptx.ts），
  // 故**没有任何格式再依赖 Key**——这里取 key 只用于「有就走排版更丰富的 Skills 路径」。
  const anthropicKey = await resolveExportClaudeKey(s.tenantId);
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };
  const content = draft.versions[0]?.content ?? '';
  if (!content) return { ok: false, error: '草稿暂无内容' };

  // 红线硬闸：engine.ts 的 hasRedline 号称「命中即禁止导出」，而 prisma/seed.ts 的词库定级
  // （把「最好/最优」降级为 warn）正是**建立在这个硬闸存在的前提上**。此前导出路径压根不查，
  // 硬闸只是合规页的一个展示 flag——闸门在这里真正接上，让注释与行为一致。
  const redline = await redlineHits(content);
  if (redline.length) return { ok: false, error: redlineReason(redline) };

  try {
    // AIGC 合规（《标识办法》第四条：下载/复制/导出须确保文件中含显式标识）。
    // 这里在出口层自行兜底，不依赖下游生成路径——标识是法定义务，不能因为别处改了一行就失效。
    // ensureAigcLabel 幂等，重复调用不会叠加标识。
    const labeledContent = ensureAigcLabel(content);
    const produceId = `${s.tenantId}-${draft.id}`;
    let fileData: Buffer;
    let filename: string;

    if (anthropicKey) {
      // 有 Claude Key：走 Anthropic Agent Skill（排版更丰富，docx/pptx 皆可）
      const r = await exportDeliverable({ format, title: draft.title, content: labeledContent, apiKey: anthropicKey });
      if (!r.files.length) return { ok: false, error: '未生成文件（可稍后重试）' };
      const file = await downloadSkillFile(r.files[0].fileId, anthropicKey);
      fileData = file.data;
      filename = file.filename ?? `${draft.title}.${format}`;
    } else {
      // 无 Key：本地渲染。docx 直接排版，pptx 先规划大纲（任意模型；模型不可用时按 Markdown 结构切页）。
      // 显式标识由各渲染器自己写进正文/页脚，隐式标识 docProps 构建时一并打包。
      const local = await renderLocalDeliverable({
        skillId: format,
        tenantId: s.tenantId,
        title: draft.title,
        content: labeledContent,
        produceId,
      });
      fileData = local.data;
      filename = local.filename;
    }

    // 隐式标识注入（《标识办法》第五条）：把 AIGC 元数据写入 OOXML docProps/custom.xml。
    // 本地 docx 已在构建时打好（此处检测到已存在会原样返回）；Skills 产物在此后置注入。
    fileData = injectAigcDocProps(fileData, produceId);

    // 校验回环：标识进没进最终文件，此前**全靠模型听话**，零校验。
    // OOXML（pptx/docx）能真校验 → 没检出就 fail closed，绝不把无标识文件交出去。
    const check = verifyAigcLabelInFile(format, fileData);
    if (check.verifiable && !check.found) {
      return { ok: false, error: `导出已中止：${check.reason}。AIGC 标识是《标识办法》第四条的法定义务，宁可不导出也不能交付无标识文件。请重试，多次失败请换个格式。` };
    }
    return {
      ok: true,
      filename,
      dataBase64: fileData.toString('base64'),
      labelVerified: check.verifiable && check.found,
      warning: check.verifiable ? undefined : `${check.reason}，请下载后自行确认文末的「${AIGC_LABEL}」标识`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 140) };
  }
}

// 导出小红书图文卡（3:4 竖图）。
//
// 与 Word/演示文稿的差别只在最后一步：这里服务端只算**排版**（纯函数，可单测），
// 落成 PNG 交给浏览器 canvas —— 服务器因此不需要 chromium、字体包或任何原生依赖。
// 合规闸（RBAC → 红线 → AIGC 标识）一道不少，且标识是排版代码强制画上的，客户端删不掉。
//
// ⚠️ 图片的显式标识**无法从字节校验**（那是像素，验它要 OCR），所以这里不做也不假装做
// verifyAigcLabelInFile 那种回环；能字节级校验的只有 PNG 的隐式标识（iTXt 分块，见 png-meta.ts）。
export async function actExportCards(draftId: string): Promise<
  | {
      ok: true;
      /** 四套模板各一份绘制指令，切模板在客户端完成（不再调模型、不再等） */
      byTheme: Record<CardThemeKey, Card[]>;
      themes: { key: CardThemeKey; name: string }[];
      defaultTheme: CardThemeKey;
      produceId: string;
      aigcMetadata: string;
      title: string;
    }
  | { ok: false; error: string }
> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 }, account: { select: { name: true } } },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };
  const content = draft.versions[0]?.content ?? '';
  if (!content) return { ok: false, error: '草稿暂无内容' };

  const redline = await redlineHits(content);
  if (redline.length) return { ok: false, error: redlineReason(redline) };

  // 与 pptx 同一份大纲规划：稿子自带结构就按结构切，否则请模型切页（任意模型）
  const produceId = `${s.tenantId}-${draft.id}`;
  const byTheme = await renderCards({
    tenantId: s.tenantId,
    title: draft.title,
    content: ensureAigcLabel(content),
    produceId,
    brand: draft.account?.name,
  });
  return {
    ok: true,
    byTheme,
    themes: CARD_THEME_LIST,
    defaultTheme: DEFAULT_CARD_THEME,
    produceId,
    aigcMetadata: aigcMetadataJson(produceId),
    title: draft.title,
  };
}

// personaCard 库里默认值是 '{}'，readPersona 直接 JSON.parse 后缺 canDo/cantDo 等数组字段，
// personaPromptBlock 会在 .join 上崩——没填过人设的账号一用改写/技能就 500。
// 这里兜底补全缺失字段（根因在 lib/persona.ts 的 readPersona，归属其他分片，暂不动）。
// safePersona / buildSelectionContext / PLATFORM_STYLE 已移到 lib/studio/draft-core.ts，
// 因为流式路由（/api/studio/draft/stream）也要用同一套——'use server' 文件里的东西
// 路由 import 不进来，而各写一份必然分叉。

// ── 算法教练 × 创作工坊：实时诊断 + 一键优化 ──

// 账号在该平台的真实数据基线：发布回流(PublishRecord) + 历史作品(OwnPost) 合并
async function accountBaseline(accountId: string, platform: string): Promise<MetricBaseline> {
  const [records, ownPosts] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId, platform },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { metrics: true },
    }),
    prisma.ownPost.findMany({
      where: { accountId, platform },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { metrics: true },
    }),
  ]);
  const list = [...records, ...ownPosts]
    .map((r) => parseJson<Metrics>(r.metrics, {}))
    .filter((m) => (m.views ?? 0) > 0);
  return buildBaseline(list);
}

// 该平台生效的算法规则（传闻级不进诊断/优化，只在算法页展示）
async function platformSignals(platform: string, take = 5) {
  return prisma.algorithmRule.findMany({
    where: { platform, enabled: true, confidence: { not: 'rumor' } },
    orderBy: { weight: 'desc' },
    take,
  });
}

export type CoachDiagnoseResult = {
  findings: ContentFinding[];
  score: number;
  personalized: boolean;
  sample: number;
  signals: { signal: string; advice: string; confidence: string }[];
  // 人味体检与算法诊断并列返回：两者都是零 LLM 的确定性规则，同一次防抖里算完，
  // 前端一次拿到「这篇能不能跑量」和「这篇像不像人写的」两个答案。
  humanize: HumanizeReport;
  // 编辑器内联标注用的敏感词命中。搭同一次防抖的车返回，不额外发请求——
  // checkText 走的是带缓存的 DFA，相对这次已经要付的往返成本可以忽略。
  // 此前合规命中只在「改写结果」卡里出现：等于写完一整篇才知道哪个词不能用，
  // 而且只告诉你命中了什么，不告诉你在哪儿。
  compliance: { hits: WordHit[]; riskLevel: string };
};

// 实时诊断：确定性规则引擎（零 LLM），编辑器防抖高频调用
export async function actCoachDiagnose(
  text: string,
  platform: string,
  draftTitle?: string,
): Promise<CoachDiagnoseResult | { error: string }> {
  const body = text.trim();
  if (!body) return { error: '正文为空' };
  const s = await getSession();
  requireRole(s, 'content.view'); // 零 LLM 的确定性诊断、不落库，只读级即可
  const [baseline, rules, compliance] = await Promise.all([
    accountBaseline(s.accountId, platform),
    platformSignals(platform),
    checkText(body, platform, s.tenantId),
  ]);
  const diag = analyzeContent(body, platform, { title: draftTitle, baseline });
  const humanize = humanizeReport(body, platform);

  // ⚠️ 所有命中的 start/end 都是相对 **body（trim 过）** 算的，而调用方要拿它去标注**原始 text**。
  // 正文前面有空行时两者会整体错位，高亮就会盖在隔壁的字上。在出口一次性补回前导空白的长度，
  // 让返回的偏移**始终相对调用方传进来的那个字符串**——这是这个接口对外的口径。
  const lead = text.length - text.trimStart().length;
  const shift = <T extends { start: number; end: number }>(h: T): T =>
    lead === 0 ? h : { ...h, start: h.start + lead, end: h.end + lead };

  return {
    findings: diag.findings,
    score: diag.score,
    personalized: diag.personalized,
    sample: baseline.sample,
    signals: rules.map((r) => ({ signal: r.signal, advice: r.advice, confidence: r.confidence })),
    humanize: { ...humanize, hits: humanize.hits.map(shift) },
    compliance: { hits: compliance.hits.map(shift), riskLevel: compliance.riskLevel },
  };
}

// 一键优化：把诊断结论 + 平台算法信号 + 人设 + 账号基线交给 LLM 重写，返回前后分数对比与合规结果
export async function actCoachOptimize(
  text: string,
  platform: string,
  draftTitle?: string,
): Promise<
  | {
      optimized: string;
      before: { score: number };
      after: { score: number; findings: ContentFinding[] };
      compliance: { hits: WordHit[]; riskLevel: string; platform: string };
      mocked: boolean;
      degraded?: boolean;
    }
  | { error: string }
> {
  const body = text.trim();
  if (!body) return { error: '请先输入要优化的正文' };
  const s = await getSession();
  requireRole(s, 'content.create'); // 调 LLM 重写正文，属内容产出
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = safePersona(account?.personaCard);
  const [baseline, rules] = await Promise.all([
    accountBaseline(s.accountId, platform),
    platformSignals(platform),
  ]);
  const before = analyzeContent(body, platform, { title: draftTitle, baseline });
  const problems = before.findings.filter((f) => f.severity !== 'good');
  // 一键优化此前只吃人设一块。它是编辑器里最高频的生成入口，却是全站唯一没有原句样本的路径——
  // 结果是「优化」完的稿子在算法维度更好、在人味维度更差。这里补齐，与初稿/改写同一套上下文。
  const accountCtx = await buildAccountContext({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    account,
    platform,
    blocks: ['fingerprint', 'exemplar', 'catchphrase', 'memory'],
    memoryQuery: body.slice(0, 100),
  });

  const baselineLine =
    baseline.sample > 0
      ? `账号在该平台近 ${baseline.sample} 条真实数据：完播/完读率 ${
          baseline.avgCompletion === null ? '无' : (baseline.avgCompletion * 100).toFixed(1) + '%'
        }，点赞率 ${(baseline.likeRate * 100).toFixed(1)}%，评论率 ${(baseline.commentRate * 100).toFixed(1)}%，收藏率 ${(baseline.collectRate * 100).toFixed(1)}%`
      : '账号暂无该平台回流数据（按通用规则优化）';

  try {
    const res = await llmComplete(
      s.tenantId,
      'diagnosis',
      [
        {
          role: 'system',
          content: [
            `你是「${platformName(platform)}」的平台算法教练兼资深内容编辑。请针对下面逐条诊断出的问题优化正文，保留原有信息与人设语气，不虚构事实、不加入夸大承诺。`,
            `该平台核心算法信号（按权重）：\n${rules.map((r) => `- ${r.signal}：${r.advice}`).join('\n')}`,
            `本篇诊断出的待修复问题：\n${problems.map((f) => `- [${f.dimension}] ${f.finding} → ${f.advice}`).join('\n') || '- 无明显问题，做整体润色即可'}`,
            baselineLine,
            personaPromptBlock(persona),
            accountCtx.text,
            aiFlavorBanBlock(),
            '只输出优化后的正文，不要解释、不要标注。',
          ].join('\n\n'),
        },
        { role: 'user', content: body },
      ],
      { temperature: 0.6 },
    );

    const optimized = res.text.trim();
    const after = analyzeContent(optimized, platform, { title: draftTitle, baseline });
    const compliance = await checkText(optimized, platform, s.tenantId);
    return {
      optimized,
      before: { score: before.score },
      after: { score: after.score, findings: after.findings },
      compliance,
      mocked: res.mocked,
      degraded: res.degraded,
    };
  } catch (e) {
    // 配额用尽 → 结构化返回，前端 Rewriter 的 'error' in r 分支红字展示自救文案；其余异常抛给 boundary。
    if (isDesignedRejection(e)) return { error: e.message };
    throw e;
  }
}

// ── 创作工坊 server actions ──

// 各平台改写风格提示词
// 多平台改写：按目标平台风格改写正文，并同步跑合规检测
export async function actRewrite(
  text: string,
  platform: string,
): Promise<{ rewritten: string; compliance: { hits: WordHit[]; riskLevel: string; platform: string }; mocked: boolean; degraded?: boolean } | { error: string }> {
  const body = text.trim();
  if (!body) return { error: '请先输入要改写的正文' };
  const s = await getSession();
  requireRole(s, 'content.create'); // 调 LLM 改写正文，属内容产出
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = safePersona(account?.personaCard);

  const style = PLATFORM_STYLE[platform] ?? '按该平台主流内容形态改写。';
  // 与算法教练规则库对齐：改写时同步注入该平台 top 算法信号，避免风格提示词与规则库双源漂移
  const rules = await platformSignals(platform, 3);
  const ruleBlock = rules.length
    ? `\n该平台算法要点（改写时兼顾）：\n${rules.map((r) => `- ${r.advice}`).join('\n')}`
    : '';
  // 账号上下文：风格指纹 + **他自己写的原句样本** + 口头禅 + 素材 + 记忆（原句样本是去 AI 味的主力，见 account-context.ts）
  const accountCtx = await buildAccountContext({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    account,
    platform,
    blocks: ['fingerprint', 'exemplar', 'catchphrase', 'material', 'memory'],
    memoryQuery: body.slice(0, 100),
  });
  try {
    const res = await llmComplete(s.tenantId, 'generation', [
      {
        role: 'system',
        content: [
          `你是资深内容改写编辑。请把用户提供的正文改写为适配「${platformName(platform)}」的版本。`,
          `目标平台风格要求：${style}${ruleBlock}`,
          personaPromptBlock(persona),
          accountCtx.text,
          aiFlavorBanBlock(),
          '只输出改写后的正文，不要解释、不要加标题标注。',
        ].filter(Boolean).join('\n\n'),
      },
      { role: 'user', content: body },
    ], { temperature: 0.7 });

    const rewritten = res.text.trim();
    const compliance = await checkText(rewritten, platform, s.tenantId);
    return { rewritten, compliance, mocked: res.mocked, degraded: res.degraded };
  } catch (e) {
    // 配额用尽在这里转结构化返回（前端 Rewriter 的 'error' in r 分支原样红字展示自救文案）；
    // 权限不足由上面的 requireRole 直接抛（保留既有守卫契约），真 bug 继续抛给 boundary。
    if (isDesignedRejection(e)) return { error: e.message };
    throw e;
  }
}

// AI 生成初稿：基于选中草稿的选题 / 账号持有的选题生成一版内容并落 draftVersion。
//
// 【深度模式 deep=true】两段式：先只列要点大纲（信息层），再照着他自己的原句样本写成成稿（表达层）。
// 拆开的理由与两条硬纪律见 lib/studio/two-stage.ts。**代价是两次真实调用**，所以它必须由用户显式勾选，
// 绝不做默认——替用户悄悄花两份配额，比 AI 味本身更糟。
export async function actDraft(
  draftId: string | null,
  opts?: { deep?: boolean; topicId?: string },
): Promise<{
  ok: boolean;
  draftId?: string;
  seq?: number;
  error?: string;
  /** 实际跑了几段（深度模式=2）；第二段失败时会回落成 1 并把大纲存下来 */
  stages?: 1 | 2;
  warning?: string;
  mocked?: boolean;
  degraded?: boolean;
}> {
  const s = await getSession();
  requireRole(s, 'content.create'); // 生成初稿并落 draft/draftVersion

  // 定位草稿 + 装上下文都走 lib/studio/draft-core（流式路由用的是同一套，避免两条路分叉）。
  // W-2 上下文含：风格指纹（被验证的擅长方向）+ 原句样本 + 素材库（真实经历）+ 长期记忆（改稿学到的口味）。
  const resolved = await resolveDraftTarget({ accountId: s.accountId, draftId, topicId: opts?.topicId });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const target = resolved.target;
  const persona = target.persona;
  const platform = target.platform;
  const topicTitle = target.topicTitle;
  const topicAngle = target.topicAngle;
  const draft = { id: target.draftId };
  const ctx = await loadDraftContext({ workspaceId: s.workspaceId, accountId: s.accountId, target });
  const accountCtx = ctx.accountCtx;
  const selectionCtx = ctx.selectionCtx;

  try {
    let content = '';
    let stages: 1 | 2 = 1;
    let warning: string | undefined;
    let label = '';
    let mocked = false;
    let degraded = false;

    if (opts?.deep) {
      // ── 第一段：只出信息骨架 ──
      const outlineRes = await llmComplete(s.tenantId, 'generation', [
        {
          role: 'system',
          content: buildOutlinePrompt({
            platformName: platformName(platform),
            topicTitle,
            topicAngle,
            contextBlock: [personaPromptBlock(persona), accountCtx.text].filter(Boolean).join('\n\n'),
            selectionBlock: selectionCtx,
          }),
        },
        { role: 'user', content: `选题：${topicTitle}\n差异化切入角：${topicAngle || '（自行确定）'}` },
      ], { temperature: 0.5 }); // 想清楚说什么，温度低一点；表达那段才需要放开

      const outline = cleanOutline(outlineRes.text);
      if (!outline) return { ok: false, error: '深度模式第一步（要点大纲）没返回内容，请重试' };
      mocked = !!outlineRes.mocked;
      degraded = !!outlineRes.degraded;

      // ── 第二段：只管表达 ──
      // 这里**只给大纲**，不再给素材原文：让它有原始素材可翻，就等于允许它「补充细节」，
      // 补出来的细节就是编的（见 two-stage.ts 纪律①）。语感块照给，那正是这一段的活。
      try {
        const voiceRes = await llmComplete(s.tenantId, 'generation', [
          {
            role: 'system',
            content: buildVoicePrompt({
              platformName: platformName(platform),
              outline,
              personaBlock: personaPromptBlock(persona),
              voiceBlock: [accountCtx.parts.exemplar, accountCtx.parts.catchphrase, accountCtx.parts.fingerprint]
                .filter(Boolean).join('\n\n'),
              styleHint: PLATFORM_STYLE[platform],
              banBlock: aiFlavorBanBlock(),
            }),
          },
          { role: 'user', content: outline },
        ], { temperature: 0.85 });

        content = stripStageLabels(voiceRes.text);
        stages = 2;
        mocked = mocked || !!voiceRes.mocked;
        degraded = degraded || !!voiceRes.degraded;
        label = `深度模式两段式生成（要点大纲 → 按你的语感成稿）`;
        // 第二段只该改说法不该添事实：多出来的数字如实告警（与去 AI 味同一道闸）
        // 基线 = 模型**被合法喂过**的一切：选题 + 账号上下文（素材/样本/基线）+ 大纲。
        // 只有这三处都找不到的数字，才算它自己编的。
        const drift = checkFactDrift(`${topicTitle} ${topicAngle} ${accountCtx.text} ${outline}`, content);
        if (drift.warning) warning = drift.warning;
      } catch (inner) {
        if (!isDesignedRejection(inner)) throw inner;
        // 第二段被拒（多半是配额刚好在两段之间用尽）：第一段的钱已经花了，
        // 与其吞掉，不如把大纲存成一版——用户至少拿到了骨架，可以自己写或稍后重试。
        content = outline;
        stages = 1;
        label = '深度模式第一步：要点大纲（第二步未完成，可稍后再点一次生成初稿）';
        warning = `第二步没跑成：${(inner as Error).message}`;
      }
    } else {
      // prompt 由 draft-core 拼（流式路由用同一个函数），这里只负责调用与记账口径
      const { messages, temperature } = buildDraftMessages(target, ctx);
      const res = await llmComplete(s.tenantId, 'generation', messages, { temperature });
      content = res.text.trim();
      mocked = !!res.mocked;
      degraded = !!res.degraded;
    }

    if (!content) return { ok: false, error: 'AI 没返回内容，请重试' };
    const { seq } = await persistDraftVersion({
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      draftId: draft.id,
      topicTitle,
      content,
      label,
    });

    revalidatePath('/studio');
    return { ok: true, draftId: draft.id, seq, stages, warning, mocked, degraded };
  } catch (e) {
    // 配额用尽 → 结构化返回（ActionButton 的 r.ok===false 分支红字展示）；其余异常抛给 boundary。
    if (isDesignedRejection(e)) return { ok: false, error: e.message };
    throw e;
  }
}

// 采纳改写结果：把改写后的正文落成一版 human 终稿（体现「AI 初稿 vs 人工终稿 diff = 偏好信号」）
export async function actSaveHumanVersion(draftId: string, content: string): Promise<{ ok: boolean; seq?: number; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create'); // 落一版新终稿，写操作
  const body = content.trim();
  if (!body) return { ok: false, error: '内容为空' };
  const draft = await prisma.draft.findFirst({ where: { id: draftId, accountId: s.accountId } });
  if (!draft) return { ok: false, error: '未找到草稿' };
  const last = await prisma.draftVersion.findFirst({ where: { draftId }, orderBy: { seq: 'desc' } });
  const seq = (last?.seq ?? 0) + 1;
  const diff = last ? diffSummary(last.content, body) : '人工终稿';
  await prisma.draftVersion.create({
    data: { draftId, seq, authorType: 'human', content: body, diffFromPrev: diff },
  });
  await prisma.draft.update({ where: { id: draftId }, data: { updatedAt: new Date() } });
  // 偏好学习：把「AI 初稿 vs 你改后的终稿」整体交给记忆模块提炼具体口味（改了什么语气、
  // 删了什么话术），不再只记一句字数增减——那种记忆信息量趋零。
  // recordDiffPreference 契约上自兜底不 throw，这里再 catch 一层：学习失败绝不阻断采纳。
  const aiBase = await prisma.draftVersion.findFirst({
    where: { draftId, authorType: 'ai' },
    orderBy: { seq: 'desc' },
  });
  if (aiBase) {
    await recordDiffPreference({
      tenantId: s.tenantId,
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      aiDraft: aiBase.content,
      humanFinal: body,
    }).catch(() => {});
  }
  revalidatePath('/studio');
  return { ok: true, seq };
}

// 粗粒度 diff 摘要（字数增减）。只给版本时间线的 UI 展示用；
// 偏好学习已改走 recordDiffPreference（语义级），别把这个字数摘要再写进记忆。
function diffSummary(prev: string, next: string): string {
  const delta = next.length - prev.length;
  const sign = delta > 0 ? `扩写 +${delta}` : delta < 0 ? `精简 ${delta}` : '等量重写';
  return `人工终稿：${sign} 字`;
}

// ── 技能一键成品：技能中心装好的排版/生成技能，在工坊对当前草稿一键运行 ──

// runSkill 的返回契约（实现在 lib/skills，配额/合规/AIGC 出口与其他生成路径同一套闸门）
export type RunSkillActionResult =
  | {
      ok: true;
      output: string;
      outputKind: 'markdown' | 'html' | 'text' | 'image';
      mocked: boolean;
      skillName: string;
      riskLevel: string;
      hits: WordHit[];
      /** 本次技能吃的是第几版正文——UI 必须显示，取错版是不会报错的那种错 */
      sourceSeq: number;
      /** 仅 image 技能填：生成的封面图（火山直链，约 24h 有效）+ 抽到的封面标题/副标题 */
      images?: { url: string }[];
      coverMeta?: { mainTitle: string; subTitle?: string };
    }
  | { ok: false; error: string };

// 对草稿正文运行一个已安装技能。
//
// 取稿规则：**永远取最新一版**（versions[0]，seq 最大）。
// 这里原本是「优先最新的人工版，没有才用最新版」，听起来体贴，实际是个静默 bug：
// 用户刚点完「按会诊意见改一版」（作者记为 ai）再点技能，技能吃的还是那份更早的人工版，
// 刚改的内容被无声丢掉。用户不会来报 bug，只会觉得这产品有点不准。
// 现在改成取最新版，并把用到的版本号回给 UI —— 取错版是不会报错的那种错，必须让人看得见。
export async function actRunSkill(
  draftId: string,
  skillId: string,
  brief?: SkillBrief,
  cover?: CoverRunOptions,
): Promise<RunSkillActionResult> {
  const s = await getSession();
  requireRole(s, 'content.create'); // 技能运行走 LLM 网关产出内容
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' } } },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };
  const source = draft.versions[0];
  if (!source?.content) return { ok: false, error: '这份草稿还没有正文，先点「AI 生成初稿」或改写一版内容' };
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = safePersona(account?.personaCard);
  // 把账号完整上下文（指纹/原句样本/口头禅/素材/记忆）作为 {{context}} 供技能模板选用
  const accountCtx = await buildAccountContext({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    account,
    platform: brief?.platform || draft.platform,
    blocks: ['fingerprint', 'exemplar', 'catchphrase', 'material', 'memory'],
    memoryQuery: draft.title,
  });

  // 参数卡点名的素材：只取本账号的，防止有人塞别家 id 把别人的素材读出来
  const picked = brief?.materialIds?.length
    ? await prisma.material.findMany({
        where: { id: { in: brief.materialIds.slice(0, 8) }, accountId: s.accountId },
        select: { type: true, content: true },
      })
    : [];

  // 封面技能的参考图（人像/产品照）在这里透传给生图管线；截图/data:URI 不外链（见 lib/llm/image.ts）。
  const r = await runSkill({
    tenantId: s.tenantId,
    skillId,
    content: source.content,
    title: draft.title,
    persona: personaPromptBlock(persona),
    context: accountCtx.text,
    brief: buildSkillBriefBlock(brief, picked),
    cover,
  });
  if (!r.ok) return r;
  return {
    ok: true,
    output: r.output,
    // lib/skills 的 RunSkillResult 把这两个字段声明得较宽（string / unknown[]），
    // 实际取值就是四种输出形态与 checkText 的命中结构，这里收窄给 UI 用
    outputKind: r.outputKind as 'markdown' | 'html' | 'text' | 'image',
    mocked: r.mocked,
    skillName: r.skillName,
    riskLevel: r.riskLevel,
    hits: r.hits as WordHit[],
    sourceSeq: source.seq,
    images: r.images,
    coverMeta: r.coverMeta ? { mainTitle: r.coverMeta.mainTitle, subTitle: r.coverMeta.subTitle } : undefined,
  };
}

// 下载封面：服务端把火山直链的图片字节取回来交给浏览器下载。
//
// 为什么走服务端代理而不是前端直接 <a download>：① 火山直链跨源，浏览器 <a download> 对跨源
// 多半只会导航打开而不是下载；② 借这一跳给 PNG 注入 **AIGC 隐式标识**（iTXt，见 png-meta.ts），
// 与图文卡 PNG 同一套《标识办法》第五条落地。显式标识已由即梦「AI生成」水印承担（第四条）。
//
// ⚠️ 隐式标识只对 PNG 有效：即梦返回的多为 JPEG，此时无法字节级注入隐式标识——如实用 warning 告知，
// 不假装做了（与 PDF 导出“无法校验就不假装”同一姿态）。显式水印仍在图上，合规主线不塌。
export async function actDownloadCover(
  imageUrl: string,
): Promise<
  | { ok: true; dataBase64: string; mime: string; filename: string; aigcEmbedded: boolean; warning?: string }
  | { ok: false; error: string }
> {
  const s = await getSession();
  requireRole(s, 'content.create');
  // SSRF 闸：这个 URL 是前端回传的，若不限制，一个已登录用户就能借服务端去拉任意内网地址并拿回
  // base64。只放行 https + 火山对象存储/CDN 的图片域名（即梦生图的产物就落在这些域）。
  // ⚠️ 待真机校准：拿到 ARK Key 后确认即梦返回的真实图片域名，不在名单里就补进 ALLOWED_IMAGE_HOSTS。
  const ALLOWED_IMAGE_HOSTS = ['.volces.com', '.volccdn.com', '.byteimg.com', '.bytedance.com'];
  let host = '';
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== 'https:') return { ok: false, error: '无效的图片地址' };
    host = u.hostname.toLowerCase();
  } catch {
    return { ok: false, error: '无效的图片地址' };
  }
  if (!ALLOWED_IMAGE_HOSTS.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    return { ok: false, error: '只支持下载本站生成的封面图' };
  }
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, error: `取图失败 ${res.status}` };
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    let bytes = new Uint8Array(await res.arrayBuffer());
    let aigcEmbedded = false;
    let warning: string | undefined;
    if (mime === 'image/png') {
      bytes = injectPngAigcMetadata(bytes, aigcMetadataJson(`${s.tenantId}-cover`));
      aigcEmbedded = true;
    } else {
      warning = '本图为 JPEG，隐式 AIGC 标识无法写入；图上已有「AI生成」水印作为显式标识。';
    }
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    return {
      ok: true,
      dataBase64: Buffer.from(bytes).toString('base64'),
      mime,
      filename: `小红书封面.${ext}`,
      aigcEmbedded,
      warning,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 140) };
  }
}

// 把技能产出存成该草稿的一个新版本（AI 作者、seq 顺延），方便直接走登记发布/导出流程
export async function actSkillSaveVersion(
  draftId: string,
  content: string,
  skillName: string,
): Promise<{ ok: boolean; seq?: number; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const body = content.trim();
  if (!body) return { ok: false, error: '内容为空' };
  const draft = await prisma.draft.findFirst({ where: { id: draftId, accountId: s.accountId } });
  if (!draft) return { ok: false, error: '未找到草稿' };
  const last = await prisma.draftVersion.findFirst({ where: { draftId }, orderBy: { seq: 'desc' } });
  const seq = (last?.seq ?? 0) + 1;
  await prisma.draftVersion.create({
    data: { draftId, seq, authorType: 'ai', content: body, diffFromPrev: `技能「${skillName}」生成的成品` },
  });
  await prisma.draft.update({ where: { id: draftId }, data: { updatedAt: new Date() } });
  revalidatePath('/studio');
  return { ok: true, seq };
}

// W-6 草稿会诊落地：把本篇草稿会诊里**已采纳**的修改意见汇总成一次定向改写，落成新版本。
//
// 三条克制：
// ① 只吃 adopted=true 的意见——没被用户认可的意见不该动正文（人物提议、用户决定，与人设那条约定同源）；
// ② 定向修改而非重写：prompt 明确要求保留原结构与人设语气，只落实这些点，避免一轮会诊把稿子洗成 AI 腔；
// ③ 落库仍走 draftVersion（AI 作者、seq 顺延），原版本一条不动——用户随时能对比回退。
export async function actReviseByAdvice(
  draftId: string,
): Promise<{ ok: boolean; seq?: number; applied?: number; mocked?: boolean; degraded?: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
  });
  if (!draft) return { ok: false, error: '未找到草稿' };
  const source = draft.versions[0];
  if (!source?.content?.trim()) return { ok: false, error: '这篇草稿还没有正文' };

  const opinions = await prisma.advisorOpinion.findMany({
    where: { adopted: true, session: { accountId: s.accountId, draftRef: draftId } },
    orderBy: { createdAt: 'asc' },
    take: 12,
  });
  if (opinions.length === 0) {
    return { ok: false, error: '还没有采纳任何会诊意见——先在智囊团里逐条采纳，再回来改稿' };
  }

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = safePersona(account?.personaCard);
  const accountCtx = await buildAccountContext({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    account,
    platform: draft.platform,
    blocks: ['fingerprint', 'exemplar', 'catchphrase', 'material', 'memory'],
    memoryQuery: draft.title,
  });
  const adviceBlock = opinions
    .map((o, i) => `${i + 1}. 【${o.personaName}】${o.suggestion}${o.rationale ? `（理由：${o.rationale}）` : ''}`)
    .join('\n');

  try {
    const res = await llmComplete(s.tenantId, 'generation', [
      {
        role: 'system',
        content: [
          `你是账号的内容编辑，正在按智囊团会诊结论修改一篇「${platformName(draft.platform)}」稿件。`,
          personaPromptBlock(persona),
          accountCtx.text,
          '【必须落实的修改意见（均已被账号主采纳）】\n' + adviceBlock,
          '要求：保留原文结构、事实与人设语气，只针对上述意见做定向修改；不要新增未经核实的数据或案例；只输出修改后的完整正文。',
        ].filter(Boolean).join('\n\n'),
      },
      { role: 'user', content: source.content },
    ], { temperature: 0.6 });

    const revised = res.text.trim();
    if (!revised) return { ok: false, error: 'AI 未返回内容，请重试' };
    const seq = source.seq + 1;
    await prisma.draftVersion.create({
      data: {
        draftId,
        seq,
        authorType: 'ai',
        content: revised,
        diffFromPrev: `按智囊团会诊采纳的 ${opinions.length} 条意见定向修改（第${seq}版）`,
      },
    });
    await prisma.draft.update({ where: { id: draftId }, data: { status: 'editing', updatedAt: new Date() } });
    revalidatePath('/studio');
    return { ok: true, seq, applied: opinions.length, mocked: res.mocked, degraded: res.degraded };
  } catch (e) {
    if (isDesignedRejection(e)) return { ok: false, error: (e as Error).message };
    throw e;
  }
}

// ─────────────────────────── 自由起稿（选题之外的入口）───────────────────────────
//
// 【为什么补这个】此前全站只有一个建草稿的入口：actDraft，且**必须先有选题**。
// 于是最高频的两种真实情形没有落点：「我今天就想写这件事」和「我已经写了一稿，帮我打磨」。
// 用户只能在改写框里敲完、复制走人——脱离系统 = 不留版本、不产生偏好 diff、不进发布登记、
// 数据永远回不来。产品最引以为傲的「越用越懂你」，恰恰漏在了最上游的那个口子上。
//
// 三种模式：
//   blank  空白稿：只建壳，用户自己往里写
//   paste  粘一段已有的：第一版记为 human ——这同时是**风格原句样本的来源**（见 loadExemplars）
//   idea   一句话想法：先建壳，再按账号上下文生成一版初稿（走与 actDraft 同一套上下文与禁令）
export type CreateDraftMode = 'blank' | 'paste' | 'idea';

export async function actCreateDraft(input: {
  mode: CreateDraftMode;
  title?: string;
  platform?: string;
  text?: string;
  /** 仅 idea 模式有效：两段式深度生成（消耗 2 次额度，见 lib/studio/two-stage.ts） */
  deep?: boolean;
}): Promise<{ ok: boolean; draftId?: string; mocked?: boolean; degraded?: boolean; error?: string; stages?: 1 | 2; warning?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  if (!account) return { ok: false, error: '未找到账号' };
  const persona = safePersona(account.personaCard);

  const body = (input.text ?? '').trim();
  const platform = (input.platform || (persona.platforms[0] as string) || 'douyin').trim();
  if (input.mode !== 'blank' && !body) {
    return { ok: false, error: input.mode === 'paste' ? '把你的正文粘进来再创建' : '先写下你的想法（一句话就行）' };
  }

  // 标题：用户填了就用；粘稿取首行；想法模式先用那句话，生成初稿后不改标题（标题矩阵是另一件事）
  const firstLine = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const title = ((input.title ?? '').trim() || firstLine || '未命名草稿').slice(0, 60);

  const draft = await prisma.draft.create({
    data: { accountId: s.accountId, title, platform, status: 'editing' },
  });

  if (input.mode === 'paste') {
    await prisma.draftVersion.create({
      data: {
        draftId: draft.id,
        seq: 1,
        authorType: 'human', // 是他自己写的，绝不能记成 ai——记错了会污染「AI 初稿 vs 人工终稿」的偏好学习
        content: body,
        diffFromPrev: '我自己写的原稿（导入）',
      },
    });
    revalidatePath('/studio');
    return { ok: true, draftId: draft.id };
  }

  if (input.mode === 'blank') {
    revalidatePath('/studio');
    return { ok: true, draftId: draft.id };
  }

  // idea：按账号上下文把一句话展开成初稿
  const accountCtx = await buildAccountContext({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    account,
    platform,
    blocks: ['fingerprint', 'exemplar', 'catchphrase', 'material', 'memory'],
    memoryQuery: body.slice(0, 100),
  });
  try {
    // 深度模式：与 actDraft 同一套两段式（信息层 → 表达层），只是议题来自用户那句话而不是选题。
    if (input.deep) {
      const outlineRes = await llmComplete(s.tenantId, 'generation', [
        {
          role: 'system',
          content: buildOutlinePrompt({
            platformName: platformName(platform),
            topicTitle: body.slice(0, 200),
            contextBlock: [personaPromptBlock(persona), accountCtx.text].filter(Boolean).join('\n\n'),
          }),
        },
        { role: 'user', content: `我的想法：${body.slice(0, 1500)}` },
      ], { temperature: 0.5 });
      const outline = cleanOutline(outlineRes.text);
      if (!outline) return { ok: true, draftId: draft.id, error: '草稿已建好，但第一步（要点大纲）没返回内容' };

      try {
        const voiceRes = await llmComplete(s.tenantId, 'generation', [
          {
            role: 'system',
            content: buildVoicePrompt({
              platformName: platformName(platform),
              outline,
              personaBlock: personaPromptBlock(persona),
              voiceBlock: [accountCtx.parts.exemplar, accountCtx.parts.catchphrase, accountCtx.parts.fingerprint]
                .filter(Boolean).join('\n\n'),
              styleHint: PLATFORM_STYLE[platform],
              banBlock: aiFlavorBanBlock(),
            }),
          },
          { role: 'user', content: outline },
        ], { temperature: 0.85 });
        const deepContent = stripStageLabels(voiceRes.text);
        if (deepContent) {
          await prisma.draftVersion.create({
            data: {
              draftId: draft.id, seq: 1, authorType: 'ai', content: deepContent,
              diffFromPrev: '深度模式两段式生成（要点大纲 → 按你的语感成稿）',
            },
          });
        }
        const drift = checkFactDrift(`${body} ${accountCtx.text} ${outline}`, deepContent);
        revalidatePath('/studio');
        return { ok: true, draftId: draft.id, mocked: voiceRes.mocked, stages: 2, warning: drift.warning || undefined };
      } catch (inner) {
        if (!isDesignedRejection(inner)) throw inner;
        // 第二段被拒：第一段的钱已经花了，把大纲存下来，别让用户既掉额度又两手空空
        await prisma.draftVersion.create({
          data: {
            draftId: draft.id, seq: 1, authorType: 'ai', content: outline,
            diffFromPrev: '深度模式第一步：要点大纲（第二步未完成）',
          },
        });
        revalidatePath('/studio');
        return { ok: true, draftId: draft.id, stages: 1, warning: `第二步没跑成：${(inner as Error).message}` };
      }
    }

    const res = await llmComplete(s.tenantId, 'generation', [
      {
        role: 'system',
        content: [
          `你是账号的内容创作助手，为「${platformName(platform)}」平台把一个想法写成一篇初稿。`,
          personaPromptBlock(persona),
          accountCtx.text,
          aiFlavorBanBlock(),
          '要求：结构完整（钩子-正文-引导），只用用户想法里已有的事实和素材库里的真实经历，**不要编造数据、案例或身份**；说不清的地方宁可留空也不要编。',
          '语感要求：句子长短要有起伏，不要句句工整、段段等长。只输出正文。',
        ].filter(Boolean).join('\n\n'),
      },
      { role: 'user', content: `我的想法：${body.slice(0, 1500)}` },
    ], { temperature: 0.8 });

    const content = res.text.trim();
    if (content) {
      await prisma.draftVersion.create({
        data: { draftId: draft.id, seq: 1, authorType: 'ai', content, diffFromPrev: '按你的一句话想法生成的首版初稿' },
      });
    }
    revalidatePath('/studio');
    return { ok: true, draftId: draft.id, mocked: res.mocked, degraded: res.degraded, stages: 1 };
  } catch (e) {
    // 生成失败不回滚草稿：壳已经建好了，用户可以自己往里写，比「什么都没发生」强。
    if (isDesignedRejection(e)) return { ok: true, draftId: draft.id, error: `草稿已建好，但初稿没生成成功：${e.message}` };
    throw e;
  }
}

// ─────────────────────────── 一键去 AI 味 ───────────────────────────
//
// 与「教练一键优化」的分工：教练优化的是**能不能跑量**（钩子/篇幅/结构/CTA），
// 这里改的是**像不像人写的**（套话/节奏/对仗/碎句）。两者的目标偶尔冲突——
// 算法教练会鼓励标准化的钩子与 CTA，而那正是 AI 腔的重灾区。所以分成两个按钮、
// 各自给分，让用户自己决定这一版要哪个，而不是在一次重写里偷偷替他权衡。
export type DeflavorResult =
  | {
      rewritten: string;
      before: HumanizeReport;
      after: HumanizeReport;
      compliance: { hits: WordHit[]; riskLevel: string; platform: string };
      mocked: boolean;
      degraded?: boolean;
      /** 有没有拿到他自己的原句样本——没有的话效果会打折，必须如实说 */
      hasExemplar: boolean;
      /** 事实漂移告警：改写后冒出原文没有的数字（真机上抓到过，见 lib/humanize/factcheck.ts） */
      driftWarning?: string;
    }
  | { error: string };

export async function actDeflavor(text: string, platform: string): Promise<DeflavorResult> {
  const body = text.trim();
  if (!body) return { error: '请先输入要处理的正文' };
  const s = await getSession();
  requireRole(s, 'content.create');
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = safePersona(account?.personaCard);

  const before = humanizeReport(body, platform);
  const accountCtx = await buildAccountContext({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    account,
    platform,
    blocks: ['exemplar', 'catchphrase', 'fingerprint'],
    maxChars: 4000,
  });
  const hasExemplar = !!accountCtx.parts.exemplar;

  try {
    const res = await llmComplete(s.tenantId, 'generation', [
      {
        role: 'system',
        content: [
          '你的任务是把一段带着「AI 腔」的稿子改成像真人写的。**信息一个不许少、一个不许加**——不是重写，是换一种说法。',
          personaPromptBlock(persona),
          accountCtx.text,
          humanizeProblemBlock(before),
          aiFlavorBanBlock(),
          [
            '【怎么改】',
            '- 把套话整句删掉，或换成具体的人、事、数字、时间；换个同义套话等于没改；',
            '- 打散节奏：让几句话变短，短到只剩半句也行；再让一两句放长。不要句句等长；',
            '- 拆掉排比对仗，留最有力的一组就够；',
            '- 段落不要等长，允许一段只有一句话；',
            '- 保留原文的事实、数据、结论和结构顺序，不要新增任何未经核实的内容。',
          ].join('\n'),
          // 这一句必须放在最后（也就是紧挨着模型开始写的位置）：真机上跑出来过一次
          // 「模型把风格样本里的『只留五个客户』『涨了两成』搬进了另一篇稿子」——
          // 样本块里那句「不要抄内容」隔得太远，题材一相近就压不住。
          '最后确认一遍：改好的正文里出现的每一个事实、数字、时间、人物、经历，都必须能在**原文**里找到。上面那些风格样本是别的稿子，只借语感，一个字的内容都不许搬。',
          '只输出改好的正文，不要解释、不要列出你改了什么。',
        ].filter(Boolean).join('\n\n'),
      },
      { role: 'user', content: body },
    ], { temperature: 0.7 });

    const rewritten = res.text.trim();
    if (!rewritten) return { error: '模型没有返回内容，请重试' };
    const after = humanizeReport(rewritten, platform);
    const compliance = await checkText(rewritten, platform, s.tenantId);
    const drift = checkFactDrift(body, rewritten);
    return { rewritten, before, after, compliance, mocked: res.mocked, degraded: res.degraded, hasExemplar, driftWarning: drift.warning || undefined };
  } catch (e) {
    if (isDesignedRejection(e)) return { error: e.message };
    throw e;
  }
}

// ─────────────────────────── 标题矩阵 + 封面建议 ───────────────────────────
//
// 产品此前只产出正文：算法教练在诊断「封面标题够不够勾」、智囊团有专门看标题封面的席位，
// 而这两样东西产品自己不生产。中文平台上标题与封面至少决定一半的点击——正文写得再好，
// 没人点开等于没写。
export type TitleOption = TitleCandidate & { diagnosis: TitleDiagnosis };

export type TitleMatrixResult =
  | {
      ok: true;
      titles: TitleOption[];
      cover: CoverSuggestion | null;
      mocked: boolean;
      degraded?: boolean;
      /** 因命中合规红线被丢弃的条数（红线语义与导出硬闸一致：不给用户看，更不给复制） */
      dropped: number;
    }
  | { ok: false; error: string };

export async function actTitleMatrix(draftId: string): Promise<TitleMatrixResult> {
  const s = await getSession();
  requireRole(s, 'content.create'); // 走 LLM，属内容产出
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };
  const content = draft.versions[0]?.content?.trim() ?? '';
  if (!content) return { ok: false, error: '这篇草稿还没有正文，先写一版再来起标题' };

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const accountCtx = await buildAccountContext({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    account,
    platform: draft.platform,
    blocks: ['persona', 'fingerprint', 'audience'],
    maxChars: 2000,
  });

  try {
    const res = await llmComplete(
      s.tenantId,
      'generation',
      [
        { role: 'system', content: '你是资深新媒体主编，最擅长起标题。严格按要求输出 JSON。' },
        {
          role: 'user',
          content: buildTitlePrompt({
            platform: draft.platform,
            draftTitle: draft.title,
            content,
            contextBlock: accountCtx.text,
          }),
        },
      ],
      { temperature: 0.9, json: true },
    );

    const parsed = parseTitleMatrix(res.text);
    if (parsed.titles.length === 0) {
      return {
        ok: false,
        error: res.mocked
          ? '当前是演示模式（未接入真实模型），标题矩阵需要真实模型才能生成——到「模型与设置」配置后重试。'
          : '模型这次没返回可用的标题，请重试。',
      };
    }

    // 红线硬闸：命中红线的标题直接丢弃，不展示也不给复制（与导出硬闸同语义）。
    const kept: TitleOption[] = [];
    let dropped = 0;
    for (const t of parsed.titles) {
      const redline = await redlineHits(t.title);
      if (redline.length) {
        dropped++;
        continue;
      }
      kept.push({ ...t, diagnosis: diagnoseTitle(t.title, draft.platform) });
    }
    if (kept.length === 0) {
      return { ok: false, error: '生成的标题全部命中合规红线，已全部拦下。请重试或换个角度。' };
    }
    return { ok: true, titles: kept, cover: parsed.cover, mocked: res.mocked, degraded: res.degraded, dropped };
  } catch (e) {
    if (isDesignedRejection(e)) return { ok: false, error: (e as Error).message };
    throw e;
  }
}

// 采纳某个标题：更新草稿标题（正文不动）
export async function actAdoptTitle(draftId: string, title: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const t = title.trim();
  if (!t) return { ok: false, error: '标题为空' };
  const redline = await redlineHits(t);
  if (redline.length) return { ok: false, error: redlineReason(redline) };
  const draft = await prisma.draft.findFirst({ where: { id: draftId, accountId: s.accountId } });
  if (!draft) return { ok: false, error: '草稿不存在' };
  await prisma.draft.update({ where: { id: draft.id }, data: { title: t.slice(0, 60) } });
  revalidatePath('/studio');
  return { ok: true };
}

// ─────────────────────────── 一稿多平台派生 ───────────────────────────
//
// 兑现「跨平台内容作战室」在创作端的那一半：一份稿子 → N 个平台各一份**独立草稿**
// （各自版本线、各自登记发布、各自回流），彼此用 parentDraftId 认亲，
// 于是「同一篇内容在哪个平台跑赢了」终于算得出来（见 lib/studio/family.ts）。
//
// 三条克制：
// ① 一次最多 3 个平台——每个平台都是一次真实 LLM 调用，会真花钱/占配额，不做无声的批量；
// ② 已经有兄弟稿的平台跳过，不重复建（重复建会让跨平台对比出现两条同平台记录）；
// ③ 派生稿的首版记为 ai 并写清来源版本，绝不冒充人工稿。
const MAX_DERIVE_PLATFORMS = 3;

export async function actDeriveToPlatform(
  draftId: string,
  platforms: string[],
): Promise<{
  ok: boolean;
  created?: { draftId: string; platform: string }[];
  skipped?: { platform: string; reason: string }[];
  mocked?: boolean;
  error?: string;
}> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const draft = await prisma.draft.findFirst({
    where: { id: draftId, accountId: s.accountId },
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
  });
  if (!draft) return { ok: false, error: '草稿不存在' };
  const source = draft.versions[0];
  if (!source?.content?.trim()) return { ok: false, error: '这篇草稿还没有正文，先写一版再派生' };

  const wanted = [...new Set(platforms.map((p) => p.trim()).filter(Boolean))].slice(0, MAX_DERIVE_PLATFORMS);
  if (wanted.length === 0) return { ok: false, error: '选一个要派生的平台' };

  const rootId = draft.parentDraftId ?? draft.id;
  const existing = await familyPlatforms(s.accountId, draft.id);

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = safePersona(account?.personaCard);

  const created: { draftId: string; platform: string }[] = [];
  const skipped: { platform: string; reason: string }[] = [];
  let mocked = false;

  // 先排除已有同源稿的平台
  const toDerive = wanted.filter((platform) => {
    if (existing.includes(platform)) {
      skipped.push({ platform, reason: '这个平台已经有同源的稿子了' });
      return false;
    }
    return true;
  });

  // 并行派生：每个平台独立调 LLM，总耗时从 N× 降到 max(1×)
  const results = await Promise.allSettled(toDerive.map(async (platform) => {
    const style = PLATFORM_STYLE[platform] ?? '按该平台主流内容形态改写。';
    const rules = await platformSignals(platform, 3);
    const accountCtx = await buildAccountContext({
      workspaceId: s.workspaceId,
      accountId: s.accountId,
      account,
      platform,
      blocks: ['fingerprint', 'exemplar', 'catchphrase', 'memory'],
      memoryQuery: draft!.title,
      maxChars: 4000,
    });
    const res = await llmComplete(s.tenantId, 'generation', [
      {
        role: 'system',
        content: [
          `把同一篇内容改写成适配「${platformName(platform)}」的版本。这是同一个选题的多平台分发，核心事实与观点必须一致，只改表达形态。`,
          `目标平台风格要求：${style}`,
          rules.length ? `该平台算法要点：\n${rules.map((r) => `- ${r.advice}`).join('\n')}` : '',
          personaPromptBlock(persona),
          accountCtx.text,
          aiFlavorBanBlock(),
          '不要新增原文没有的事实、数据或案例。',
          '不要输出「标题：」「正文：」这类标签或字段名，直接给能一次性粘贴出去的成品。只输出改写后的正文。',
        ].filter(Boolean).join('\n\n'),
      },
      { role: 'user', content: source.content },
    ], { temperature: 0.7 });

    const content = stripStageLabels(res.text);
    if (!content) return { platform, skip: '模型没返回内容' as string };
    return { platform, content, mocked: res.mocked, degraded: res.degraded };
  }));

  // 汇总结果：成功的落库，失败的记原因
  for (let i = 0; i < toDerive.length; i++) {
    const platform = toDerive[i];
    const r = results[i];
    if (r.status === 'rejected') {
      const e = r.reason;
      if (isDesignedRejection(e)) {
        skipped.push({ platform, reason: (e as Error).message });
      } else {
        skipped.push({ platform, reason: '派生失败' });
      }
      continue;
    }
    const val = r.value;
    if ('skip' in val) {
      skipped.push({ platform, reason: val.skip ?? '跳过' });
      continue;
    }
    mocked = mocked || val.mocked;
    const child = await prisma.draft.create({
      data: {
        accountId: s.accountId,
        topicId: draft!.topicId,
        parentDraftId: rootId,
        title: draft!.title,
        platform,
        status: 'editing',
      },
    });
    await prisma.draftVersion.create({
      data: {
        draftId: child.id,
        seq: 1,
        authorType: 'ai',
        content: val.content,
        diffFromPrev: `由《${draft!.title}》（${platformName(draft!.platform)} 第${source.seq}版）派生的${platformName(platform)}版本`,
      },
    });
    created.push({ draftId: child.id, platform });
  }

  revalidatePath('/studio');
  if (created.length === 0) {
    return { ok: false, error: skipped.map((sk) => `${platformName(sk.platform)}：${sk.reason}`).join('；') || '没有生成任何版本' };
  }
  return { ok: true, created, skipped, mocked };
}
