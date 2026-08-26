'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession, withSession } from '@/lib/session';
import { accountInventory, mergeAccounts, deleteAccount } from '@/lib/account/merge';
import { AUTH_COOKIE, destroySession } from '@/lib/auth';
import { ACCOUNT_COOKIE } from '@/lib/auth-constants';
import { toJson } from '@/lib/json';
import { emptyPersona } from '@/lib/persona';
import { ingestHot, crawlCompetitors, generateRecommendations, clusterHotTopics } from '@/lib/pipeline';
import { writeMemory } from '@/lib/memory/core';
import { analyzeHotFit, type HotFitAnalysis } from '@/lib/topic/combine';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';
import { isDemoTenant } from '@/lib/demo/guard';

const ACCOUNT_COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', maxAge: 180 * 24 * 3600, path: '/' } as const;

// 「按设计拒绝」类错误（配额用尽 / 权限不足）：Next 15 生产会脱敏抛到 error boundary 的 message，
// 把配额自救文案冲成通用英文串。生成推荐真烧 LLM、配额随时可能用尽，故在 action 层转结构化返回
// （ActionButton 的 r.ok===false 分支原样红字展示）；权限不足由 requireRole 直接抛，真 bug 继续抛给 boundary。
function isDesignedRejection(e: unknown): e is QuotaExceededError | RbacError {
  return e instanceof QuotaExceededError || e instanceof RbacError;
}

// ── 多账号管理：一个用户多个创作者账号，内容数据按账号完全隔离 ──

