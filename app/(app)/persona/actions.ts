'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession, withSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { parseJson, toJson } from '@/lib/json';
import {
  readPersona,
  emptyPersona,
  sanitizePersonaCard,
  parsePersonaResponse,
  localPersonaDraft,
  buildFieldStates,
  DEFAULT_PERSONA_QUESTIONS,
  PERSONA_QUESTION_KEYS,
  type PersonaCard,
  type PersonaAnswer,
  type PersonaQuestion,
  type PersonaQuestionKey,
  type PersonaDraft,
} from '@/lib/persona';
import { llmComplete } from '@/lib/llm/gateway';
import { QuotaExceededError } from '@/lib/quota';
import { PLATFORM_LIST } from '@/lib/constants';
import { writeMemory } from '@/lib/memory/core';
import type { ChatMessage } from '@/lib/llm/types';

// 权限：人设与记忆是创作资产，viewer 只读（persona.edit）。
// 配额：扩写烧 token，由 gateway 的 assertLlmQuota 自动拦（Mock 不计额度）。

// ── 人设卡保存：更新 personaCard + 新增 personaVersion + 写 persona 记忆 ──
export async function actSavePersona(cardJson: string) {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  if (!s.accountId) return { ok: false, error: '未找到账号' };

  // 统一走 sanitizePersonaCard：AI 扩写与手填两条路径同一道清洗（截断 + 平台白名单）
  const incoming = parseJson<PersonaCard>(cardJson, emptyPersona());
  const clean: PersonaCard = sanitizePersonaCard(incoming);

  await prisma.creatorAccount.update({
    where: { id: s.accountId },
    data: { personaCard: toJson(clean) },
  });

  // 版本号自增：取当前账号最大版本 +1
  const last = await prisma.personaVersion.findFirst({
    where: { accountId: s.accountId },
    orderBy: { version: 'desc' },
  });
  const nextVersion = (last?.version ?? 0) + 1;
  await prisma.personaVersion.create({
    data: {
      accountId: s.accountId,
      version: nextVersion,
      snapshot: toJson(clean),
      editedBy: s.memberName,
    },
  });

  // 人设是用户显式确认，写入即生效的 persona 记忆
  await writeMemory({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    type: 'persona',
    content: `账号定位：${clean.identity || '（未填）'}｜受众：${clean.audience || '（未填）'}`,
    confidence: 1,
  });

  // 刚拿到主战平台，顺手把对应的内置技能装上——新用户建完人设进创作工坊，
  // 「出成品」不该还是一片「还没有安装技能，去技能中心装」：他刚亲口说过主战平台是哪两个，
  // 再让他跑一趟逐个点安装，是把已知信息又推回给用户做一遍。
  // 只在该租户从未装过技能时生效（装过又卸掉是明确选择，不覆盖）；失败静默。
  try {
    const { preinstallSkillsForPlatforms } = await import('@/lib/skills');
    await preinstallSkillsForPlatforms(s.tenantId, clean.platforms ?? []);
  } catch (e) {
    console.warn('[persona] 按主战平台预装技能失败，已跳过:', (e as Error).message);
  }

  revalidatePath('/persona');
  revalidatePath('/');
  revalidatePath('/studio');
  revalidatePath('/skills');
  return { ok: true, version: nextVersion };
}

// ─────────────── F3-1 冷启动：一句话 → AI 追问 → AI 扩写 → 逐项确认 ───────────────

const SENTENCE_MAX = 200;

function cleanSentence(raw: string): string {
  return raw.trim().slice(0, SENTENCE_MAX);
}

