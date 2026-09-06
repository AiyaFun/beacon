import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { crawlOneCompetitor } from '@/lib/pipeline';
import { wechatQuotaStatus, canUseWechatPlatformSource } from '@/lib/pay/datasource-quota';
import { DAY_MS } from '@/lib/pay/plan';

// 平台代付公众号配额的**行为**测试（2026-09-05）。源码扫描守不住「有没有真的执行」——
// 变异验证时把闸门改成 if (false) 照样绿。所以这里建数据 → 调 crawlOneCompetitor → 看台账。

beforeEach(async () => {
  await prisma.collectionRun.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  vi.stubEnv('BEACON_NEWRANK_KEY', 'test-key');
  // 万一闸门没拦住，真适配器会出网——这里让它当场失败，测试永远零网络
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in test'); }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(plan: string) {
  const t = await prisma.tenant.create({ data: { name: 't', plan, planExpiresAt: plan === 'free' ? null : new Date(Date.now() + 10 * DAY_MS) } });
  const ws = await prisma.workspace.create({ data: { tenantId: t.id, name: 'ws' } });
  const comp = await prisma.competitorAccount.create({ data: { platform: 'wechat', handle: 'gh_test', name: '测试号' } });
  await prisma.watchlistItem.create({ data: { workspaceId: ws.id, competitorId: comp.id } });
  return { ws, comp };
}

describe('免费档：平台代付通道不放行', () => {
  it('🔒 不拉数、台账记明原因、返回 degraded', async () => {
    const { ws, comp } = await setup('free');
    const gate = await canUseWechatPlatformSource(ws.id);
    expect(gate.ok).toBe(false);
    const r = await crawlOneCompetitor(comp.id, { workspaceId: ws.id, channel: 'manual' });
    expect(r).toEqual({ posts: 0, degraded: true });
    const runs = await prisma.collectionRun.findMany({ where: { workspaceId: ws.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].note).toContain('不含平台代付');
    expect(runs[0].items).toBe(0);
    // 真适配器没被碰到（碰到会走 fetch 并抛，上面的结果就不会是这个形状了）
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});

describe('试用档：有额度，用完即停', () => {
  it('额度按当月 items>0 的服务端/手动批次计数', async () => {
    const { ws } = await setup('trial');
    let q = await wechatQuotaStatus(ws.id);
    expect(q).toMatchObject({ configured: true, plan: 'trial', limit: 30, used: 0, remaining: 30 });
    for (let i = 0; i < 30; i += 1) {
      await prisma.collectionRun.create({ data: { workspaceId: ws.id, scope: 'rival', platform: 'wechat', targetName: 'x', channel: 'server', items: 3 } });
    }
    // 空批次与插件批次不计
    await prisma.collectionRun.create({ data: { workspaceId: ws.id, scope: 'rival', platform: 'wechat', targetName: 'x', channel: 'server', items: 0 } });
    await prisma.collectionRun.create({ data: { workspaceId: ws.id, scope: 'rival', platform: 'wechat', targetName: 'x', channel: 'plugin_home', items: 5 } });
    q = await wechatQuotaStatus(ws.id);
    expect(q.used).toBe(30);
    expect(q.remaining).toBe(0);
    const gate = await canUseWechatPlatformSource(ws.id);
    expect(gate.ok).toBe(false);
    expect((gate as { reason: string }).reason).toContain('已用完');
  });

  it('平台没配 Key 时闸门不介入（界面照旧说数据源未启用）', async () => {
    vi.stubEnv('BEACON_NEWRANK_KEY', '');
    const { ws } = await setup('trial');
    expect((await wechatQuotaStatus(ws.id)).configured).toBe(false);
  });
});
