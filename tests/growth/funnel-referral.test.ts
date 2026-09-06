import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { recordFunnelEvent, recordFunnelOnce, funnelSummary, isFunnelEvent, normalizeVisitorId, normalizeFunnelPath } from '@/lib/growth/funnel';
import { applyReferral, ensureReferralCode, extendPlan, normalizeReferralCode, REFERRAL_DAYS, REFERRAL_MONTHLY_CAP } from '@/lib/growth/referral';
import { DAY_MS } from '@/lib/pay/plan';

// 漏斗事件 + 邀请奖励（2026-09-05）。行为测试：建数据 → 调用 → 断言库里的样子。

beforeEach(async () => {
  await prisma.funnelEvent.deleteMany();
  await prisma.referralGrant.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

async function tenant(plan: string, expiresAt: Date | null, name = 't') {
  const t = await prisma.tenant.create({ data: { name, plan, planExpiresAt: expiresAt } });
  await prisma.workspace.create({ data: { tenantId: t.id, name: 'ws' } });
  return t;
}

describe('漏斗事件', () => {
  it('白名单之外的名字不落库', async () => {
    expect(isFunnelEvent('landing_view')).toBe(true);
    expect(isFunnelEvent('drop table')).toBe(false);
    // @ts-expect-error 故意传非法名字
    expect(await recordFunnelEvent({ name: 'nope' })).toBe(false);
    expect(await prisma.funnelEvent.count()).toBe(0);
  });

  it('不记查询串、访客串只认自己生成的形状', async () => {
    expect(normalizeFunnelPath('/desktop?utm=x#y')).toBe('/desktop');
    expect(normalizeVisitorId('abc')).toBeNull(); // 太短
    expect(normalizeVisitorId('7f3c9a1e-2b4d-4c6e-9f10-abcdef012345')).toBe('7f3c9a1e-2b4d-4c6e-9f10-abcdef012345');
    expect(normalizeVisitorId('<script>')).toBeNull();
  });

  it('recordFunnelOnce 同租户同事件只记一次', async () => {
    const t = await tenant('trial', new Date(Date.now() + 10 * DAY_MS));
    expect(await recordFunnelOnce({ name: 'first_recommendation', tenantId: t.id })).toBe(true);
    expect(await recordFunnelOnce({ name: 'first_recommendation', tenantId: t.id })).toBe(false);
    expect(await prisma.funnelEvent.count({ where: { tenantId: t.id } })).toBe(1);
  });

  it('汇总按独立访客算转化率，分母为 0 给 null 不给 0%', async () => {
    for (const v of ['visitor-aaaaaaaa', 'visitor-bbbbbbbb', 'visitor-aaaaaaaa']) await recordFunnelEvent({ name: 'landing_view', visitorId: v });
    await recordFunnelEvent({ name: 'demo_click', visitorId: 'visitor-aaaaaaaa' });
    await recordFunnelEvent({ name: 'download_click', visitorId: 'visitor-aaaaaaaa', meta: 'mac' });
    const s = await funnelSummary(7);
    const landing = s.steps.find((x) => x.name === 'landing_view')!;
    const demo = s.steps.find((x) => x.name === 'demo_click')!;
    const code = s.steps.find((x) => x.name === 'code_sent')!;
    expect(landing.visitors).toBe(2);
    expect(landing.count).toBe(3);
    expect(demo.fromPrevPct).toBe(50);
    expect(code.visitors).toBe(0);
    // code_sent 为 0 之后的一步，分母是 0 → null
    const reg = s.steps.find((x) => x.name === 'register_ok')!;
    expect(reg.fromPrevPct).toBeNull();
    expect(s.downloads).toEqual([{ meta: 'mac', count: 1 }]);
  });
});

describe('邀请奖励', () => {
  it('邀请码形状：8 位、无 0/O/1/I；normalize 接受小写', () => {
    expect(normalizeReferralCode('abcdefgh')).toBe('ABCDEFGH');
    expect(normalizeReferralCode('ABCDEFG0')).toBeNull();
    expect(normalizeReferralCode('ABC')).toBeNull();
  });

  it('extendPlan：free 给新试用；trial/付费顺延；买断与企业不动', () => {
    const now = new Date('2026-09-05T00:00:00Z');
    const a = extendPlan('free', null, 7, now);
    expect(a).toEqual({ plan: 'trial', planExpiresAt: new Date(now.getTime() + 7 * DAY_MS) });
    const exp = new Date(now.getTime() + 10 * DAY_MS);
    expect(extendPlan('trial', exp, 7, now)).toEqual({ plan: 'trial', planExpiresAt: new Date(exp.getTime() + 7 * DAY_MS) });
    expect(extendPlan('personal', exp, 7, now)).toEqual({ plan: 'personal', planExpiresAt: new Date(exp.getTime() + 7 * DAY_MS) });
    // 过期的付费档按 free 处理：给新试用
    expect(extendPlan('personal', new Date(now.getTime() - DAY_MS), 7, now)).toEqual({ plan: 'trial', planExpiresAt: new Date(now.getTime() + 7 * DAY_MS) });
    expect('skip' in extendPlan('byok', new Date(now.getTime() + 99 * 365 * DAY_MS), 7, now)).toBe(true);
    expect('skip' in extendPlan('enterprise', null, 7, now)).toBe(true);
  });

  it('双方各得天数、落 ReferralGrant、邀请方收到通知', async () => {
    const now = new Date();
    const inviter = await tenant('trial', new Date(now.getTime() + 10 * DAY_MS), 'inviter');
    const invitee = await tenant('trial', new Date(now.getTime() + 30 * DAY_MS), 'invitee');
    const code = await ensureReferralCode(inviter.id);
    expect(await ensureReferralCode(inviter.id)).toBe(code); // 幂等
    const r = await applyReferral(invitee.id, code.toLowerCase(), now);
    expect(r.ok).toBe(true);
    const a = await prisma.tenant.findUnique({ where: { id: inviter.id } });
    const b = await prisma.tenant.findUnique({ where: { id: invitee.id } });
    expect(a!.planExpiresAt!.getTime()).toBe(now.getTime() + 17 * DAY_MS);
    expect(b!.planExpiresAt!.getTime()).toBe(now.getTime() + 37 * DAY_MS);
    expect(b!.referredBy).toBe(inviter.id);
    expect(await prisma.referralGrant.count({ where: { inviterTenantId: inviter.id, inviteeTenantId: invitee.id, days: REFERRAL_DAYS } })).toBe(1);
    expect(await prisma.notification.count({ where: { refId: `referral:${invitee.id}` } })).toBe(1);
  });

  it('🔒 自邀无效；同一新租户只奖一次；无效码不动任何东西', async () => {
    const now = new Date();
    const inviter = await tenant('trial', new Date(now.getTime() + 10 * DAY_MS), 'inviter');
    const invitee = await tenant('trial', new Date(now.getTime() + 30 * DAY_MS), 'invitee');
    const code = await ensureReferralCode(inviter.id);
    expect((await applyReferral(inviter.id, code, now)).ok).toBe(false);
    expect((await applyReferral(invitee.id, 'ZZZZZZZZ', now)).ok).toBe(false);
    expect((await applyReferral(invitee.id, code, now)).ok).toBe(true);
    expect((await applyReferral(invitee.id, code, now)).ok).toBe(false);
    const b = await prisma.tenant.findUnique({ where: { id: invitee.id } });
    expect(b!.planExpiresAt!.getTime()).toBe(now.getTime() + 37 * DAY_MS); // 只加了一次
  });

  it('🔒 邀请方每月上限', async () => {
    const now = new Date();
    const inviter = await tenant('trial', new Date(now.getTime() + 10 * DAY_MS), 'inviter');
    const code = await ensureReferralCode(inviter.id);
    for (let i = 0; i < REFERRAL_MONTHLY_CAP; i += 1) {
      await prisma.referralGrant.create({ data: { inviterTenantId: inviter.id, inviteeTenantId: `x${i}`, days: 7 } });
    }
    const invitee = await tenant('trial', new Date(now.getTime() + 30 * DAY_MS), 'invitee');
    const r = await applyReferral(invitee.id, code, now);
    expect(r.ok).toBe(false);
    expect((await prisma.tenant.findUnique({ where: { id: invitee.id } }))!.planExpiresAt!.getTime()).toBe(now.getTime() + 30 * DAY_MS);
  });
});
