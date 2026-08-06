import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { verifyLoginCode, peekInvite, requestLoginCode } from '@/lib/auth';

// 邀请流。跑在真 SQLite 上（临时库，见 tests/setup/）——
// 因为要验的正是 DB 语义：token 原子抢占、phone 唯一约束、expiresAt 时间比较。
// 这些用 mock prisma 测等于测桩自己。

const OWNER_PHONE = '13800000001';
const INVITEE_PHONE = '13900000002';
const OTHER_PHONE = '13700000003';

async function mkTenant(name = '测试工作区') {
  const tenant = await prisma.tenant.create({ data: { name, plan: 'free' } });
  await prisma.workspace.create({ data: { tenantId: tenant.id, name: '主工作区' } });
  const owner = await prisma.member.create({
    data: { tenantId: tenant.id, name: '拥有者', phone: OWNER_PHONE, role: 'owner' },
  });
  return { tenant, owner };
}

async function mkInvite(opts: {
  tenantId: string;
  invitedBy: string;
  phone?: string | null;
  role?: string;
  status?: string;
  expiresAt?: Date;
}) {
  return prisma.invite.create({
    data: {
      tenantId: opts.tenantId,
      invitedBy: opts.invitedBy,
      phone: opts.phone ?? null,
      role: opts.role ?? 'editor',
      token: crypto.randomBytes(32).toString('base64url'),
      status: opts.status ?? 'pending',
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600_000),
    },
  });
}

// 直接种一条可用验证码，跳过发码链路（发码另有冷却，不是这里要测的）
async function mkCode(phone: string, code = '123456') {
  await prisma.verificationCode.create({
    data: { phone, code, expiresAt: new Date(Date.now() + 5 * 60_000) },
  });
  return code;
}

beforeEach(async () => {
  // 每个用例前清库：同文件内用例共享一个 DB 文件
  await prisma.authSession.deleteMany();
  await prisma.verificationCode.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.member.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  vi.restoreAllMocks();
});

describe('邀请流 · token 无效一律拒绝', () => {
  it('token 不存在 → 拒', async () => {
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', 'nonexistent-token');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('邀请链接无效、已被使用或已过期');
  });

  it('token 已过期 → 拒', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({
      tenantId: tenant.id,
      invitedBy: owner.id,
      phone: INVITEE_PHONE,
      expiresAt: new Date(Date.now() - 1000), // 1 秒前过期
    });
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已过期');
  });

  it('token 已被接受（accepted）→ 拒，不可复用', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, status: 'accepted' });
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(false);
  });

  it('token 已撤销（revoked）→ 拒', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, status: 'revoked' });
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(false);
  });

  it('无效邀请不烧验证码：被拒后原验证码仍可用于普通登录', async () => {
    // 设计意图——邀请校验先于验证码校验，免得用户拿着坏链接白白废掉一条码
    await mkCode(INVITEE_PHONE);
    await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', 'bad-token');
    const rec = await prisma.verificationCode.findFirst({ where: { phone: INVITEE_PHONE } });
    expect(rec?.consumed).toBe(false);
    expect(rec?.attempts).toBe(0);

    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua');
    expect(r.ok).toBe(true);
  });
});

describe('邀请流 · 定向邀请的手机号绑定（防链接泄漏被捡走）', () => {
  it('定向邀请 + 非受邀手机号 → 拒', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: INVITEE_PHONE });
    await mkCode(OTHER_PHONE);
    const r = await verifyLoginCode(OTHER_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('指定了其他手机号');
  });

  it('被拒后邀请仍是 pending，受邀人之后仍可正常使用', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: INVITEE_PHONE });
    await mkCode(OTHER_PHONE);
    await verifyLoginCode(OTHER_PHONE, '123456', 'ua', inv.token);
    expect((await prisma.invite.findUnique({ where: { id: inv.id } }))?.status).toBe('pending');

    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(true);
  });

  it('定向邀请 + 受邀手机号 → 放行并加入邀请方租户，角色取邀请里的 role', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: INVITEE_PHONE, role: 'admin' });
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(true);

    const m = await prisma.member.findUnique({ where: { phone: INVITEE_PHONE } });
    expect(m?.tenantId).toBe(tenant.id); // 加入的是邀请方租户，没有另开租户
    expect(m?.role).toBe('admin');
  });

  it('开放邀请（phone 为空）任何手机号都能用', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: null, role: 'viewer' });
    await mkCode(OTHER_PHONE);
    const r = await verifyLoginCode(OTHER_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(true);
    expect((await prisma.member.findUnique({ where: { phone: OTHER_PHONE } }))?.role).toBe('viewer');
  });
});