export async function actSwitchAccount(accountId: string) {
  const s = await getSession();
  // 切换账号只改本人 cookie 视图，只读角色也必须能切，否则看不到别的账号
  requireRole(s, 'content.view');
  const account = await prisma.creatorAccount.findFirst({
    where: { id: accountId, workspaceId: s.workspaceId, status: 'active' },
  });
  if (!account) return { ok: false, error: '账号不存在或已归档' };
  const store = await cookies();
  store.set(ACCOUNT_COOKIE, account.id, ACCOUNT_COOKIE_OPTS);
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function actCreateAccount(name: string, platform: string, handle?: string) {
  const s = await getSession();
  // 创作者账号增删改与人设同属一处（/persona 页的 AccountManager），沿用 persona.edit
  requireRole(s, 'persona.edit');
  const clean = name.trim();
  if (!clean) return { ok: false, error: '请填写账号名称' };
  const account = await prisma.creatorAccount.create({
    data: {
      workspaceId: s.workspaceId,
      name: clean,
      platform: platform || 'multi',
      handle: handle?.trim() || null,
      personaCard: toJson(emptyPersona()),
      styleFingerprint: toJson({ voice: [], format: [], topic: [] }),
    },
  });
  // 新建后直接切换过去，引导先完善人设
  const store = await cookies();
  store.set(ACCOUNT_COOKIE, account.id, ACCOUNT_COOKIE_OPTS);
  revalidatePath('/', 'layout');
  return { ok: true, accountId: account.id };
}

export async function actUpdateAccount(accountId: string, data: { name?: string; platform?: string; handle?: string }) {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  const name = data.name?.trim();
  const r = await prisma.creatorAccount.updateMany({
    where: { id: accountId, workspaceId: s.workspaceId },
    data: {
      ...(name ? { name } : {}),
      ...(data.platform ? { platform: data.platform } : {}),
      ...(data.handle !== undefined ? { handle: data.handle.trim() || null } : {}),
    },
  });
  if (r.count === 0) return { ok: false, error: '账号不存在' };
  revalidatePath('/', 'layout');
  return { ok: true };
}

// 归档（不物理删除：草稿/选题/发布/记忆全部保留，可随时恢复）
export async function actArchiveAccount(accountId: string) {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  const others = await prisma.creatorAccount.count({
    where: { workspaceId: s.workspaceId, status: 'active', id: { not: accountId } },
  });
  if (others === 0) return { ok: false, error: '至少保留一个活跃账号' };
  const r = await prisma.creatorAccount.updateMany({
    where: { id: accountId, workspaceId: s.workspaceId },
    data: { status: 'archived' },
  });
  if (r.count === 0) return { ok: false, error: '账号不存在' };
  // 归档的是当前账号则清掉选择，回退默认账号
  if (accountId === s.accountId) {
    const store = await cookies();
    store.delete(ACCOUNT_COOKIE);
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function actRestoreAccount(accountId: string) {
  const s = await getSession();
  requireRole(s, 'persona.edit');
  const r = await prisma.creatorAccount.updateMany({
    where: { id: accountId, workspaceId: s.workspaceId },
    data: { status: 'active' },
  });
  if (r.count === 0) return { ok: false, error: '账号不存在' };
  revalidatePath('/', 'layout');
  return { ok: true };
}

// ── 合并与彻底删除（见 lib/account/merge.ts 的长注释）──
//
// 合并、删除都是「按用户传进来的 id 查归属 → 改/删」的短事务纯 DB 写，正是 IDOR 的着力点，
// 因此走 withSession 让数据库的 RLS 再兜一层（口径见 lib/session.ts 的迁移说明）。

/** 合并/删除前的数据清单：让用户先看见「要搬什么 / 要毁什么」，再决定点不点 */
export async function actAccountInventory(accountId: string) {
  return withSession(async (s, tx) => {
    requireRole(s, 'content.view');
    const acc = await tx.creatorAccount.findFirst({
      where: { id: accountId, workspaceId: s.workspaceId },
      select: { id: true },
    });
    if (!acc) return { ok: false as const, error: '账号不存在' };
    return { ok: true as const, rows: await accountInventory(tx, accountId) };
  });
}

export async function actMergeAccounts(sourceId: string, targetId: string) {
  const { outcome, currentAccountId } = await withSession(async (s, tx) => {
    requireRole(s, 'persona.edit');
    // 归属校验在 mergeAccounts 里（两个 id 都要查），这里只把 tx 交给它——同一个事务、同一份 RLS 上下文
    return { outcome: await mergeAccounts(tx, s.workspaceId, sourceId, targetId), currentAccountId: s.accountId };
  });
  if (!outcome.ok) return outcome;
  // 当前正操作的号被并走了：cookie 指向一个已删除的 id，虽然 getMemberByToken 会兜底回退到
  // 「最早的活跃账号」，但那可能根本不是他刚合并到的这个号。显式切到保留下来的那个。
  if (currentAccountId === sourceId) {
    const store = await cookies();
    store.set(ACCOUNT_COOKIE, targetId, ACCOUNT_COOKIE_OPTS);
  }
  revalidatePath('/', 'layout');
  return outcome;
}

export async function actDeleteAccount(accountId: string, confirmName: string) {
  const { outcome, currentAccountId } = await withSession(async (s, tx) => {
    requireRole(s, 'persona.edit');
    return {
      outcome: await deleteAccount(tx, s.workspaceId, accountId, confirmName),
      currentAccountId: s.accountId,
    };
  });
  if (!outcome.ok) return outcome;
  if (currentAccountId === accountId) {
    const store = await cookies();
    store.delete(ACCOUNT_COOKIE);
  }
  revalidatePath('/', 'layout');
  return outcome;
}

// 「账号内容 × 实时热点」结合分析
export async function actAnalyzeHotFit(hotTitle: string): Promise<{ ok: boolean; analysis?: HotFitAnalysis; error?: string }> {
  if (!hotTitle.trim()) return { ok: false, error: '请选择或输入一个热点' };
  const s = await getSession();
  requireRole(s, 'topic.manage'); // 热点结合分析是选题构思，且烧 LLM
  try {
    const analysis = await analyzeHotFit(s.accountId, s.workspaceId, s.tenantId, hotTitle.trim());
    return { ok: true, analysis };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 120) };
  }
}

// ── 数据采集与推荐（今日概览/热点/竞对/选题页共用）──

export async function actIngestHot() {
  // 原本连 getSession 都没有：任何人都能匿名触发外部采集，这里补上登录+角色校验
  const s = await getSession();
  requireRole(s, 'topic.manage'); // 触发采集要写库、耗外部采集配额
  const r = await ingestHot();
  await clusterHotTopics();
  revalidatePath('/hotlists');
  revalidatePath('/');
  return r;
}

export async function actCrawlCompetitors() {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  // 页面上点出来的采集记成 manual：台账要能分清「我点的」和「定时跑的」
  const r = await crawlCompetitors(s.workspaceId, 'manual');
  revalidatePath('/competitors');
  revalidatePath('/');
  return r;
}

export async function actGenerateRecommendations(): Promise<{ created: number } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  // 全流程：采集热榜 → 采集竞对 → 生成推荐（新用户即时首次推荐 F4-11 也走这条）
  await ingestHot();
  await clusterHotTopics();
  await crawlCompetitors(s.workspaceId, 'manual');
  try {
    const r = await generateRecommendations(s.accountId, s.workspaceId);
    revalidatePath('/topics');
    revalidatePath('/');
    return r;
  } catch (e) {
    if (isDesignedRejection(e)) return { ok: false, error: e.message };
    throw e;
  }
}

