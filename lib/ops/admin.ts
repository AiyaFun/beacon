import { prisma } from '../db';
import { toJson } from '../json';
import { isDemoTenant } from '../demo/guard';
import { createLogger } from '../logger';

const log = createLogger({ module: 'ops-admin' });

// ── 平台超级管理员：谁能进跨租户运维台 /ops ──────────────────────────────────
//
// 【为什么不复用 role === 'owner'】role 回答的是「你在**自己**租户里能干什么」，
// 而每个注册用户都是自己租户的 owner。拿它当平台权限判据 = 全站每个人都是平台管理员，
// 能改别人的套餐、看别家的订单。这两件事必须是正交的两位，所以新加 Member.platformAdmin。
//
// 【为什么要 env 白名单引导】平台上线的第一天，库里一个 platformAdmin=true 的行都没有，
// 而授予这一位的入口本身在 /ops 里面——先有鸡还是先有蛋。env 白名单是打破死锁的那把钥匙：
// 写进 env 的手机号/邮箱在登录后即视为超管（并**自动补写**回库，让审计能落到具体 Member）。
// 它同时是找回入口：数据库里的位被误删了，改 env 重启就能回来。
//
// 【绝不给演示租户】演示租户是全站游客共用的只读身份（lib/demo/guard.ts）。
// 它要是能进运维台，等于把平台后台挂在公网首页上。这里硬拦，不看 env、不看库里的位。

export const PLATFORM_ADMIN_ENV = 'BEACON_PLATFORM_ADMINS';

export class NotPlatformAdminError extends Error {
  readonly code = 'NOT_PLATFORM_ADMIN';
  constructor(message = '需要平台管理员权限') {
    super(message);
    this.name = 'NotPlatformAdminError';
  }
}

/** env 白名单：逗号/空白分隔的手机号或邮箱。邮箱大小写不敏感，手机号去掉常见分隔符。 */
export function bootstrapAdmins(raw = process.env[PLATFORM_ADMIN_ENV]): string[] {
  return (raw ?? '')
    .split(/[,，;；\s]+/)
    .map((s) => normalizeIdentity(s))
    .filter((s) => s.length > 0);
}

/** 身份归一：邮箱转小写，手机号去掉 +86 / 空格 / 连字符。**不做格式校验**——这里只求可比。 */
export function normalizeIdentity(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  if (s.includes('@')) return s.toLowerCase();
  return s.replace(/[\s-]/g, '').replace(/^\+?86/, '');
}

/** 这个成员是否在 env 引导白名单里。 */
export function isBootstrapAdmin(
  member: { phone?: string | null; email?: string | null },
  raw = process.env[PLATFORM_ADMIN_ENV],
): boolean {
  const list = bootstrapAdmins(raw);
  if (list.length === 0) return false;
  const phone = normalizeIdentity(member.phone);
  const email = normalizeIdentity(member.email);
  return (phone !== '' && list.includes(phone)) || (email !== '' && list.includes(email));
}

export type PlatformAdmin = {
  memberId: string;
  memberName: string;
  tenantId: string;
  /** 这次权限是从哪来的：库里的位，还是 env 引导白名单 */
  via: 'db' | 'bootstrap';
};

/**
 * 解析一个成员是不是平台超管。
 *
 * env 白名单命中而库里的位是 false 时，**顺手把位补写回库**：
 * 审计日志、成员列表、「谁是超管」这些地方读的都是库，不补写就会出现
 * 「他明明能进后台，成员列表里却不显示是管理员」这种对不上的状态。
 */
export async function resolvePlatformAdmin(memberId: string): Promise<PlatformAdmin | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, name: true, tenantId: true, phone: true, email: true, status: true, platformAdmin: true },
  });
  if (!member) return null;
  if (member.status !== 'active') return null; // 被停用的成员，位还在也不放行
  if (isDemoTenant(member.tenantId)) return null; // 演示租户永不为超管

  if (member.platformAdmin) {
    return { memberId: member.id, memberName: member.name, tenantId: member.tenantId, via: 'db' };
  }
  if (isBootstrapAdmin(member)) {
    await prisma.member.update({ where: { id: member.id }, data: { platformAdmin: true } }).catch((err) => {
      // 补写失败不影响放行：env 白名单本身已是充分判据，补写只是让库跟上
      log.warn('引导超管补写失败', { memberId: member.id, err: (err as Error).message });
    });
    return { memberId: member.id, memberName: member.name, tenantId: member.tenantId, via: 'bootstrap' };
  }
  return null;
}

// ── 审计 ────────────────────────────────────────────────────────────────────
//
// 平台侧的每一个写动作都要留痕。**写审计失败绝不能连累主动作**——
// 但也绝不能静默：吞掉异常的同时打 error 日志，运维台上「最近动作」为空本身就是信号。

export type AdminAction =
  | 'tenant.plan'
  | 'tenant.suspend'
  | 'tenant.resume'
  | 'member.platform_admin'
  | 'provider.create'
  | 'provider.update'
  | 'provider.delete'
  | 'setting.update'
  | 'parser.publish'
  | 'parser.rollback';

export const ADMIN_ACTION_LABEL: Record<AdminAction, string> = {
  'tenant.plan': '调整租户套餐',
  'tenant.suspend': '封禁租户',
  'tenant.resume': '解封租户',
  'member.platform_admin': '变更平台管理员',
  'provider.create': '新增平台渠道',
  'provider.update': '修改平台渠道',
  'provider.delete': '删除平台渠道',
  'setting.update': '修改平台配置',
  'parser.publish': '发布解析规则',
  'parser.rollback': '回滚解析规则',
};

export async function logAdminAction(params: {
  actor: Pick<PlatformAdmin, 'memberId' | 'memberName'>;
  action: AdminAction;
  targetType: 'tenant' | 'member' | 'provider' | 'setting' | 'parser';
  targetId: string;
  targetLabel?: string;
  detail?: unknown;
}): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorMemberId: params.actor.memberId,
        actorName: params.actor.memberName,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        targetLabel: params.targetLabel ?? '',
        detail: toJson(params.detail ?? {}),
      },
    });
  } catch (err) {
    log.error('审计写入失败', { action: params.action, err: (err as Error).message });
  }
}
