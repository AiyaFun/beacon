import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { can } from '@/lib/edition';

// 本机密码登录（个人创作者小站）。
//
// 【为什么有这条通道】appliance 的 OA 是可选步、一次性登录链接要「已登录的管理员」
// 才能生成——个人用户（没有企业应用）会话一过期就被锁在门外只能重装。
// 【最不能松的三条】
// ① SaaS 恒关：那边有短信/微信，多一条密码通道只是多一个撞库面——UI 不渲染 + action 硬闸两道；
// ② 防枚举：名字对不对/设没设过密码/密码错，从外面必须看不出来（统一文案）；
// ③ 同名撞车不猜：>1 个同名成员密码都对上时拒绝，猜着登等于把 A 的会话发给 B。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// server action 里的 headers()/cookies() 只在请求上下文里活——测试里给一对哑实现
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'vitest' }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

afterEach(() => vi.unstubAllEnvs());

describe('scrypt 哈希与校验', () => {
  it('往返：正确密码过，错的不过', async () => {
    const h = await hashPassword('correct-horse-8');
    expect(h.startsWith('scrypt:')).toBe(true);
    expect(await verifyPassword('correct-horse-8', h)).toBe(true);
    expect(await verifyPassword('wrong-password!', h)).toBe(false);
  });

  it('两次哈希同一密码得到不同串（盐随机），且互相都能验证', async () => {
    const a = await hashPassword('same-password-1');
    const b = await hashPassword('same-password-1');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-1', a)).toBe(true);
    expect(await verifyPassword('same-password-1', b)).toBe(true);
  });

  it('坏输入一律 false 不抛：null / 空串 / 坏格式 / 参数超界（DoS 闸）', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt:whatever')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:not:enough')).toBe(false);
    // N=2^30 的串：一次校验就要 ~128G 内存，参数闸必须直接拒绝
    const salt = Buffer.from('0123456789abcdef').toString('base64');
    expect(await verifyPassword('x', `scrypt:${2 ** 30}:8:1:${salt}:${salt}`)).toBe(false);
  });

  it('DoS 防线必须是两道都在：参数上限闸 + maxmem 天花板（mutation 掉一道另一道会兜住，源码级各钉一条）', () => {
    const src = read('lib/auth/password.ts');
    expect(src).toMatch(/n > 1 << 20/);
    expect(src).toMatch(/maxmem: 256 \* 1024 \* 1024/);
  });

  it(`短于 ${MIN_PASSWORD_LENGTH} 位不给设`, async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });
});

describe('能力矩阵：SaaS 恒关，两个企业版都开', () => {
  it.each([
    ['saas', false],
    ['appliance', true],
    ['private', true],
  ])('%s → passwordLogin=%s', (ed, expected) => {
    vi.stubEnv('BEACON_EDITION', ed);
    expect(can('passwordLogin')).toBe(expected);
  });
});

describe('actPasswordLogin', () => {
  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'enterprise' } });
    await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  });

  async function alice(password = 'alice-pass-8', name = '爱丽丝') {
    return prisma.member.create({
      data: { tenantId: 't1', name, role: 'owner', status: 'active', passwordHash: await hashPassword(password) },
    });
  }

  it('SaaS 上端点硬闸拒绝（UI 藏起来不算防线）', async () => {
    vi.stubEnv('BEACON_EDITION', 'saas');
    const { actPasswordLogin } = await import('@/app/login/actions');
    const r = await actPasswordLogin('爱丽丝', 'whatever-123');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('本版本不提供');
  });

  it('appliance：对的名字+密码 → 签发会话', async () => {
    vi.stubEnv('BEACON_EDITION', 'appliance');
    await alice();
    const { actPasswordLogin } = await import('@/app/login/actions');
    const r = await actPasswordLogin('爱丽丝', 'alice-pass-8');
    expect(r.ok).toBe(true);
    expect(await prisma.authSession.count()).toBeGreaterThan(0);
  });

  it('防枚举：名字不存在 / 没设密码 / 密码错，文案一字不差', async () => {
    vi.stubEnv('BEACON_EDITION', 'appliance');
    await alice();
    await prisma.member.create({ data: { tenantId: 't1', name: '没密码', role: 'editor', status: 'active' } });
    const { actPasswordLogin } = await import('@/app/login/actions');
    const wrongPwd = await actPasswordLogin('爱丽丝', 'wrong-password');
    const noSuch = await actPasswordLogin('查无此人', 'alice-pass-8');
    const noPwd = await actPasswordLogin('没密码', 'alice-pass-8');
    expect(wrongPwd.ok).toBe(false);
    expect(noSuch.message).toBe(wrongPwd.message);
    expect(noPwd.message).toBe(wrongPwd.message);
  });

  it('停用成员（status≠active）不能登录', async () => {
    vi.stubEnv('BEACON_EDITION', 'appliance');
    const m = await alice();
    await prisma.member.update({ where: { id: m.id }, data: { status: 'suspended' } });
    const { actPasswordLogin } = await import('@/app/login/actions');
    expect((await actPasswordLogin('爱丽丝', 'alice-pass-8')).ok).toBe(false);
  });

  it('同名成员密码撞车：拒绝并说清怎么解，绝不猜着发会话', async () => {
    vi.stubEnv('BEACON_EDITION', 'appliance');
    await alice('same-pass-88', '重名');
    await alice('same-pass-88', '重名');
    const { actPasswordLogin } = await import('@/app/login/actions');
    const before = await prisma.authSession.count();
    const r = await actPasswordLogin('重名', 'same-pass-88');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('同名');
    expect(await prisma.authSession.count()).toBe(before);
  });
});

describe('装机向导与登录页的接线', () => {
  it('setup 必设密码：action 校验最短长度并把 passwordHash 写进 owner', () => {
    const src = read('app/setup/actions.ts');
    expect(src).toMatch(/MIN_PASSWORD_LENGTH/);
    expect(src).toMatch(/passwordHash,/);
    // 向导 UI 的下一步按钮把密码长度与两次一致钉进 disabled 条件
    const wizard = read('app/setup/SetupWizard.tsx');
    expect(wizard).toMatch(/password\.length < 8 \|\| password !== password2/);
  });

  it('登录页：有人设过密码才渲染表单（没人设过不摆必然失败的表单）', () => {
    const panel = read('app/login/OaLoginPanel.tsx');
    expect(panel).toMatch(/passwordHash: \{ not: null \}/);
    expect(panel).toMatch(/showPassword && \(/);
    expect(panel).toMatch(/can\('passwordLogin'\)/);
  });

  it('改密码要先过旧密码（会话可能被借用，旧密码是最后一道身份复核）', () => {
    const src = read('app/(app)/settings/password-actions.ts');
    expect(src).toMatch(/if \(me\.passwordHash\) \{/);
    expect(src).toMatch(/verifyPassword\(oldPassword \?\? '', me\.passwordHash\)/);
    expect(src).toMatch(/assertCan\('passwordLogin'\)/);
  });
});