// ── 选题操作（采纳/拒绝，写入偏好记忆）──

export async function actAcceptTopic(topicId: string) {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  const topic = await prisma.topicIdea.findFirst({ where: { id: topicId, accountId: s.accountId } });
  if (!topic) return { ok: false };
  await prisma.topicIdea.update({ where: { id: topic.id }, data: { state: 'accepted' } });
  await writeMemory({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    type: 'preference',
    content: `用户采纳了选题方向：${topic.angle}`,
    confidence: 0.4,
  });
  revalidatePath('/topics');
  return { ok: true };
}

export async function actRejectTopic(topicId: string, reason: string) {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  const topic = await prisma.topicIdea.findFirst({ where: { id: topicId, accountId: s.accountId } });
  if (!topic) return { ok: false };
  await prisma.topicIdea.update({
    where: { id: topic.id },
    data: { state: 'rejected', rejectReason: reason },
  });
  await writeMemory({
    workspaceId: s.workspaceId,
    accountId: s.accountId,
    type: 'preference',
    content: `用户拒绝选题「${topic.title}」，原因：${reason}`,
    confidence: 0.4,
  });
  revalidatePath('/topics');
  return { ok: true };
}

// ── 任务清单 ──

export async function actAddTask(title: string) {
  const s = await getSession();
  requireRole(s, 'task.manage');
  if (!title.trim()) return { ok: false };
  await prisma.taskItem.create({ data: { workspaceId: s.workspaceId, title: title.trim(), source: 'user' } });
  revalidatePath('/');
  return { ok: true };
}

export async function actToggleTask(id: string, done: boolean) {
  const s = await getSession();
  requireRole(s, 'task.manage');
  await prisma.taskItem.updateMany({ where: { id, workspaceId: s.workspaceId }, data: { done } });
  revalidatePath('/');
  return { ok: true };
}

// ── 今日建议（F8-1）──

export type Advice = { text: string; mocked: boolean };

export async function actGenerateAdvice(context: {
  completeness: number;
  topicCount: number;
  publishCount: number;
  acceptedCount: number;
  memoryCount: number;
  competitorCount: number;
}): Promise<Advice> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const { llmComplete } = await import('@/lib/llm/gateway');
  const { readPersona, personaPromptBlock } = await import('@/lib/persona');
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');

  const sys = [
    '你是内容创作者的 AI 运营教练。根据以下账号状态，给出 2-3 条今日建议。',
    '每条建议必须满足：动作动词 + 具体数量 + 完成时限。例：「今晚从热点雷达收藏 3 个话题」。',
    '不要给空洞的鸡汤或通用模板。紧扣这个人的人设和当前数据。没有高置信建议时宁缺毋滥，输出 1 条即可。',
    '',
    personaPromptBlock(persona),
  ].join('\n');

  const usr = [
    `人设完善度：${context.completeness}%`,
    `今日推荐选题：${context.topicCount} 条`,
    `已采纳待拍：${context.acceptedCount} 条`,
    `已发布作品：${context.publishCount} 条`,
    `生效记忆：${context.memoryCount} 条`,
    `监控竞对：${context.competitorCount} 个`,
    '',
    '请给出今日建议，每条一行，不要编号不要列表符号。',
  ].join('\n');

  try {
    const r = await llmComplete(s.tenantId, 'chat', [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ], { temperature: 0.6 });
    return { text: r.text, mocked: r.mocked };
  } catch (e) {
    if (e instanceof QuotaExceededError || e instanceof RbacError) {
      return { text: e.message, mocked: false };
    }
    throw e;
  }
}

export async function actAdviceToTask(text: string) {
  const s = await getSession();
  requireRole(s, 'task.manage');
  if (!text.trim()) return { ok: false };
  await prisma.taskItem.create({ data: { workspaceId: s.workspaceId, title: text.trim(), source: 'suggestion' } });
  revalidatePath('/');
  return { ok: true };
}

// ── 登出 ──
export async function actLogout() {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  await destroySession(token);
  store.delete(AUTH_COOKIE);
  redirect('/login');
}

// ── 界面外壳偏好 ────────────────────────────────────────────────────────────

