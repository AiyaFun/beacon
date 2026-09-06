import crypto from 'node:crypto';
import { prisma } from '../db';
import { DAY_MS, effectivePlan } from '../pay/plan';
import { TRIAL_DAYS } from '../pay/pricing';
import { notify } from '../notify';
import { createLogger } from '../logger';
import { recordFunnelEventAsync } from './funnel';

// 邀请奖励（2026-09-05 增长缺口整改）：邀请 1 位创作者注册，**双方**各得 7 天标准版。
//
// 【为什么是延长到期日而不是送额度】Tenant.plan + planExpiresAt 已经是配额的唯一真值来源
// （lib/quota.ts），送天数一行 update 就生效；送额度要再立一套计数，与 quota 双写必漂移。
//
// 【三条边界，改前先读】
// ① 自邀无效：邀请码属于自己的租户 → 不发。
// ② 一个新租户只能被奖励一次：ReferralGrant.inviteeTenantId 唯一键在库里挡着，并发也挡得住。
// ③ 邀请方每月最多 REFERRAL_MONTHLY_CAP 次：邀请码是公开链接，不设上限就是刷天数的入口。
//
// 【给谁加几天】
//   trial / 付费档（personal、byok）—— 到期日 +7 天（没到期就顺延，过期了从现在起算）
//   free（从未付费或试用过期）—— 给 7 天 trial（让流失的人也有理由回来邀请）
//   永久买断（planExpiresAt 在 50 年后）—— 不动（加 7 天没意义），只记一条通知
//   enterprise / 手工无到期日 —— 不动
// 每一笔都落 ReferralGrant：改的是钱的边界，必须可对账。

const log = createLogger({ module: 'referral' });

export const REFERRAL_DAYS = 7;
export const REFERRAL_MONTHLY_CAP = 20;
/** 邀请码字母表：去掉 0/O/1/I 这四个肉眼分不清的。 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
/** 到期日在 50 年之后的一律当「永久」（买断是 99 年）。 */
const LIFETIME_HORIZON_MS = 50 * 365 * DAY_MS;