describe('邀请流 · token 不可复用（原子抢占）', () => {
  it('同一定向 token 第二次使用 → 拒', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: INVITEE_PHONE });

    await mkCode(INVITEE_PHONE);
    expect((await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token)).ok).toBe(true);
    expect((await prisma.invite.findUnique({ where: { id: inv.id } }))?.status).toBe('accepted');

    // 换个人拿同一条链接来用
    await mkCode(OTHER_PHONE);
    const r2 = await verifyLoginCode(OTHER_PHONE, '123456', 'ua', inv.token);
    expect(r2.ok).toBe(false);
    expect(await prisma.member.findUnique({ where: { phone: OTHER_PHONE } })).toBeNull();
  });

  it('开放 token 被两个不同手机号并发使用 → 只有一个成功', async () => {
    // updateMany({where:{status:'pending'}}) 抢占的意义就在这：不靠「读后写」，并发下只有一个 count=1
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: null });
    await mkCode(INVITEE_PHONE);
    await mkCode(OTHER_PHONE);

    const [a, b] = await Promise.all([
      verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token),
      verifyLoginCode(OTHER_PHONE, '123456', 'ua', inv.token),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await prisma.member.findMany({ where: { tenantId: tenant.id } })).length).toBe(2); // owner + 1
  });

  it('开放邀请被已是本租户的成员使用时保持 pending（不烧掉留给别人的名额）', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: null });
    await mkCode(OWNER_PHONE); // owner 自己点了链接
    const r = await verifyLoginCode(OWNER_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(true);
    expect((await prisma.invite.findUnique({ where: { id: inv.id } }))?.status).toBe('pending');
  });

  it('定向邀请被已是本租户的成员使用 → 直接登录且标 accepted，不重复建 Member', async () => {
    const { tenant, owner } = await mkTenant();
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: OWNER_PHONE });
    await mkCode(OWNER_PHONE);
    const r = await verifyLoginCode(OWNER_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(true);
    expect((await prisma.invite.findUnique({ where: { id: inv.id } }))?.status).toBe('accepted');
    expect(await prisma.member.count({ where: { phone: OWNER_PHONE } })).toBe(1);
    expect((await prisma.member.findUnique({ where: { phone: OWNER_PHONE } }))?.role).toBe('owner'); // 角色没被邀请改掉
  });
});

describe('邀请流 · 跨租户与停用成员', () => {
  it('已属其他工作区的手机号 → 拒（Member.phone 全局唯一的诚实报错）', async () => {
    const a = await mkTenant('A 工作区');
    const b = await prisma.tenant.create({ data: { name: 'B 工作区', plan: 'free' } });
    await prisma.workspace.create({ data: { tenantId: b.id, name: '主工作区' } });
    await prisma.member.create({ data: { tenantId: b.id, name: '别处的人', phone: INVITEE_PHONE, role: 'owner' } });

    const inv = await mkInvite({ tenantId: a.tenant.id, invitedBy: a.owner.id, phone: INVITEE_PHONE });
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已属于其他工作区');
    // 没被偷偷搬走
    expect((await prisma.member.findUnique({ where: { phone: INVITEE_PHONE } }))?.tenantId).toBe(b.id);
  });

  it('停用成员不得借邀请链接绕回来', async () => {
    const { tenant, owner } = await mkTenant();
    await prisma.member.create({
      data: { tenantId: tenant.id, name: '被停用', phone: INVITEE_PHONE, role: 'editor', status: 'suspended' },
    });
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: INVITEE_PHONE });
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已被停用');
  });

  it('停用成员普通登录也被拒', async () => {
    const { tenant } = await mkTenant();
    await prisma.member.create({
      data: { tenantId: tenant.id, name: '被停用', phone: INVITEE_PHONE, role: 'editor', status: 'suspended' },
    });
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '123456', 'ua');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已被停用');
  });

  it('停用判断先于邀请状态变更：邀请不被白烧', async () => {
    const { tenant, owner } = await mkTenant();
    await prisma.member.create({
      data: { tenantId: tenant.id, name: '被停用', phone: INVITEE_PHONE, role: 'editor', status: 'suspended' },
    });
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: INVITEE_PHONE });
    await mkCode(INVITEE_PHONE);
    await verifyLoginCode(INVITEE_PHONE, '123456', 'ua', inv.token);
    expect((await prisma.invite.findUnique({ where: { id: inv.id } }))?.status).toBe('pending');
  });
});