// ── 第一步：AI 追问（PRD：3–5 个问题，卖什么/给谁/凭什么）──
export async function actAskPersonaQuestions(
  sentence: string,
): Promise<{ ok: true; questions: PersonaQuestion[]; mocked: boolean; fallback: boolean } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'persona.edit');

  const one = cleanSentence(sentence);
  if (one.length < 4) return { ok: false, error: '请先用一句话介绍你的账号（至少 4 个字）' };

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是资深账号定位顾问。用户给你一句话自我介绍，你要提出 3–5 个最关键的追问，帮他把账号人设讲清楚。',
        '必问三件事：卖什么（what）、给谁（who）、凭什么是他（why）；可选再问内容红线与语气（edge）、主战平台（platform）。',
        'key 只能取这五个值之一，不得自创，不得重复。问题要结合他那句话具体化，不要问放之四海皆准的空话。',
        '严格输出 JSON，不要解释、不要代码块：{"questions":[{"key":"what","question":"...","hint":"..."}]}',
      ].join('\n'),
    },
    { role: 'user', content: `一句话自我介绍：${one}` },
  ];

  let mocked = false;
  try {
    const r = await llmComplete(s.tenantId, 'chat', messages, { json: true, temperature: 0.6 });
    mocked = r.mocked;
    const parsed = parseJson<{ questions?: unknown }>(r.text, {});
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];
    const valid: PersonaQuestion[] = [];
    const seen = new Set<string>();
    for (const q of list) {
      const o = q as Record<string, unknown>;
      const key = typeof o?.key === 'string' ? o.key : '';
      const question = typeof o?.question === 'string' ? o.question.trim() : '';
      // key 必须在白名单内——它决定「跳过 → 哪些字段降置信度」的映射，自创 key 会让标注失灵
      if (!(PERSONA_QUESTION_KEYS as readonly string[]).includes(key) || seen.has(key) || question.length < 4) continue;
      seen.add(key);
      valid.push({
        key: key as PersonaQuestionKey,
        question: question.slice(0, 80),
        hint: (typeof o?.hint === 'string' ? o.hint.trim() : '').slice(0, 80),
      });
    }
    // 少于 3 问就不算数（PRD 下限），整体退回固定三问 + 补充两问
    if (valid.length >= 3) return { ok: true, questions: valid.slice(0, 5), mocked, fallback: false };
    return { ok: true, questions: DEFAULT_PERSONA_QUESTIONS, mocked, fallback: true };
  } catch (e) {
    if (e instanceof QuotaExceededError) return { ok: false, error: e.message };
    // 追问失败不该卡死冷启动：退回固定三问，用户照样能往下走
    return { ok: true, questions: DEFAULT_PERSONA_QUESTIONS, mocked, fallback: true };
  }
}

// ── 第二步：AI 扩写（一句话 + 追问回答 → 完整人设卡）──
// 不写库：产出草稿交给用户逐项确认，确认后才走 actSavePersona。脏数据进不了库的第一道闸。
export async function actExpandPersona(
  sentence: string,
  answersJson: string,
): Promise<{ ok: true; draft: PersonaDraft } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'persona.edit');

  const one = cleanSentence(sentence);
  if (one.length < 4) return { ok: false, error: '请先用一句话介绍你的账号（至少 4 个字）' };

  // 回答同样是不可信输入：key 白名单化 + 截断
  const raw = parseJson<PersonaAnswer[]>(answersJson, []);
  const answers: PersonaAnswer[] = (Array.isArray(raw) ? raw : [])
    .filter((a) => (PERSONA_QUESTION_KEYS as readonly string[]).includes(a?.key))
    .slice(0, 5)
    .map((a) => ({
      key: a.key,
      question: (a.question ?? '').slice(0, 80),
      answer: (a.answer ?? '').trim().slice(0, 300),
      skipped: !!a.skipped || !(a.answer ?? '').trim(),
    }));

  const qaBlock = answers.length
    ? answers
        .map((a, i) =>
          a.skipped
            ? `${i + 1}. ${a.question}\n   →（用户跳过，请用保守的通用默认值填充，不要编造具体事实）`
            : `${i + 1}. ${a.question}\n   → ${a.answer}`,
        )
        .join('\n')
    : '（用户未回答任何追问，请仅依据那句话保守推断）';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是资深账号定位顾问。把用户的一句话自我介绍与追问回答，扩写成一张完整的账号人设卡。',
        '',
        '硬性要求：',
        '1. 只依据用户提供的信息推断。禁止编造用户没提过的经历、收入数字、粉丝量、职称与背书。',
        '2. 用户跳过的问题，给保守的通用默认值，不要编造具体事实。',
        '3. cantDo 是内容红线，要结合赛道给出真实可执行的红线（如医疗建议、金融荐股、收入承诺）。',
        `4. platforms 只能从这些里选：${PLATFORM_LIST.map((p) => `${p.key}(${p.name})`).join('、')}；拿不准就给空数组。`,
        '5. identity/audience/valueProp/niche/tone 均为非空短句；canDo 与 cantDo 各 3–5 条，每条不超过 20 字。',
        '',
        '严格输出 JSON，不要任何解释文字、不要 markdown 代码块：',
        '{"identity":"","audience":"","valueProp":"","niche":"","tone":"","canDo":[""],"cantDo":[""],"platforms":[""]}',
      ].join('\n'),
    },
    { role: 'user', content: `一句话自我介绍：${one}\n\n追问与回答：\n${qaBlock}` },
  ];

  let mocked = false;
  let provider = 'mock';
  let model = '';
  let issues: string[] = [];

  try {
    const r = await llmComplete(s.tenantId, 'generation', messages, { json: true, temperature: 0.6 });
    mocked = r.mocked;
    provider = r.provider;
    model = r.model;

    let parsed = parsePersonaResponse(r.text);

    // 一次修复重试：把校验失败原因回喂给模型。
    // Mock 是确定性的，重试必然拿到同一坨东西 —— 不浪费这一次往返。
    if (!parsed.ok && !r.mocked) {
      issues = parsed.issues;
      const retry = await llmComplete(
        s.tenantId,
        'generation',
        [
          ...messages,
          { role: 'assistant', content: r.text.slice(0, 2000) },
          { role: 'user', content: `上次输出不合要求：${parsed.issues.join('；')}。请只输出符合要求的 JSON，不要任何其他文字。` },
        ],
        { json: true, temperature: 0.2 },
      );
      provider = retry.provider;
      model = retry.model;
      parsed = parsePersonaResponse(retry.text);
    }

    if (parsed.ok) {
      return {
        ok: true,
        draft: {
          card: parsed.card,
          fields: buildFieldStates(answers, false),
          mocked: r.mocked,
          degraded: false,
          provider,
          model,
          issues: [],
        },
      };
    }
    issues = parsed.issues;
  } catch (e) {
    if (e instanceof QuotaExceededError) return { ok: false, error: e.message };
    issues = [`模型调用失败：${(e as Error).message.slice(0, 80)}`];
  }

  // 降级：LLM 不可用或输出过不了 schema → 本地规则草稿。
  // 只把用户自己说过的话搬进字段，一个字都不编，UI 上明确标成「本地草稿」而非 AI 生成。
  return {
    ok: true,
    draft: {
      card: localPersonaDraft(one, answers),
      fields: buildFieldStates(answers, true),
      mocked,
      degraded: true,
      provider,
      model,
      issues,
    },
  };
}

