'use server';

import { getSession } from '@/lib/session';
import { checkText, hasRedline, invalidateDfaCache, type WordHit } from '@/lib/compliance/engine';
import { llmSemanticReview, type SemanticHit, type SemanticReviewResult } from '@/lib/compliance/semantic';
import { llmComplete } from '@/lib/llm/gateway';
import { platformName } from '@/lib/constants';
import { requireRole } from '@/lib/rbac';
import { prisma } from '@/lib/db';
import { toJson } from '@/lib/json';
import { revalidatePath } from 'next/cache';

export type { SemanticHit } from '@/lib/compliance/semantic';

export type CheckResult = {
  hits: WordHit[];
  riskLevel: 'pass' | 'warn' | 'block';
  platform: string;
  redline: boolean;
  semantic?: SemanticReviewResult;
};

// 实时检测：DFA 词库匹配 + 红线判定 + LLM 语义审核（F6-3）
export async function actCheck(text: string, platform: string, draftId?: string): Promise<CheckResult> {
  const s = await getSession();
  requireRole(s, 'compliance.check');
  if (!text.trim()) {
    return { hits: [], riskLevel: 'pass', platform, redline: false };
  }
  const [res, redline] = await Promise.all([
    checkText(text, platform, s.tenantId),
    hasRedline(text),
  ]);

  const semantic = await llmSemanticReview(text, platform, s.tenantId, res.hits);

  let riskLevel = res.riskLevel;
  if (riskLevel === 'pass' && semantic.hits.some((h) => h.action === 'warn')) {
    riskLevel = 'warn';
  }

  // 落检测历史：此前 ComplianceCheck 这张表**只有读者没有写者**——billing 的「合规拦截」
  // 计数永远是 0，用户也看不到「上周被拦了什么」。这里把它接上。
  //
  // 两条刻意的口径：
  //   · 只在**命中了东西**时落库（riskLevel !== 'pass' 或命中红线）。每次 pass 都记一行
  //     只会把表撑大而不产生任何可读信息，战报要的是"拦了什么"，不是"点了多少次检测"。
  //   · 只在**关联草稿**时落库：ComplianceCheck.draftId 是必填外键（非空），
  //     检测框里的临时文本没有对应草稿，硬造一个假 draftId 是数据污染。
  //     并且必须校验草稿属于当前账号，否则等于允许跨租户写入。
  if (draftId && (riskLevel !== 'pass' || redline)) {
    try {
      const owned = await prisma.draft.findFirst({
        where: { id: draftId, accountId: s.accountId },
        select: { id: true },
      });
      if (owned) {
        await prisma.complianceCheck.create({
          data: {
            draftId: owned.id,
            platform: res.platform,
            hits: toJson(res.hits),
            riskLevel: redline ? 'block' : riskLevel,
          },
        });
      }
    } catch {
      // 落历史是旁路增强：写失败绝不能让用户的检测结果拿不到
    }
  }

  return { hits: res.hits, riskLevel, platform: res.platform, redline, semantic };
}

export type RewriteResult = {
  rewritten: string;
  check: CheckResult;
  mocked: boolean;
};

// 一键 AI 改写规避：把命中词交给 LLM，产出合规改写版并复检
export async function actRewriteSafe(text: string, platform: string): Promise<RewriteResult> {
  const s = await getSession();
  // 改写是「产出新文案」而非「查合规」，且烧 LLM，按创作动作管
  requireRole(s, 'content.create');
  const pre = await checkText(text, platform, s.tenantId);
  const hitWords = Array.from(new Set(pre.hits.map((h) => h.word)));

  const sys = `你是内容合规改写助手。任务：在保持原意与语气的前提下，改写文案以规避「${platformName(platform)}」平台的敏感词与违规表达。规则：
1. 去掉或替换极限词、虚假承诺、导流违规、医疗金融夸大等表达。
2. 保留原文的信息量和风格，只做最小必要改动。
3. 直接输出改写后的正文，不要解释、不要加引号、不要 Markdown。`;

  const usr = `目标平台：${platformName(platform)}
已知命中的敏感词：${hitWords.length ? hitWords.join('、') : '（本地未命中，按语义再排查一遍）'}

待改写文案：
${text}`;

  const out = await llmComplete(
    s.tenantId,
    'compliance',
    [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ],
    { temperature: 0.4 },
  );

  const rewritten = out.text.trim() || text;
  const [res, redline] = await Promise.all([
    checkText(rewritten, platform, s.tenantId),
    hasRedline(rewritten),
  ]);

  return {
    rewritten,
    check: { hits: res.hits, riskLevel: res.riskLevel, platform: res.platform, redline },
    mocked: out.mocked,
  };
}

// ─── 自定义词库 CRUD（F6-7）───────────────────────────

export type CustomWord = {
  id: string;
  word: string;
  action: string;
  platform: string | null;
  suggestion: string | null;
  enabled: boolean;
  createdAt: string;
};

