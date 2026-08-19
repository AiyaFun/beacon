import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  bootstrapAdmins,
  isBootstrapAdmin,
  normalizeIdentity,
  resolvePlatformAdmin,
  logAdminAction,
  PLATFORM_ADMIN_ENV,
} from '@/lib/ops/admin';
import { getMemberByToken, tenantSuspendedMessage } from '@/lib/auth';
import { DEMO_TENANT_ID } from '@/lib/demo/guard';

// 平台超管与租户封禁。跑真 SQLite：要验的正是「库里的位」「env 补写回库」「会话立即失效」
// 这几件带 DB 语义的事，mock 掉 prisma 等于测桩自己。

async function mkTenant(opts: { id?: string; status?: string; suspendReason?: string } = {}) {
  const tenant = await prisma.tenant.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      name: '测试工作区',
      plan: 'free',
      status: opts.status ?? 'active',
      suspendReason: opts.suspendReason ?? null,
    },
  });
  const workspace = await prisma.workspace.create({ data: { tenantId: tenant.id, name: '主工作区' } });
  return { tenant, workspace };
}

async function mkMember(tenantId: string, opts: { phone?: string; email?: string; platformAdmin?: boolean; status?: string } = {}) {
  return prisma.member.create({
    data: {
      tenantId,
      name: '张三',
      phone: opts.phone ?? null,
      email: opts.email ?? null,
      role: 'owner',
      status: opts.status ?? 'active',
      platformAdmin: opts.platformAdmin ?? false,
    },
  });
}

describe('env 引导白名单', () => {
  it('逗号/中文逗号/空白都能分隔，手机号去掉 +86 与分隔符，邮箱转小写', () => {
    const list = bootstrapAdmins('+86 138-0000-0001，Ops@Example.com; 13900000002');
    expect(list).toEqual(['13800000001', 'ops@example.com', '13900000002']);
  });

  it('空 env = 谁都不是超管（不许「没配置就全放行」）', () => {
    expect(bootstrapAdmins('')).toEqual([]);
    expect(bootstrapAdmins(undefined)).toEqual([]);
    expect(isBootstrapAdmin({ phone: '13800000001' }, '')).toBe(false);
  });

  it('手机号与邮箱各自能命中，未命中的不误判', () => {
    const raw = '13800000001,ops@example.com';
    expect(isBootstrapAdmin({ phone: '138 0000 0001' }, raw)).toBe(true);
    expect(isBootstrapAdmin({ email: 'OPS@example.com' }, raw)).toBe(true);
    expect(isBootstrapAdmin({ phone: '13800000009' }, raw)).toBe(false);
    expect(isBootstrapAdmin({ phone: null, email: null }, raw)).toBe(false);
  });

  it('归一不吃掉号码本身（去 +86 只去前缀）', () => {
    expect(normalizeIdentity('+8613800000001')).toBe('13800000001');
    expect(normalizeIdentity('8613800000001')).toBe('13800000001');
    // 866… 不是 +86 前缀的号（去掉 86 后仍以 6 开头），这里也只去一次前缀，不递归剥
    expect(normalizeIdentity('  ')).toBe('');
  });
});

describe('resolvePlatformAdmin', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('库里的位为 true → 是超管', async () => {
    const { tenant } = await mkTenant();
    const m = await mkMember(tenant.id, { phone: '13800000011', platformAdmin: true });
    const admin = await resolvePlatformAdmin(m.id);
    expect(admin?.via).toBe('db');
    expect(admin?.memberId).toBe(m.id);
  });

  it('普通成员不是超管', async () => {
    const { tenant } = await mkTenant();
    const m = await mkMember(tenant.id, { phone: '13800000012' });
    expect(await resolvePlatformAdmin(m.id)).toBeNull();
  });

  it('env 白名单命中 → 放行，并把位补写回库（否则成员列表与实际权限对不上）', async () => {
    const { tenant } = await mkTenant();
    const m = await mkMember(tenant.id, { phone: '13800000013' });
    vi.stubEnv(PLATFORM_ADMIN_ENV, '13800000013');

    const admin = await resolvePlatformAdmin(m.id);
    expect(admin?.via).toBe('bootstrap');
    const after = await prisma.member.findUnique({ where: { id: m.id } });
    expect(after?.platformAdmin).toBe(true);
  });

  it('演示租户的成员永远不是超管——哪怕库里的位是 true、哪怕在 env 白名单里', async () => {
    const { tenant } = await mkTenant({ id: DEMO_TENANT_ID });
    const m = await mkMember(tenant.id, { phone: '13800000014', platformAdmin: true });
    vi.stubEnv(PLATFORM_ADMIN_ENV, '13800000014');
    expect(await resolvePlatformAdmin(m.id)).toBeNull();
  });

  it('已停用的成员不放行（位还在也不行）', async () => {
    const { tenant } = await mkTenant();
    const m = await mkMember(tenant.id, { phone: '13800000015', platformAdmin: true, status: 'suspended' });
    expect(await resolvePlatformAdmin(m.id)).toBeNull();
  });

  it('成员不存在返回 null 而不是抛错', async () => {
    expect(await resolvePlatformAdmin('no-such-member')).toBeNull();
  });
});

describe('审计留痕', () => {
  it('写入一条可读的记录', async () => {
    const { tenant } = await mkTenant();
    const m = await mkMember(tenant.id, { phone: '13800000021', platformAdmin: true });
    await logAdminAction({
      actor: { memberId: m.id, memberName: m.name },
      action: 'tenant.plan',
      targetType: 'tenant',
      targetId: tenant.id,
      targetLabel: tenant.name,
      detail: { before: { plan: 'free' }, after: { plan: 'personal' } },
    });
    const rows = await prisma.adminAuditLog.findMany({ where: { targetId: tenant.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('tenant.plan');
    expect(rows[0].actorName).toBe('张三');
    expect(JSON.parse(rows[0].detail).after.plan).toBe('personal');
  });
});

describe('租户封禁真的生效（不是只在界面上变个字）', () => {
  async function mkSession(memberId: string) {
    const token = crypto.randomBytes(16).toString('base64url');
    await prisma.authSession.create({
      data: { token, memberId, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    return token;
  }

  it('租户 active 时会话正常', async () => {
    const { tenant } = await mkTenant();
    const m = await mkMember(tenant.id, { phone: '13800000031' });
    const token = await mkSession(m.id);
    expect(await getMemberByToken(token)).not.toBeNull();
  });

  it('租户被封禁 → 已签发的会话下一次请求即失效', async () => {
    const { tenant } = await mkTenant();
    const m = await mkMember(tenant.id, { phone: '13800000032' });
    const token = await mkSession(m.id);
    expect(await getMemberByToken(token)).not.toBeNull(); // 封禁前是通的

    await prisma.tenant.update({ where: { id: tenant.id }, data: { status: 'suspended', suspendReason: '违规采集' } });
    expect(await getMemberByToken(token)).toBeNull();
  });

  it('封禁提示带上原因，原样说给用户听', async () => {
    const { tenant } = await mkTenant({ status: 'suspended', suspendReason: '违规采集' });
    expect(await tenantSuspendedMessage(tenant.id)).toContain('违规采集');
  });

  it('未封禁返回 null；租户不存在也返回 null（读库异常不能把所有人挡在门外）', async () => {
    const { tenant } = await mkTenant();
    expect(await tenantSuspendedMessage(tenant.id)).toBeNull();
    expect(await tenantSuspendedMessage('no-such-tenant')).toBeNull();
  });
});