// ── F3-7 风格指纹量化：从已发布内容中提取 voice/format 特征 ──
export async function actAnalyzeStyle(): Promise<{ ok: boolean; error?: string; mocked?: boolean }> {
  const s = await getSession();
  requireRole(s, 'persona.edit');

  const { readFingerprint, analyzeContentStyle, mergeLayer, toFingerprintJson } = await import('@/lib/style');

  const drafts = await prisma.draft.findMany({
    where: { account: { workspaceId: s.workspaceId } },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
  });

  const texts = drafts
    .map((d) => d.versions[0]?.content || d.title)
    .filter((t) => t.length > 20);

  if (texts.length < 2) return { ok: false, error: '至少需要 2 条草稿/作品才能提取风格' };

  const analysis = await analyzeContentStyle(s.tenantId, texts);

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  if (!account) return { ok: false, error: '账号不存在' };

  const existing = readFingerprint(account.styleFingerprint);
  const merged = {
    voice: mergeLayer(existing.voice, analysis.voice),
    format: mergeLayer(existing.format, analysis.format),
    topic: existing.topic,
  };

  await prisma.creatorAccount.update({
    where: { id: s.accountId },
    data: { styleFingerprint: toFingerprintJson(merged) },
  });

  revalidatePath('/persona');
  return { ok: true, mocked: analysis.mocked };
}

// ── 记忆删除：用户全程可删 ──
// 走 withSession：查归属 + 删除在同一事务里，Postgres RLS 上下文已设好，
// 跨工作区的 id 在库层就查不到（应用层的 workspaceId 校验保留，两层都要在）。
export async function actDeleteMemory(id: string) {
  return withSession(async (s, tx) => {
    requireRole(s, 'persona.edit');
    const mem = await tx.memoryEntry.findUnique({ where: { id } });
    // 仅允许删除当前工作区的记忆
    if (!mem || mem.workspaceId !== s.workspaceId) return { ok: false };
    await tx.memoryEntry.delete({ where: { id } });
    revalidatePath('/persona');
    return { ok: true };
  });
}