export async function actAddCustomWord(input: {
  word: string;
  action: 'block' | 'warn' | 'suggest';
  platform?: string;
  suggestion?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'compliance.check');
  const word = input.word.trim();
  if (!word || word.length > 20) return { ok: false, error: '词条长度 1-20 字' };

  const exists = await prisma.sensitiveWord.findFirst({
    where: { tenantId: s.tenantId, tier: 'custom', word },
  });
  if (exists) return { ok: false, error: `"${word}" 已存在` };

  await prisma.sensitiveWord.create({
    data: {
      tenantId: s.tenantId,
      word,
      tier: 'custom',
      action: input.action,
      platform: input.platform || null,
      suggestion: input.suggestion || null,
    },
  });
  invalidateDfaCache(); // 词库变更后立即失效缓存，新词当次检测即生效
  revalidatePath('/compliance');
  return { ok: true };
}

export async function actRemoveCustomWord(id: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'compliance.check');
  const w = await prisma.sensitiveWord.findUnique({ where: { id } });
  if (!w || w.tenantId !== s.tenantId || w.tier !== 'custom') {
    return { ok: false, error: '词条不存在或无权操作' };
  }
  await prisma.sensitiveWord.delete({ where: { id } });
  invalidateDfaCache(); // 删词后立即失效缓存
  revalidatePath('/compliance');
  return { ok: true };
}

export async function actToggleCustomWord(id: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'compliance.check');
  const w = await prisma.sensitiveWord.findUnique({ where: { id } });
  if (!w || w.tenantId !== s.tenantId || w.tier !== 'custom') {
    return { ok: false, error: '词条不存在或无权操作' };
  }
  await prisma.sensitiveWord.update({ where: { id }, data: { enabled: !w.enabled } });
  invalidateDfaCache(); // 停用/启用后立即失效缓存
  revalidatePath('/compliance');
  return { ok: true };
}

// ─── 误报反馈/申诉（F6-8）───────────────────────────

export type FeedbackItem = {
  id: string;
  word: string;
  tier: string;
  context: string;
  reason: string;
  status: string;
  createdAt: string;
};

export async function actSubmitFeedback(input: {
  word: string;
  tier: string;
  context: string;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'compliance.check');
  const reason = input.reason.trim();
  if (!reason) return { ok: false, error: '请填写反馈原因' };
  if (reason.length > 500) return { ok: false, error: '反馈原因不超过 500 字' };

  await prisma.complianceFeedback.create({
    data: {
      tenantId: s.tenantId,
      word: input.word,
      tier: input.tier,
      context: input.context.slice(0, 200),
      reason,
    },
  });
  revalidatePath('/compliance');
  return { ok: true };
}

export async function actListFeedback(): Promise<FeedbackItem[]> {
  const s = await getSession();
  requireRole(s, 'compliance.check');
  const items = await prisma.complianceFeedback.findMany({
    where: { tenantId: s.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return items.map((f) => ({
    id: f.id,
    word: f.word,
    tier: f.tier,
    context: f.context,
    reason: f.reason,
    status: f.status,
    createdAt: f.createdAt.toISOString(),
  }));
}

// 处理误报申诉：待处理 → 已采纳 / 已驳回。
//
// 此前**没有任何动作能改 status**：FeedbackPanel 画了三个徽章，但只有 pending 可达，
// 用户提了申诉就永远停在「待处理」——三分之二的 UI 状态是不可达的死分支。
//
// 收口到 owner/admin（compliance.resolve）：这是对本租户合规口径下结论的动作，
// 不该让每个 editor 都能把自己的申诉标成「已采纳」。
//
// 采纳自定义词的申诉时**顺手停用那个词**——否则「已采纳」只是个标签，
// 用户下次检测还会被同一个词拦住，等于没处理。法律/平台/行业级词库是全局的，
// 不能被单个租户停用，此时只记结论（并在 UI 上说明后续走词库运营流程）。
export async function actResolveFeedback(
  id: string,
  status: 'accepted' | 'rejected',
): Promise<{ ok: boolean; error?: string; disabledWord?: boolean }> {
  const s = await getSession();
  requireRole(s, 'compliance.resolve');

  const fb = await prisma.complianceFeedback.findUnique({ where: { id } });
  // 跨租户防护：只能处理本租户的申诉
  if (!fb || fb.tenantId !== s.tenantId) return { ok: false, error: '申诉不存在或无权操作' };
  if (fb.status !== 'pending') return { ok: false, error: '这条申诉已经处理过了' };

  await prisma.complianceFeedback.update({
    where: { id },
    data: { status, resolvedAt: new Date() },
  });

  let disabledWord = false;
  if (status === 'accepted') {
    // 只停用本租户自定义词（tier=custom 且 tenantId 匹配）——全局词库不受单租户申诉影响
    const w = await prisma.sensitiveWord.findFirst({
      where: { tenantId: s.tenantId, tier: 'custom', word: fb.word, enabled: true },
    });
    if (w) {
      await prisma.sensitiveWord.update({ where: { id: w.id }, data: { enabled: false } });
      invalidateDfaCache(); // 词库变更立即生效，否则最长 5 分钟内还会被拦
      disabledWord = true;
    }
  }

  revalidatePath('/compliance');
  return { ok: true, disabledWord };
}
