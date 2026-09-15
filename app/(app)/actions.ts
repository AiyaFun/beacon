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
import { analyzeHotFit, type HotFitAnalysis } from '@/lib/topic/combine';
import { issueHotFitToken, verifyHotFitToken } from '@/lib/topic/adopt-token';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';

const ACCOUNT_COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', maxAge: 180 * 24 * 3600, path: '/' } as const;

// 「按设计拒绝」类错误（配额用尽 / 权限不足）：Next 15 生产会脱敏抛到 error boundary 的 message，
// 把配额自救文案冲成通用英文串。生成推荐真烧 LLM、配额随时可能用尽，故在 action 层转结构化返回
// （ActionButton 的 r.ok===false 分支原样红字展示）；权限不足由 requireRole 直接抛，真 bug 继续抛给 boundary。
function isDesignedRejection(e: unknown): e is QuotaExceededError | RbacError {
  return e instanceof QuotaExceededError || e instanceof RbacError;
}

// 底层异常不能原样回给客户端：Prisma 的 message 带表名/列名，模型网关的带上游 HTTP 与通道细节。
// 按设计拒绝（配额/权限）的文案本来就是给人看的，原样返回；其余记日志、回一句通用话。
function actionError(e: unknown, fallback: string): string {
  if (isDesignedRejection(e)) return e.message;
  console.error('[actions]', e);
  return fallback;
}

/** 客户端传来的字符串：非字符串按空处理（不让 .trim() 在 try 外抛），去首尾空白并截断。 */
const cleanStr = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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
const HOT_TITLE_MAX = 200;

export async function actAnalyzeHotFit(
  hotTitle: string,
): Promise<{ ok: boolean; analysis?: HotFitAnalysis; adoptToken?: string; error?: string }> {
  // 入参来自客户端：null/对象不能让 .trim() 在 try 外炸；超长文本不能直接灌进提示词与计费路径
  if (typeof hotTitle !== 'string' || !hotTitle.trim()) return { ok: false, error: '请选择或输入一个热点' };
  const title = hotTitle.trim();
  if (title.length > HOT_TITLE_MAX) return { ok: false, error: `热点标题过长（最多 ${HOT_TITLE_MAX} 字）` };
  const s = await getSession();
  requireRole(s, 'topic.manage'); // 热点结合分析是选题构思，且烧 LLM
  try {
    const analysis = await analyzeHotFit(s.accountId, s.workspaceId, s.tenantId, title);
    // 采纳凭证：一键采纳时只认它，标题/切入角/评分都从凭证里取（见 lib/topic/adopt-token.ts）
    return { ok: true, analysis, adoptToken: issueHotFitToken(s.accountId, analysis) };
  } catch (e) {
    return { ok: false, error: actionError(e, '分析失败，请稍后重试') };
  }
}

// 采纳落库的长度上限：展示用文本超长截断而不是打回（凭证里的值本就是服务端产出）
const HOT_ADOPT_MAX = { hotTitle: 200, angle: 200, why: 600 } as const;
// 同一账号、同热点、同切入角在这个窗口内重复采纳 → 视为同一次点击（双击/网络重试），只留一条
const HOT_ADOPT_DEDUPE_MS = 5 * 60 * 1000;

export async function actAdoptHotAngleAsTopic(params: {
  /** actAnalyzeHotFit 返回的 adoptToken */
  token: string;
  /** 采纳 analysis.angles 里的第几条 */
  angleIndex: number;
}): Promise<{ ok: boolean; topicId?: string; error?: string; duplicate?: boolean }> {
  const p = (params && typeof params === 'object' ? params : {}) as Partial<Record<'token' | 'angleIndex', unknown>>;
  const s = await getSession();
  requireRole(s, 'topic.manage');

  // 来源校验：凭证签名 + 账号归属 + 有效期。客户端只能选「第几条」，选不了内容
  const v = verifyHotFitToken(p.token, s.accountId);
  if (!v.ok) return { ok: false, error: v.error };
  const idx = typeof p.angleIndex === 'number' && Number.isInteger(p.angleIndex) ? p.angleIndex : -1;
  const chosen = v.payload.angles[idx];
  if (!chosen || typeof chosen !== 'object') return { ok: false, error: '切入角度不存在' };

  const angle = cleanStr(chosen.angle, HOT_ADOPT_MAX.angle);
  if (!angle) return { ok: false, error: '切入角度不能为空' };
  const hotTitle = cleanStr(v.payload.hotTitle, HOT_ADOPT_MAX.hotTitle);
  if (!hotTitle) return { ok: false, error: '缺少热点标题' };
  const why = cleanStr(chosen.why, HOT_ADOPT_MAX.why);
  const fitRaw = Number(v.payload.fit);
  const fitScore = Number.isFinite(fitRaw) ? Math.max(0, Math.min(100, Math.round(fitRaw))) : 0;

  const dedupeKey = { accountId: s.accountId, sourceType: 'hot', sourceRef: hotTitle, title: angle };
  try {
    const created = await prisma.topicIdea.create({
      data: {
        ...dedupeKey,
        angle: why || angle,
        rationale: `来自热点「${hotTitle}」结合分析（契合度 ${fitScore} 分）`,
        totalScore: fitScore,
        queue: 'today',
        state: 'accepted',
        // 启发式兜底出来的分析（Mock/模型失败）采纳进去也要如实标：评分不是真模型打的
        mocked: v.payload.mocked === true,
      },
    });
    // 幂等收敛（不靠数据库锁，SQLite/Postgres 通吃）：并发双击时两次 create 都会成功，
    // 建完再查同键窗口内的全部行，只留最早那条；自己不是最早就删掉自己、返回最早那条的 id。
    // 先查后建的写法（findFirst → create）两边都可能查空然后各建一条，这里改成建完再收敛：
    // 后建的那个一定能看见先建的，两边看到同一集合、算出同一个赢家。
    const siblings = await prisma.topicIdea.findMany({
      where: { ...dedupeKey, createdAt: { gte: new Date(Date.now() - HOT_ADOPT_DEDUPE_MS) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const winner = siblings[0]?.id ?? created.id;
    if (winner !== created.id) {
      await prisma.topicIdea.deleteMany({ where: { id: created.id } });
      return { ok: true, topicId: winner, duplicate: true };
    }
    revalidatePath('/topics');
    return { ok: true, topicId: created.id };
  } catch (e) {
    return { ok: false, error: actionError(e, '采纳失败，请稍后重试') };
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

// ── 登出 ──
export async function actLogout() {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  await destroySession(token);
  store.delete(AUTH_COOKIE);
  redirect('/login');
}

/**
 * 游客 → 注册的接力（2026-09-05）：退出演示会话，把「刚才在看的那一页」带到登录页，
 * 登录成功后原地接着看（LoginForm 认 next；微信那条路由 cookie 带过去）。
 * 只认站内相对路径（lib/auth/safe-next.ts），认不出就退回普通登录页。
 */
export async function actDemoExit(nextPath?: string) {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  await destroySession(token);
  store.delete(AUTH_COOKIE);
  const { safeNextPath } = await import('@/lib/auth/safe-next');
  const next = safeNextPath(nextPath);
  redirect(next ? `/login?from=demo&next=${encodeURIComponent(next)}` : '/login?from=demo');
}

// ── 界面外壳偏好 ────────────────────────────────────────────────────────────