// ── 人设版本回滚 ────────────────────────────────────────────────────
// PersonaVersion 此前是**只写不读**：每次编辑都存一份快照，但页面从不查它，
// editedBy 也写了不展示——设计时想做的回滚功能一直不存在，快照白存了一堆。
//
// 回滚刻意实现成「把旧快照当成一次新的编辑」而不是删掉后续版本：
// 版本历史是审计线索，回滚本身也该留痕。回到 v3 会产生 v5（内容等于 v3），
// 这样「谁在什么时候回滚过」同样查得到，且不会把 v4 从历史里抹掉。
export async function actRollbackPersona(
  versionId: string,
): Promise<{ ok: boolean; error?: string; version?: number }> {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  if (!s.accountId) return { ok: false, error: '未找到账号' };

  const target = await prisma.personaVersion.findUnique({ where: { id: versionId } });
  // 跨账号防护：只能回滚自己账号的版本
  if (!target || target.accountId !== s.accountId) return { ok: false, error: '版本不存在或无权操作' };

  // 走与手动保存同一道清洗（截断 + 平台白名单）：旧快照也可能是脏的，
  // 而且 sanitize 规则可能在存档之后收紧过，不能因为「它曾经存进去过」就直接信。
  const clean = sanitizePersonaCard(parseJson<PersonaCard>(target.snapshot, emptyPersona()));

  await prisma.creatorAccount.update({
    where: { id: s.accountId },
    data: { personaCard: toJson(clean) },
  });

  const last = await prisma.personaVersion.findFirst({
    where: { accountId: s.accountId },
    orderBy: { version: 'desc' },
  });
  const nextVersion = (last?.version ?? 0) + 1;
  await prisma.personaVersion.create({
    data: {
      accountId: s.accountId,
      version: nextVersion,
      snapshot: toJson(clean),
      editedBy: `${s.memberName}（回滚自 v${target.version}）`,
    },
  });

  revalidatePath('/persona');
  revalidatePath('/');
  return { ok: true, version: nextVersion };
}

// ── 编辑单条记忆内容 ──────────────────────────────────────────────
// 此前用户只能「删除」：看到一条学错的记忆（比如把偶尔一次的长文当成偏好），
// 唯一选择是删掉、然后指望系统重新学对——而系统很可能再学错一次。
// 改一个字比删掉重学成本低得多，也更符合「记忆是你的资产」这个叙事。
//
// 两条口径：
//   · 只允许改 content，不允许改 confidence/hitCount/active——那些是系统的学习状态，
//     让用户手调等于允许伪造「这条被验证过 10 次」。
//   · 用户亲手改过的内容视为高置信：置信度提到 0.9 并置为生效。
//     理由是这条不再是推断而是**用户直接陈述**，与 persona 类记忆同级。
export async function actUpdateMemory(
  id: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const text = content.trim();
  if (!text) return { ok: false, error: '记忆内容不能为空' };
  if (text.length > 300) return { ok: false, error: '记忆内容不超过 300 字' };

  const r = await withSession(async (s, tx) => {
    requireRole(s, 'persona.edit');
    const mem = await tx.memoryEntry.findUnique({ where: { id } });
    // 跨工作区防护：只能改本工作区的记忆
    if (!mem || mem.workspaceId !== s.workspaceId) return { ok: false, error: '记忆不存在或无权操作' };
    if (mem.content === text) return { ok: true, changed: false }; // 没改动，不写库也不动向量
    await tx.memoryEntry.update({ where: { id }, data: { content: text, confidence: 0.9, active: true } });
    return { ok: true, changed: true };
  });
  if (!r.ok || !('changed' in r) || !r.changed) return r;

  // 重算向量要**放在事务外**：它会打嵌入服务（网络调用，可能几百毫秒到超时），
  // 塞进事务里等于让一个 HTTP 请求占着数据库连接，是连接池被拖垮的经典成因。
  // 失败不阻断：召回会退化成关键词匹配，但记忆本身已经改对了。
  const { upsertMemoryEmbedding } = await import('@/lib/vector/store');
  await upsertMemoryEmbedding(id, text).catch(() => {});

  revalidatePath('/persona');
  return { ok: true };
}

