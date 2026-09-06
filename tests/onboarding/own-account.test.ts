import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 开场向导第一步必须把「自己的账号」真的建出来。
//
// 2026-09-06 用户原话「新注册的账号，没有增加一个自己的账号？」：注册建的是「我的账号 / multi / 无 handle」占位行，
// 向导原先只往占位行上写 platform/handle、名字不动，没贴链接时更是一字不动——顶栏与账号管理里
// 永远是「我的账号 · 多平台」。这里钉死三种情形的结果，只看库里那一行，不看文案。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
const cookieJar = new Map<string, string>();
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (k: string) => (cookieJar.has(k) ? { value: cookieJar.get(k) } : undefined), set: (k: string, v: string) => cookieJar.set(k, v) }) }));
// 派采集那截不是本测试的对象：固定「没有执行器在线」，向导只记账号、如实说派不出去
vi.mock('@/lib/browser-task/vet', () => ({ vetBrowserTaskArgs: async () => ({ ok: false, error: '没有在线的客户端或插件' }) }));

async function base(account: { platform: string; handle?: string | null; name?: string } = { platform: 'multi' }) {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.deleteMany({ where: { workspaceId: 'w1' } });
  await prisma.creatorAccount.create({
    data: { id: 'a1', workspaceId: 'w1', name: account.name ?? '我的账号', platform: account.platform, handle: account.handle ?? null, personaCard: '{}' },
  });
}

beforeEach(async () => {
  session.accountId = 'a1';
  cookieJar.clear();
});

describe('开场向导：自己的账号', () => {
  it('贴了 X 主页 → 占位行升级成「X @handle」，不另建第二条', async () => {
    await base();
    const { actOnboardingProfile } = await import('@/app/(app)/onboarding/actions');
    const r = await actOnboardingProfile({ niche: '数码测评', platforms: ['x'], profileUrl: 'https://x.com/jiangwh' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile?.ok).toBe(true);
    expect(r.profile?.note).toContain('X @jiangwh');
    const rows = await prisma.creatorAccount.findMany({ where: { workspaceId: 'w1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a1', platform: 'x', handle: 'jiangwh', name: 'X @jiangwh' });
  });

  it('没贴链接、只选了一个主战平台 → 占位行标成那个平台，并明说还没记下主页', async () => {
    await base();
    const { actOnboardingProfile } = await import('@/app/(app)/onboarding/actions');
    const r = await actOnboardingProfile({ niche: '数码测评', platforms: ['x'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile).not.toBeNull(); // 原先这里是 null，向导什么都不显示
    expect(r.profile?.ok).toBe(false);
    expect(r.profile?.note).toContain('还没记下');
    const row = await prisma.creatorAccount.findUniqueOrThrow({ where: { id: 'a1' } });
    expect(row.platform).toBe('x');
    expect(row.handle).toBeNull();
  });

  it('没贴链接、选了两个平台 → 不替用户猜，占位行仍是 multi', async () => {
    await base();
    const { actOnboardingProfile } = await import('@/app/(app)/onboarding/actions');
    await actOnboardingProfile({ niche: '数码测评', platforms: ['x', 'douyin'] });
    const row = await prisma.creatorAccount.findUniqueOrThrow({ where: { id: 'a1' } });
    expect(row.platform).toBe('multi');
  });

  it('当前账号已是别的号 → 另建一条并把当前账号切过去，原账号一字不动', async () => {
    await base({ platform: 'douyin', handle: 'MS4wLjABAAAA_old', name: '抖音 @MS4wLjABAAAA_old' });
    const { actOnboardingProfile } = await import('@/app/(app)/onboarding/actions');
    const r = await actOnboardingProfile({ niche: '数码测评', platforms: ['x'], profileUrl: 'https://x.com/jiangwh' });
    expect(r.ok).toBe(true);
    const rows = await prisma.creatorAccount.findMany({ where: { workspaceId: 'w1' }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'a1', platform: 'douyin', handle: 'MS4wLjABAAAA_old' });
    expect(rows[1]).toMatchObject({ platform: 'x', handle: 'jiangwh', name: 'X @jiangwh' });
    expect(cookieJar.get('beacon_account')).toBe(rows[1].id);
  });

  it('重跑向导贴同一个主页 → 幂等，不多建', async () => {
    await base({ platform: 'x', handle: 'jiangwh', name: 'X @jiangwh' });
    const { actOnboardingProfile } = await import('@/app/(app)/onboarding/actions');
    await actOnboardingProfile({ niche: '数码测评', platforms: ['x'], profileUrl: 'https://x.com/jiangwh' });
    expect(await prisma.creatorAccount.count({ where: { workspaceId: 'w1' } })).toBe(1);
  });

  it('链接认不出 → 不写 handle，文案说清认得哪些形态；他明选的唯一平台照样落上', async () => {
    await base();
    const { actOnboardingProfile } = await import('@/app/(app)/onboarding/actions');
    const r = await actOnboardingProfile({ niche: '数码测评', platforms: ['x'], profileUrl: 'https://v.douyin.com/abc123' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.profile?.ok).toBe(false);
    expect(r.profile?.note).toContain('短链认不出');
    const row = await prisma.creatorAccount.findUniqueOrThrow({ where: { id: 'a1' } });
    expect(row.platform).toBe('x');
    expect(row.handle).toBeNull();
    expect(row.name).toBe('我的账号');
  });
});
