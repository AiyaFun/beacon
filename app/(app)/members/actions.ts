'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole, assignableRoles, ROLE_LABEL, isRole } from '@/lib/rbac';
import { issueLocalLoginTicket } from '@/lib/auth/local-link';
import { edition } from '@/lib/edition';
import { assertNotDemo } from '@/lib/demo/guard';
import { siteUrl } from '@/lib/site-url';

// 成员与权限：邀请 / 撤销 / 改角色 / 停用 / 移除。
// 权限类校验用 requireRole 直接 throw（越权是异常，不是可展示的业务分支）；
// 业务边界（不能动 owner、不能动自己）返回 error 文案给界面提示。

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000; // 邀请链接 7 天有效

// ── 创建邀请：生成 token，phone 为空表示凭链接任何人可接受 ──
export async function actCreateInvite(
  data: { phone?: string; role: string },
): Promise<{ ok: boolean; error?: string; token?: string }> {
  const s = await getSession();
  requireRole(s, 'member.invite');

  const role = data.role;
  if (!isRole(role) || !assignableRoles().includes(role)) {
    return { ok: false, error: '不支持的角色：所有权只能通过转让流转，不能靠邀请授予' };
  }
  const phone = data.phone?.trim() || null;
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) return { ok: false, error: '手机号格式不正确' };

  if (phone) {
    // Member.phone 全局唯一 = 一个手机号只能属于一个租户，邀请前先把话说清楚
    const existing = await prisma.member.findUnique({ where: { phone } });
    if (existing?.tenantId === s.tenantId) return { ok: false, error: '该手机号已是本工作区成员' };
    if (existing) return { ok: false, error: '该手机号已属于其他工作区，无法邀请' };
    const pending = await prisma.invite.findFirst({
      where: { tenantId: s.tenantId, phone, status: 'pending', expiresAt: { gt: new Date() } },
    });
    if (pending) return { ok: false, error: '该手机号已有待处理邀请，请先撤销再重新邀请' };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.invite.create({
    data: {
      tenantId: s.tenantId,
      phone,
      role,
      token,
      invitedBy: s.memberId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  revalidatePath('/members');
  return { ok: true, token };
}

// ── 撤销邀请：只能撤本租户的 pending 邀请 ──
export async function actRevokeInvite(id: string) {
  const s = await getSession();
  requireRole(s, 'member.invite');
  const r = await prisma.invite.updateMany({
    where: { id, tenantId: s.tenantId, status: 'pending' },
    data: { status: 'revoked' },
  });
  if (r.count === 0) return { ok: false, error: '邀请不存在或已处理' };
  revalidatePath('/members');
  return { ok: true };
}

// ── 改角色 ──
export async function actChangeRole(memberId: string, role: string) {
  const s = await getSession();
  requireRole(s, 'member.role');
  if (!isRole(role) || !assignableRoles().includes(role)) {
    return { ok: false, error: '不支持的角色：所有权只能通过转让流转' };
  }
  const target = await prisma.member.findFirst({ where: { id: memberId, tenantId: s.tenantId } });
  if (!target) return { ok: false, error: '成员不存在' };
  // 不能改自己：admin 把自己降成 viewer 会当场把自己锁在成员管理外面
  if (target.id === s.memberId) return { ok: false, error: '不能修改自己的角色' };
  // owner 不可降级 —— 配合「不能授予 owner」，天然保证工作区始终恰有一个所有者
  if (target.role === 'owner') return { ok: false, error: '所有者角色不可变更，请使用转让所有权' };
  if (target.role === role) return { ok: true };

  await prisma.member.update({ where: { id: target.id }, data: { role } });
  revalidatePath('/members');
  return { ok: true, message: `已将 ${target.name} 设为${ROLE_LABEL[role]}` };
}

// ── 停用 / 恢复：保留数据但禁止登录 ──
export async function actSetMemberStatus(memberId: string, status: 'active' | 'suspended') {
  const s = await getSession();
  requireRole(s, 'member.suspend');
  const target = await prisma.member.findFirst({ where: { id: memberId, tenantId: s.tenantId } });
  if (!target) return { ok: false, error: '成员不存在' };
  if (target.id === s.memberId) return { ok: false, error: '不能停用自己' };
  if (target.role === 'owner') return { ok: false, error: '不能停用所有者' };

  await prisma.member.update({ where: { id: target.id }, data: { status } });
  // 停用即刻踢下线，不等 30 天会话自然过期
  if (status === 'suspended') await prisma.authSession.deleteMany({ where: { memberId: target.id } });
  revalidatePath('/members');
  return { ok: true };
}

// ── 移除成员：删 Member，其会话随 Cascade 一并失效 ──
export async function actRemoveMember(memberId: string) {
  const s = await getSession();
  requireRole(s, 'member.remove');
  const target = await prisma.member.findFirst({ where: { id: memberId, tenantId: s.tenantId } });
  if (!target) return { ok: false, error: '成员不存在' };
  if (target.id === s.memberId) return { ok: false, error: '不能移除自己' };
  if (target.role === 'owner') return { ok: false, error: '不能移除所有者，请先转让所有权' };

  await prisma.member.delete({ where: { id: target.id } });
  revalidatePath('/members');
  return { ok: true };
}

/**
 * 给某个成员生成一条**一次性本机登录链接**（5 分钟有效）。
 *
 * 【它解决的问题】企业版关掉了短信通道，登录的唯一通路是私聊企业应用机器人。
 * 客户没配飞书/钉钉/企微时，整台机器只有装机那个人靠向导种下的会话能用——
 * 会话一过期他自己也进不去，同事从头到尾没进去过。
 *
 * 【为什么不拿装机口令当登录凭据】那是一次性装机凭证，明文写在 .env、
 * 装机时打印在终端、还抄进了桌面的《安装说明》。延伸成登录口令 = 桌面上一张纸变永久门钥匙。
 * 这里的权力来源是「**已经登录的管理员**」，与机器人那条路同一口径。
 *
 * 【SaaS 上不给】那边有短信与微信登录，多一条「拿到链接就能进」的通道
 * 只是多一个可被钓鱼的入口。形态闸在这里和落地路由各判一次。
 */
export async function actIssueLoginLink(memberId: string): Promise<{ ok: boolean; error?: string; url?: string; memberName?: string }> {
  const s = await getSession();
  // 与「改角色/停用成员」同一档权限：能签发别人的登录凭据，本身就是成员管理动作
  requireRole(s, 'member.invite');

  if (edition() === 'saas') {
    return { ok: false, error: 'SaaS 版用短信或微信登录，不提供本机登录链接' };
  }
  assertNotDemo(s.tenantId);

  const r = await issueLocalLoginTicket(s.tenantId, memberId);
  if (!r.ok) return { ok: false, error: r.message };

  return {
    ok: true,
    memberName: r.memberName,
    url: `${siteUrl()}/api/auth/local/magic?t=${r.ticket}`,
  };
}
