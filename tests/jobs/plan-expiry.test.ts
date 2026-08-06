import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { DEMO_TENANT_ID, DEMO_WORKSPACE_ID } from '@/lib/demo/guard';
import { DAY_MS } from '@/lib/pay/plan';

// plan_expiry_notice：手动续费模式下唯一会主动告诉用户「该续费了」的东西。
// 之前它不存在，而付费协议里写着「到期前系统会通过邮件/微信/站内信提醒」——
// 本文件锁住那句承诺现在真的由代码兑现，且不会变成骚扰。

const pushed: { workspaceId: string; event: string }[] = [];
vi.mock('@/lib/bot', () => ({
  pushEvent: async (workspaceId: string, event: string) => {
    pushed.push({ workspaceId, event });
    return { sent: 1 };
  },
  beaconUrl: (p = '') => `https://beacon.example.com${p}`,
}));

const { HANDLERS } = await import('@/lib/jobs/handlers');

async function mkTenant(opts: { plan: string; daysLeft: number | null; id?: string }) {
  const tenant = await prisma.tenant.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      name: 't',
      plan: opts.plan,
      planExpiresAt: opts.daysLeft === null ? null : new Date(Date.now() + opts.daysLeft * DAY_MS),
    },
  });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  return { tenantId: tenant.id, workspaceId: ws.id };
}

beforeEach(async () => {
  pushed.length = 0;
  await prisma.jobRun.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.member.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('plan_expiry_notice', () => {
  it('将到期租户 → 站内信 + 机器人各一条', async () => {
    const { workspaceId } = await mkTenant({ plan: 'personal', daysLeft: 2 });
    const r = await HANDLERS.plan_expiry_notice({});

    const notes = await prisma.notification.findMany({ where: { workspaceId, kind: 'plan_expiry' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toContain('标准版');
    expect(notes[0].link).toBe('/billing');
    expect(pushed).toEqual([{ workspaceId, event: 'plan_expiry' }]);
    expect(r.detail).toContain('提醒 1 个');
  });

  it('同一档重复跑不重复发（幂等）', async () => {
    const { workspaceId } = await mkTenant({ plan: 'personal', daysLeft: 2 });
    await HANDLERS.plan_expiry_notice({});
    await HANDLERS.plan_expiry_notice({});
    expect(await prisma.notification.count({ where: { workspaceId, kind: 'plan_expiry' } })).toBe(1);
  });

  it('临近下一档 → 再发一条（d3 之后还有 d1）', async () => {
    const { workspaceId, tenantId } = await mkTenant({ plan: 'personal', daysLeft: 3 });
    await HANDLERS.plan_expiry_notice({});
    // 时间推进到只剩 1 天：直接改到期日模拟
    await prisma.tenant.update({ where: { id: tenantId }, data: { planExpiresAt: new Date(Date.now() + 1 * DAY_MS) } });
    await HANDLERS.plan_expiry_notice({});
    // ⚠️ 改到期日 = 换了周期（refId 含到期时刻），所以这里是新周期的第一条，仍只有各自一条
    const notes = await prisma.notification.findMany({ where: { workspaceId, kind: 'plan_expiry' }, orderBy: { createdAt: 'asc' } });
    expect(notes).toHaveLength(2);
    expect(notes[1].title).toContain('今天到期');
  });

  it('免费档 / 无到期日 / 远期买断都不提醒', async () => {
    await mkTenant({ plan: 'free', daysLeft: 1 });
    await mkTenant({ plan: 'enterprise', daysLeft: null });
    await mkTenant({ plan: 'byok', daysLeft: 1188 * 30 });
    const r = await HANDLERS.plan_expiry_notice({});
    expect(await prisma.notification.count()).toBe(0);
    expect(r.detail).toContain('扫描 0 个');
  });

  it('演示租户不发续费提醒', async () => {
    const tenant = await prisma.tenant.create({
      data: { id: DEMO_TENANT_ID, name: 'demo', plan: 'personal', planExpiresAt: new Date(Date.now() + DAY_MS) },
    });
    await prisma.workspace.create({ data: { id: DEMO_WORKSPACE_ID, tenantId: tenant.id, name: 'demo' } });
    await HANDLERS.plan_expiry_notice({});
    expect(await prisma.notification.count()).toBe(0);
  });

  it('一个租户炸掉不连坐其余租户', async () => {
    await mkTenant({ plan: 'personal', daysLeft: 2 }); // 正常
    const bad = await mkTenant({ plan: 'personal', daysLeft: 2 });
    // 制造一个会抛错的租户：删掉它的工作区记录之外的路径不好造，
    // 改用 spy 让第一个 pushEvent 抛错，验证 per-tenant try/catch 生效
    const bot = await import('@/lib/bot');
    const spy = vi.spyOn(bot, 'pushEvent').mockImplementationOnce(async () => {
      throw new Error('机器人挂了');
    });
    const r = await HANDLERS.plan_expiry_notice({});
    expect(r.detail).toContain('失败 1');
    expect(r.detail).toContain('提醒 1 个');
    expect(await prisma.jobRun.count({ where: { name: 'plan_expiry_notice', status: 'ok' } })).toBe(1);
    spy.mockRestore();
    expect(bad.tenantId).toBeTruthy();
  });
});
