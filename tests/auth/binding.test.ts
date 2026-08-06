import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  bindWechatToMember,
  bindPhoneToMember,
  unbindWechatFromMember,
  unbindPhoneFromMember,
  consumeVerificationCode,
  getMemberByToken,
} from '@/lib/auth';
import { DEMO_TENANT_ID } from '@/lib/demo/guard';

// 账号绑定（手机号/微信）+ 会话滑动续期。跑在真 SQLite 上——
// 要验的正是 DB 语义：wechatOpenId/phone 唯一约束、expiresAt 的时间写入。

const PHONE_A = '13800001001';
const PHONE_B = '13900001002';
const OPENID_A = 'wx-openid-aaa';
const OPENID_B = 'wx-openid-bbb';

async function mkUser(opts: { phone?: string | null; wechatOpenId?: string | null; tenantId?: string } = {}) {
  const tenant = opts.tenantId
    ? await prisma.tenant.create({ data: { id: opts.tenantId, name: '演示', plan: 'personal' } })
    : await prisma.tenant.create({ data: { name: '测试工作区', plan: 'free' } });
  await prisma.workspace.create({ data: { tenantId: tenant.id, name: '主工作区' } });
  const member = await prisma.member.create({
    data: {
      tenantId: tenant.id,
      name: '用户',
      phone: opts.phone ?? null,
      wechatOpenId: opts.wechatOpenId ?? null,
      role: 'owner',
    },
  });
  return { tenant, member };
}

async function mkSession(memberId: string, ttlMs: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.authSession.create({
    data: { token, memberId, expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

const DAY = 24 * 3600 * 1000;

beforeEach(async () => {
  await prisma.authSession.deleteMany();
  await prisma.verificationCode.deleteMany();
  await prisma.member.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('bindWechatToMember', () => {
  it('未占用的 openid 绑定成功', async () => {
    const { member } = await mkUser({ phone: PHONE_A });
    const r = await bindWechatToMember(member.id, OPENID_A);
    expect(r.ok).toBe(true);
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.wechatOpenId).toBe(OPENID_A);
  });

  it('重复绑定自己幂等成功', async () => {
    const { member } = await mkUser({ phone: PHONE_A, wechatOpenId: OPENID_A });
    const r = await bindWechatToMember(member.id, OPENID_A);
    expect(r.ok).toBe(true);
  });

  it('openid 已被其他账号占用时拒绝', async () => {
    await mkUser({ phone: PHONE_B, wechatOpenId: OPENID_A });
    const { member } = await mkUser({ phone: PHONE_A });
    const r = await bindWechatToMember(member.id, OPENID_A);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已绑定其他账号');
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.wechatOpenId).toBeNull();
  });
});

describe('bindPhoneToMember', () => {
  it('微信用户补绑手机号成功', async () => {
    const { member } = await mkUser({ wechatOpenId: OPENID_B });
    const r = await bindPhoneToMember(member.id, PHONE_A);
    expect(r.ok).toBe(true);
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.phone).toBe(PHONE_A);
  });

  it('手机号已被其他账号占用时拒绝', async () => {
    await mkUser({ phone: PHONE_A });
    const { member } = await mkUser({ wechatOpenId: OPENID_B });
    const r = await bindPhoneToMember(member.id, PHONE_A);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已注册其他账号');
  });

  it('手机号格式不正确时拒绝', async () => {
    const { member } = await mkUser({ wechatOpenId: OPENID_B });
    const r = await bindPhoneToMember(member.id, '12345');
    expect(r.ok).toBe(false);
  });
});

describe('换绑（覆盖自己的旧绑定）', () => {
  it('已有手机号的成员换绑新手机号，旧号释放', async () => {
    const { member } = await mkUser({ phone: PHONE_A, wechatOpenId: OPENID_A });
    const r = await bindPhoneToMember(member.id, PHONE_B);
    expect(r.ok).toBe(true);
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.phone).toBe(PHONE_B);
    // 旧号已释放，可被他人绑定
    const { member: other } = await mkUser({ wechatOpenId: OPENID_B });
    expect((await bindPhoneToMember(other.id, PHONE_A)).ok).toBe(true);
  });

  it('已绑微信的成员换绑新微信（覆盖）', async () => {
    const { member } = await mkUser({ phone: PHONE_A, wechatOpenId: OPENID_A });
    const r = await bindWechatToMember(member.id, OPENID_B);
    expect(r.ok).toBe(true);
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.wechatOpenId).toBe(OPENID_B);
  });
});

describe('解绑（至少保留一种登录方式）', () => {
  it('双绑定时可解绑微信', async () => {
    const { member } = await mkUser({ phone: PHONE_A, wechatOpenId: OPENID_A });
    const r = await unbindWechatFromMember(member.id);
    expect(r.ok).toBe(true);
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.wechatOpenId).toBeNull();
    expect(after?.phone).toBe(PHONE_A);
  });

  it('双绑定时可解绑手机号', async () => {
    const { member } = await mkUser({ phone: PHONE_A, wechatOpenId: OPENID_A });
    const r = await unbindPhoneFromMember(member.id);
    expect(r.ok).toBe(true);
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.phone).toBeNull();
    expect(after?.wechatOpenId).toBe(OPENID_A);
  });

  it('仅绑微信时拒绝解绑微信（防锁死）', async () => {
    const { member } = await mkUser({ wechatOpenId: OPENID_A });
    const r = await unbindWechatFromMember(member.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('至少要保留一种登录方式');
    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.wechatOpenId).toBe(OPENID_A);
  });

  it('仅绑手机号时拒绝解绑手机号（防锁死）', async () => {
    const { member } = await mkUser({ phone: PHONE_A });
    const r = await unbindPhoneFromMember(member.id);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('至少要保留一种登录方式');
  });

  it('解绑本就未绑定的方式幂等成功', async () => {
    const { member } = await mkUser({ phone: PHONE_A });
    expect((await unbindWechatFromMember(member.id)).ok).toBe(true);
  });
});