export function generateReferralCode(): string {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 邀请码的合法形状：大写字母表内 8 位。别的形状直接判无效，不查库。 */
export function isReferralCodeShape(x: unknown): x is string {
  return typeof x === 'string' && new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`).test(x.trim().toUpperCase());
}

export function normalizeReferralCode(x: unknown): string | null {
  if (!isReferralCodeShape(x)) return null;
  return (x as string).trim().toUpperCase();
}

/** 拿到（没有就生成）这个租户的邀请码。撞唯一键就换一个重试（32^8 空间，撞上是小概率）。 */
export async function ensureReferralCode(tenantId: string): Promise<string> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { referralCode: true } });
  if (t?.referralCode) return t.referralCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    try {
      await prisma.tenant.update({ where: { id: tenantId }, data: { referralCode: code } });
      return code;
    } catch (e) {
      log.warn('邀请码撞唯一键，换一个重试', { attempt, error: (e as Error).message });
    }
  }
  throw new Error('生成邀请码失败，请稍后再试');
}

export function referralLink(site: string, code: string): string {
  return `${site.replace(/\/$/, '')}/login?ref=${code}`;
}

/** 给一个租户加 N 天。返回新到期日；不该加的情况返回 null 并说明。 */
export function extendPlan(
  plan: string | null | undefined,
  planExpiresAt: Date | null | undefined,
  days: number,
  now: Date = new Date(),
): { plan: string; planExpiresAt: Date } | { skip: string } {
  const p = plan ?? 'free';
  if (p === 'enterprise') return { skip: '企业版由商务约定，不叠加邀请天数' };
  if (p !== 'free' && !planExpiresAt) return { skip: '该档位无到期日（手工开通），不叠加' };
  if (planExpiresAt && planExpiresAt.getTime() - now.getTime() > LIFETIME_HORIZON_MS) {
    return { skip: '永久买断用户，天数不叠加' };
  }
  const eff = effectivePlan(p, planExpiresAt, now);
  if (eff === 'free') {
    // 从未付费 / 试用已过期：给一段新的试用
    return { plan: 'trial', planExpiresAt: new Date(now.getTime() + days * DAY_MS) };
  }
  // 在有效期内的 trial / 付费档：从原到期日顺延
  return { plan: p, planExpiresAt: new Date((planExpiresAt as Date).getTime() + days * DAY_MS) };
}

export type ReferralResult =
  | { ok: true; inviterTenantId: string; inviteeDays: number; inviterDays: number }
  | { ok: false; reason: string };

/**
 * 新租户注册时带了邀请码 → 给双方发奖励。**只在建号那一刻调一次**（lib/auth.ts）。
 * 任何一步失败都不影响注册本身——调用方要 catch。
 */
export async function applyReferral(inviteeTenantId: string, rawCode: string | null | undefined, now: Date = new Date()): Promise<ReferralResult> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return { ok: false, reason: '邀请码形状不对' };
  const inviter = await prisma.tenant.findUnique({
    where: { referralCode: code },
    select: { id: true, plan: true, planExpiresAt: true, status: true, workspaces: { select: { id: true }, take: 1 } },
  });
  if (!inviter) return { ok: false, reason: '邀请码不存在' };
  if (inviter.id === inviteeTenantId) return { ok: false, reason: '不能邀请自己' };
  if (inviter.status !== 'active') return { ok: false, reason: '邀请方账号已停用' };

  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  const recent = await prisma.referralGrant.count({ where: { inviterTenantId: inviter.id, createdAt: { gte: monthAgo } } });
  if (recent >= REFERRAL_MONTHLY_CAP) return { ok: false, reason: `邀请方本月已达 ${REFERRAL_MONTHLY_CAP} 次上限` };

  // 唯一键挡重复：并发两次注册同一个邀请码也只会成功一次
  try {
    await prisma.referralGrant.create({
      data: { inviterTenantId: inviter.id, inviteeTenantId, days: REFERRAL_DAYS, createdAt: now },
    });
  } catch (e) {
    return { ok: false, reason: `该租户已领过邀请奖励（${(e as Error).message.slice(0, 40)}）` };
  }

  const invitee = await prisma.tenant.findUnique({ where: { id: inviteeTenantId }, select: { plan: true, planExpiresAt: true } });
  let inviteeDays = 0;
  let inviterDays = 0;
  const a = extendPlan(invitee?.plan, invitee?.planExpiresAt, REFERRAL_DAYS, now);
  if (!('skip' in a)) {
    await prisma.tenant.update({ where: { id: inviteeTenantId }, data: { plan: a.plan, planExpiresAt: a.planExpiresAt, referredBy: inviter.id } });
    inviteeDays = REFERRAL_DAYS;
  } else {
    await prisma.tenant.update({ where: { id: inviteeTenantId }, data: { referredBy: inviter.id } });
  }
  const b = extendPlan(inviter.plan, inviter.planExpiresAt, REFERRAL_DAYS, now);
  if (!('skip' in b)) {
    await prisma.tenant.update({ where: { id: inviter.id }, data: { plan: b.plan, planExpiresAt: b.planExpiresAt } });
    inviterDays = REFERRAL_DAYS;
  }

  const ws = inviter.workspaces[0];
  if (ws) {
    await notify({
      workspaceId: ws.id,
      kind: 'system',
      refId: `referral:${inviteeTenantId}`,
      once: true,
      title: inviterDays > 0 ? `有人凭你的邀请码注册了，标准版 +${inviterDays} 天` : '有人凭你的邀请码注册了',
      body: inviterDays > 0
        ? `到期日已顺延 ${inviterDays} 天。继续邀请：每位新创作者双方各得 ${REFERRAL_DAYS} 天（每月最多 ${REFERRAL_MONTHLY_CAP} 次）。`
        : `${'skip' in b ? b.skip : ''}。这一笔已记入邀请记录。`,
      link: '/billing',
    }).catch(() => undefined);
  }
  recordFunnelEventAsync({ name: 'invite_accept', tenantId: inviteeTenantId, meta: inviter.id.slice(0, 12) });
  return { ok: true, inviterTenantId: inviter.id, inviteeDays, inviterDays };
}

/** 「邀请」卡要显示的数字：已成功邀请几人、本月还剩几次。 */
export async function referralStats(tenantId: string, now: Date = new Date()): Promise<{ total: number; thisMonth: number; remaining: number }> {
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS);
  const [total, thisMonth] = await Promise.all([
    prisma.referralGrant.count({ where: { inviterTenantId: tenantId } }),
    prisma.referralGrant.count({ where: { inviterTenantId: tenantId, createdAt: { gte: monthAgo } } }),
  ]);
  return { total, thisMonth, remaining: Math.max(0, REFERRAL_MONTHLY_CAP - thisMonth) };
}

export { TRIAL_DAYS };