// ── 立即优化记忆：手动触发持续学习 pass（去重/生效/遗忘），返回本轮小结 ──
// 只做可见可回退的记忆卫生，不改人设卡（人设改进只在页面给建议、由用户确认）。
export async function actOptimizeMemory() {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  const { optimizeWorkspaceMemory } = await import('@/lib/memory/optimize');
  const r = await optimizeWorkspaceMemory(s.workspaceId);
  revalidatePath('/persona');
  return { ok: true, summary: r.summaryText, merged: r.merged, promoted: r.promoted, retired: r.retired };
}

// ── 冷启动首日「贴几个链接」最小样单 ────────────────────────────────────
//
// 要解决的问题：新用户建完人设后，八个候选源里第一天只有三个出货（热榜/节点日历/常青），
// 推荐看起来"很普通"，而解锁其余五个源要么等发布数据攒够、要么先去添竞对——门槛都在首日之外。
// 这一步把门槛压到"贴几个链接"：
//   · 自有作品链接 → 建 PublishRecord 骨架（带 platformItemId）→ 自动回流管线当天就能开始工作，
//     后续 D+1/D+7 job 会把真实指标填进来，翻新/跨平台补发两个源随之解锁。
//   · 竞对主页链接 → 建档 + 订阅 → 竞对源当天点亮，插件"访问即采"也随之生效。
//
// 诚实红线：**不写任何编造的指标**。骨架记录的 metrics 是空的 {}，
// 指标要么等自动回流、要么等用户手填——绝不用 0 或猜的数字冒充"已有数据"。
export async function actColdStartSeed(input: {
  ownUrls?: string[];
  competitorUrls?: string[];
}): Promise<{
  ok: boolean;
  own: { ok: number; failed: { url: string; reason: string }[] };
  competitors: { ok: number; failed: { url: string; reason: string }[] };
}> {
  const s = await getSession();
  requireRole(s, 'persona.edit');

  const { parsePublishUrl } = await import('@/lib/publish/parse-url');
  const { parseCompetitorUrl } = await import('@/lib/competitor-url');

  const own = { ok: 0, failed: [] as { url: string; reason: string }[] };
  const competitors = { ok: 0, failed: [] as { url: string; reason: string }[] };

  // 自有作品：最多 3 条（首日只求"把管线打通"，不是批量导入——批量走 /data 的 CSV 导入）
  for (const raw of (input.ownUrls ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 3)) {
    const r = parsePublishUrl(raw);
    if (!r.ok) {
      own.failed.push({ url: raw, reason: r.message });
      continue;
    }
    try {
      // upsert 到 (accountId, platformItemId) 唯一键：重复贴同一条链接不会建出第二条
      await prisma.publishRecord.upsert({
        where: { accountId_platformItemId: { accountId: s.accountId, platformItemId: r.platformItemId } },
        update: {}, // 已存在就不动它（可能已有真实回流数据，绝不覆盖）
        create: {
          accountId: s.accountId,
          platform: r.platform,
          title: null, // 标题等回流或用户补；不从 URL 猜
          platformItemId: r.platformItemId,
          needsBackfill: false, // 有 platformItemId，自动回流可用
          metrics: toJson({}), // 空指标——不编造
        },
      });
      own.ok++;
    } catch (e) {
      own.failed.push({ url: raw, reason: (e as Error).message.slice(0, 80) });
    }
  }

  // 竞对：最多 3 条
  for (const raw of (input.competitorUrls ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 3)) {
    const parsed = parseCompetitorUrl(raw);
    if (!parsed) {
      competitors.failed.push({ url: raw, reason: '没认出是哪个平台的主页链接' });
      continue;
    }
    try {
      const competitor = await prisma.competitorAccount.upsert({
        where: { platform_handle: { platform: parsed.platform, handle: parsed.handle } },
        update: {},
        create: {
          platform: parsed.platform,
          handle: parsed.handle,
          name: parsed.handle, // 真名等采集回来再更新；不从 URL 猜昵称
        },
      });
      await prisma.watchlistItem.upsert({
        where: { workspaceId_competitorId: { workspaceId: s.workspaceId, competitorId: competitor.id } },
        update: {},
        create: { workspaceId: s.workspaceId, competitorId: competitor.id },
      });
      competitors.ok++;
    } catch (e) {
      competitors.failed.push({ url: raw, reason: (e as Error).message.slice(0, 80) });
    }
  }

  revalidatePath('/persona');
  revalidatePath('/data');
  revalidatePath('/competitors');
  revalidatePath('/topics');
  return { ok: true, own, competitors };
}