describe('consumeVerificationCode', () => {
  it('有效码消费成功，二次消费拒绝', async () => {
    await prisma.verificationCode.create({
      data: { phone: PHONE_A, code: '123456', expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    const first = await consumeVerificationCode(PHONE_A, '123456');
    expect(first.ok).toBe(true);
    const second = await consumeVerificationCode(PHONE_A, '123456');
    expect(second.ok).toBe(false);
  });

  it('错误码拒绝且计入尝试次数', async () => {
    await prisma.verificationCode.create({
      data: { phone: PHONE_A, code: '123456', expiresAt: new Date(Date.now() + 5 * 60_000) },
    });
    const r = await consumeVerificationCode(PHONE_A, '000000');
    expect(r.ok).toBe(false);
    const rec = await prisma.verificationCode.findFirst({ where: { phone: PHONE_A } });
    expect(rec?.attempts).toBe(1);
    expect(rec?.consumed).toBe(false);
  });
});

describe('会话滑动续期（getMemberByToken）', () => {
  it('剩余寿命不足一半时延长到满额', async () => {
    const { member } = await mkUser({ phone: PHONE_A });
    const token = await mkSession(member.id, 10 * DAY); // 剩 10 天 < 45 天
    const resolved = await getMemberByToken(token);
    expect(resolved?.memberId).toBe(member.id);
    const after = await prisma.authSession.findUnique({ where: { token } });
    // 续期后应远超原 10 天（≈90 天）
    expect(after!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 80 * DAY);
  });

  it('剩余寿命充足时不动', async () => {
    const { member } = await mkUser({ phone: PHONE_A });
    const token = await mkSession(member.id, 80 * DAY); // 剩 80 天 > 45 天
    const before = await prisma.authSession.findUnique({ where: { token } });
    await getMemberByToken(token);
    const after = await prisma.authSession.findUnique({ where: { token } });
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
  });

  it('演示租户的会话不续期（游客体验会话保持 1 天短命）', async () => {
    const { member } = await mkUser({ tenantId: DEMO_TENANT_ID });
    const token = await mkSession(member.id, 0.5 * DAY);
    const before = await prisma.authSession.findUnique({ where: { token } });
    const resolved = await getMemberByToken(token);
    expect(resolved?.memberId).toBe(member.id);
    const after = await prisma.authSession.findUnique({ where: { token } });
    expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
  });

  it('过期会话直接拒绝', async () => {
    const { member } = await mkUser({ phone: PHONE_A });
    const token = await mkSession(member.id, -1000);
    expect(await getMemberByToken(token)).toBeNull();
  });
});
