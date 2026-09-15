import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { getMemberByToken } from '@/lib/auth';

// 会话解析（token → 工作区 + 当前账号）的**行为**守卫。
//
// 【为什么要补这一组】2026-09-12 想把 getMemberByToken 里那三段串行查询
//（会话 → 工作区 → 账号）合并成一次嵌套查询：生产库跨区，每次往返 32ms，
// 三波就是 96ms，而它**挂在每一个已登录请求上**。
// 但翻遍 tests/ 只有一条源码级守卫（tests/perf/request-memoization.test.ts
// 断言它套了 cache()），**选账号那条回退链一条行为用例都没有**。
// 没有网就去改登录链路，等于蒙着眼睛动全站最不能错的那段：
// 账号选错的后果是「数据全看不见」（2026-07-25 / 07-27 两次真机事故都是它）。
//
// 所以先把现有语义逐条钉死、跑绿，再动实现——这组用例对实现方式不做任何假设，
// 换成一次嵌套查询也必须原样通过。

async function mkTenant(opts: { status?: string } = {}) {
  const tenant = await prisma.tenant.create({
    data: { name: `t-${crypto.randomBytes(4).toString('hex')}`, plan: 'free', status: opts.status ?? 'active' },
  });
  return tenant;
}

async function mkMember(tenantId: string, opts: { status?: string } = {}) {
  return prisma.member.create({
    data: { tenantId, name: '用户', role: 'owner', status: opts.status ?? 'active' },
  });
}

async function mkSession(memberId: string, ttlMs = 86_400_000) {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.authSession.create({ data: { token, memberId, expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

/** 按给定先后顺序建账号（createdAt 递增），回传 id 数组 */
async function mkAccounts(workspaceId: string, specs: { name: string; status?: string }[]) {
  const ids: string[] = [];
  for (const s of specs) {
    const a = await prisma.creatorAccount.create({
      data: { workspaceId, name: s.name, platform: 'douyin', status: s.status ?? 'active' },
    });
    ids.push(a.id);
    // createdAt 靠插入顺序区分；SQLite 时间戳精度足够，但同一毫秒内可能并列，
    // 这里逐条串行建 + 让出事件循环，保证顺序稳定（用例断的就是「最早那个」）
    await new Promise((r) => setTimeout(r, 2));
  }
  return ids;
}

describe('会话解析：工作区与当前账号怎么选', () => {
  let tenantId = '';
  let workspaceId = '';
  let memberId = '';
  let token = '';

  beforeEach(async () => {
    const tenant = await mkTenant();
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: '主工作区' } });
    const member = await mkMember(tenant.id);
    tenantId = tenant.id;
    workspaceId = ws.id;
    memberId = member.id;
    token = await mkSession(member.id);
  });

  it('没有 token 直接返回 null（不查库）', async () => {
    expect(await getMemberByToken(undefined)).toBeNull();
    expect(await getMemberByToken('')).toBeNull();
  });

  it('token 不存在 → null', async () => {
    expect(await getMemberByToken('不存在的-token')).toBeNull();
  });

  it('会话过期 → null（哪怕成员和租户都正常）', async () => {
    const expired = await mkSession(memberId, -1000);
    expect(await getMemberByToken(expired)).toBeNull();
  });

  it('成员被停用 → 已签发的会话立即失效', async () => {
    await prisma.member.update({ where: { id: memberId }, data: { status: 'disabled' } });
    expect(await getMemberByToken(token)).toBeNull();
  });

  it('租户被封禁 → 已签发的会话立即失效', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } });
    expect(await getMemberByToken(token)).toBeNull();
  });

  it('工作区不存在 → null', async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    expect(await getMemberByToken(token)).toBeNull();
  });

  it('多个工作区时取**建得最早**的那个', async () => {
    await new Promise((r) => setTimeout(r, 5));
    await prisma.workspace.create({ data: { tenantId, name: '后建的工作区' } });
    const m = await getMemberByToken(token);
    expect(m?.workspaceId).toBe(workspaceId);
  });

  it('没传 preferredAccountId → 取最早的 active 账号', async () => {
    const [first, second] = await mkAccounts(workspaceId, [{ name: 'A' }, { name: 'B' }]);
    const m = await getMemberByToken(token);
    expect(m?.accountId).toBe(first);
    expect(m?.accountId).not.toBe(second);
  });

  it('传了 preferredAccountId 且它是本工作区的 active 账号 → 用它', async () => {
    const [first, second] = await mkAccounts(workspaceId, [{ name: 'A' }, { name: 'B' }]);
    const m = await getMemberByToken(token, second);
    expect(m?.accountId).toBe(second);
    expect(first).not.toBe(second);
  });

  it('preferredAccountId 已归档 → 退回最早的 active 账号（不是报错、也不是空）', async () => {
    const [first, archived] = await mkAccounts(workspaceId, [{ name: 'A' }, { name: 'B', status: 'archived' }]);
    const m = await getMemberByToken(token, archived);
    expect(m?.accountId).toBe(first);
  });

  it('preferredAccountId 属于**别的工作区** → 不许跨工作区串号，退回本区账号', async () => {
    const otherTenant = await mkTenant();
    const otherWs = await prisma.workspace.create({ data: { tenantId: otherTenant.id, name: '别人的工作区' } });
    const [outsider] = await mkAccounts(otherWs.id, [{ name: '别人的号' }]);
    const [mine] = await mkAccounts(workspaceId, [{ name: '我的号' }]);
    const m = await getMemberByToken(token, outsider);
    expect(m?.accountId).toBe(mine);
    expect(m?.workspaceId).toBe(workspaceId);
  });

  it('全部账号都被归档 → 兜底取最早的那个（保证会话仍可用，不是空字符串）', async () => {
    const [first] = await mkAccounts(workspaceId, [
      { name: 'A', status: 'archived' },
      { name: 'B', status: 'archived' },
    ]);
    const m = await getMemberByToken(token);
    expect(m?.accountId).toBe(first);
  });

  it('一个账号都没有 → accountId 为空串，但会话本身仍然有效', async () => {
    const m = await getMemberByToken(token);
    expect(m).not.toBeNull();
    expect(m?.accountId).toBe('');
    expect(m?.workspaceId).toBe(workspaceId);
  });

  it('回传的身份字段齐全且来自正确的行', async () => {
    const [acc] = await mkAccounts(workspaceId, [{ name: 'A' }]);
    const m = await getMemberByToken(token);
    expect(m).toMatchObject({
      memberId,
      tenantId,
      workspaceId,
      accountId: acc,
      memberName: '用户',
      role: 'owner',
    });
    // plan 走 effectivePlan（到期降级），不是 DB 里那个原值——只断它有值
    expect(typeof m?.plan).toBe('string');
  });

  it('滑动续期：剩余寿命不足一半时把会话延长（活跃用户不掉线）', async () => {
    const shortLived = await mkSession(memberId, 10 * 24 * 3600 * 1000); // 远小于 90 天的一半
    const before = await prisma.authSession.findUnique({ where: { token: shortLived } });
    await getMemberByToken(shortLived);
    const after = await prisma.authSession.findUnique({ where: { token: shortLived } });
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
  });

  it('寿命还够时不写库（别把每次读都变成一次写）', async () => {
    const fresh = await mkSession(memberId, 89 * 24 * 3600 * 1000); // 剩余 > 一半
    const before = await prisma.authSession.findUnique({ where: { token: fresh } });
    await getMemberByToken(fresh);
    const after = await prisma.authSession.findUnique({ where: { token: fresh } });
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
  });
});