describe('邀请流 · peekInvite（登录页横幅）', () => {
  it('有效邀请 → 返回租户名与角色', async () => {
    const { tenant, owner } = await mkTenant('烽火台工作室');
    const inv = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, phone: INVITEE_PHONE, role: 'admin' });
    const p = await peekInvite(inv.token);
    expect(p).toMatchObject({ tenantName: '烽火台工作室', role: 'admin' });
  });

  it('过期/已用/不存在 → null（登录页降级为普通登录）', async () => {
    const { tenant, owner } = await mkTenant();
    const expired = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, expiresAt: new Date(Date.now() - 1) });
    const used = await mkInvite({ tenantId: tenant.id, invitedBy: owner.id, status: 'accepted' });
    expect(await peekInvite(expired.token)).toBeNull();
    expect(await peekInvite(used.token)).toBeNull();
    expect(await peekInvite('nope')).toBeNull();
  });
});

describe('登录 · 验证码基础契约', () => {
  it('手机号格式不合法 → 拒', async () => {
    expect((await verifyLoginCode('12345', '123456')).ok).toBe(false);
    expect((await requestLoginCode('12345')).ok).toBe(false);
  });

  it('验证码错误 → attempts 递增', async () => {
    await mkCode(INVITEE_PHONE);
    const r = await verifyLoginCode(INVITEE_PHONE, '000000');
    expect(r.ok).toBe(false);
    expect((await prisma.verificationCode.findFirst({ where: { phone: INVITEE_PHONE } }))?.attempts).toBe(1);
  });

  it('尝试 5 次后锁定，即使之后输对也拒', async () => {
    await mkCode(INVITEE_PHONE);
    for (let i = 0; i < 5; i++) await verifyLoginCode(INVITEE_PHONE, '000000');
    const r = await verifyLoginCode(INVITEE_PHONE, '123456');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('尝试次数过多');
  });

  it('验证码用后即焚：同一码不能登录两次', async () => {
    await mkCode(INVITEE_PHONE);
    expect((await verifyLoginCode(INVITEE_PHONE, '123456')).ok).toBe(true);
    expect((await verifyLoginCode(INVITEE_PHONE, '123456')).ok).toBe(false);
  });

  it('过期验证码 → 拒', async () => {
    await prisma.verificationCode.create({
      data: { phone: INVITEE_PHONE, code: '123456', expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await verifyLoginCode(INVITEE_PHONE, '123456')).ok).toBe(false);
  });

  it('新号无邀请 → 自动开通新租户 + 工作区 + 起始账号，角色 owner', async () => {
    await mkCode(INVITEE_PHONE);
    expect((await verifyLoginCode(INVITEE_PHONE, '123456')).ok).toBe(true);
    const m = await prisma.member.findUnique({ where: { phone: INVITEE_PHONE } });
    expect(m?.role).toBe('owner');
    const ws = await prisma.workspace.findFirst({ where: { tenantId: m!.tenantId } });
    expect(await prisma.creatorAccount.count({ where: { workspaceId: ws!.id } })).toBe(1);
  });

  it('dev Mock 通道回显验证码（零基础设施联调）', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await requestLoginCode(INVITEE_PHONE);
    expect(r.ok).toBe(true);
    expect(r.devCode).toMatch(/^\d{6}$/);
  });

  it('60s 冷却：同号连发第二次被拒', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await requestLoginCode(INVITEE_PHONE)).ok).toBe(true);
    const r = await requestLoginCode(INVITEE_PHONE);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('太频繁');
  });
});
