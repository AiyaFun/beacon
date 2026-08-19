'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/ops/guard';
import { logAdminAction, isBootstrapAdmin, PLATFORM_ADMIN_ENV } from '@/lib/ops/admin';
import { invalidatePlanCache } from '@/lib/quota';
import { isDemoTenant } from '@/lib/demo/guard';
import { beijingEndOfDay } from '@/lib/beijing';

// 平台侧租户运维动作。三条硬规矩：
//   ① 每个动作先 requirePlatformAdmin()——它同时挡住「演示租户身份」和「已停用成员」；
//   ② 每个成功的写动作都写审计（logAdminAction），失败的不写（没发生的事不留痕）；
//   ③ 改了 Tenant.plan 必须 invalidatePlanCache——lib/quota.ts 有 60s 的 plan 缓存，
//      不失效的话「刚给用户升了档，他那边还在报配额不足」，客服会以为没改成功再改一次。

// 运营可手工写入的档位。与 lib/quota.ts 的 PLATFORM_TIERS 同源：
// 写一个那里没有的字符串，用户会被静默按 free 档限流（PLATFORM_FALLBACK），且看不出原因。
export const ASSIGNABLE_PLANS = ['free', 'trial', 'personal', 'byok', 'enterprise'] as const;
export type AssignablePlan = (typeof ASSIGNABLE_PLANS)[number];

export async function actSetTenantPlan(
  tenantId: string,
  plan: string,
  expiresAt: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const admin = await requirePlatformAdmin();
  if (!(ASSIGNABLE_PLANS as readonly string[]).includes(plan)) {
    return { ok: false, error: `不支持的档位「${plan}」：只能用 ${ASSIGNABLE_PLANS.join(' / ')}` };
  }
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { ok: false, error: '租户不存在' };

  // 空 = 永不过期（lib/pay/plan.ts effectivePlan 的口径），不是「立即过期」。
  //
  // 界面传来的是 yyyy-mm-dd。`new Date('2026-09-30')` 解析成 UTC 零点 = 北京时间当天早 8 点，
  // 于是「到期日 9/30」的用户在 9 月 30 日早上 8 点就被降档了——差一天的经典形状。
  // 口径定为「选的那天整天都还有效」：取北京时间该日的次日零点。
  let expires: Date | null = null;
  if (expiresAt && expiresAt.trim()) {
    const d = new Date(`${expiresAt.trim()}T00:00:00+08:00`);
    if (Number.isNaN(d.getTime())) return { ok: false, error: '到期时间格式不对' };
    expires = beijingEndOfDay(d);
  }
  if (plan === 'free') expires = null; // free 档没有到期日这回事

  await prisma.tenant.update({ where: { id: tenantId }, data: { plan, planExpiresAt: expires } });
  invalidatePlanCache(tenantId);
  await logAdminAction({
    actor: admin,
    action: 'tenant.plan',
    targetType: 'tenant',
    targetId: tenantId,
    targetLabel: tenant.name,
    detail: {
      before: { plan: tenant.plan, planExpiresAt: tenant.planExpiresAt },
      after: { plan, planExpiresAt: expires },
    },
  });
  revalidatePath('/ops/tenants');
  return { ok: true };
}

export async function actSuspendTenant(tenantId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  const admin = await requirePlatformAdmin();
  // 演示租户是挂在公开首页上的游客身份，封了它等于把「免费体验」入口关掉，
  // 而这多半不是操作者的本意（他大概率是想封某个真实租户，选错了行）。
  if (isDemoTenant(tenantId)) return { ok: false, error: '演示租户不能封禁（它是公开体验入口）' };
  if (tenantId === admin.tenantId) return { ok: false, error: '不能封禁自己所在的工作区' };

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { ok: false, error: '租户不存在' };
  const note = reason.trim().slice(0, 200);
  if (!note) return { ok: false, error: '请写清封禁原因——它会原样展示给该工作区的用户' };

  await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'suspended', suspendReason: note } });
  // 已签发的会话不必手工清：lib/auth.ts 的 getMemberByToken 每次请求都查租户状态，
  // 下一次点击即失效。这里也不删数据——封禁是运营手段，不是注销。
  await logAdminAction({
    actor: admin,
    action: 'tenant.suspend',
    targetType: 'tenant',
    targetId: tenantId,
    targetLabel: tenant.name,
    detail: { reason: note },
  });
  revalidatePath('/ops/tenants');
  return { ok: true };
}

export async function actResumeTenant(tenantId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = await requirePlatformAdmin();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return { ok: false, error: '租户不存在' };
  await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'active', suspendReason: null } });
  await logAdminAction({
    actor: admin,
    action: 'tenant.resume',
    targetType: 'tenant',
    targetId: tenantId,
    targetLabel: tenant.name,
    detail: { before: { suspendReason: tenant.suspendReason } },
  });
  revalidatePath('/ops/tenants');
  return { ok: true };
}

/** 授予 / 收回平台管理员。**不允许收回自己的**——那是把自己锁在门外的唯一一步。 */
export async function actSetPlatformAdmin(memberId: string, value: boolean): Promise<{ ok: boolean; error?: string }> {
  const admin = await requirePlatformAdmin();
  if (memberId === admin.memberId && !value) {
    return { ok: false, error: '不能收回自己的平台管理员权限，请让另一位管理员来操作' };
  }
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, name: true, tenantId: true, status: true, phone: true, email: true },
  });
  if (!member) return { ok: false, error: '成员不存在' };
  // env 引导白名单里的人，库里的位收回后会在他下次访问时被自动补写回来
  //（lib/ops/admin.ts 的 resolvePlatformAdmin）。这里如实拒绝，而不是假装收回了——
  // 假装成功比不允许糟得多：操作者会以为权限已经撤掉。
  if (!value && isBootstrapAdmin(member)) {
    return { ok: false, error: `该成员在环境变量 ${PLATFORM_ADMIN_ENV} 白名单里，收回无效。请先从 env 移除并重启服务。` };
  }
  if (value && isDemoTenant(member.tenantId)) return { ok: false, error: '演示租户的成员不能成为平台管理员' };
  if (value && member.status !== 'active') return { ok: false, error: '已停用的成员不能授予平台管理员' };

  await prisma.member.update({ where: { id: memberId }, data: { platformAdmin: value } });
  await logAdminAction({
    actor: admin,
    action: 'member.platform_admin',
    targetType: 'member',
    targetId: memberId,
    targetLabel: member.name,
    detail: { value },
  });
  revalidatePath('/ops/tenants');
  return { ok: true };
}
