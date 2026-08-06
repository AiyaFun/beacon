import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { seedDemo, ensureDemoTenant } from '@/lib/demo/seed';
import { DEMO_TENANT_ID, DEMO_MEMBER_ID, DEMO_ACCOUNT_ID, isDemoTenant, assertNotDemo, DemoReadonlyError } from '@/lib/demo/guard';
import { createOrder } from '@/lib/pay/order';
import { llmComplete } from '@/lib/llm/gateway';

// 游客演示：固定 ID 的只读演示租户 + 跨模块假数据 + 写/生成/下单硬护栏。
// Mock LLM（清掉平台默认 key），零网络。

delete process.env.BEACON_DEFAULT_LLM_BASE_URL;
delete process.env.BEACON_DEFAULT_LLM_API_KEY;

beforeEach(async () => {
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.draftVersion.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.memoryEntry.deleteMany();
  await prisma.material.deleteMany();
  await prisma.skillInstall.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.postMetricSnapshot.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.hotItem.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.member.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('demo · 只读护栏', () => {
  it('assertNotDemo：演示租户抛错，其它 / null 放行', () => {
    expect(() => assertNotDemo(DEMO_TENANT_ID)).toThrow(DemoReadonlyError);
    expect(() => assertNotDemo('other-tenant')).not.toThrow();
    expect(() => assertNotDemo(null)).not.toThrow();
    expect(isDemoTenant(DEMO_TENANT_ID)).toBe(true);
    expect(isDemoTenant('x')).toBe(false);
  });

  it('createOrder 对演示租户直接拒绝（不建单）', async () => {
    await expect(createOrder({ tenantId: DEMO_TENANT_ID, memberId: 'x', plan: 'personal', periodMonths: 1 })).rejects.toThrow(/演示/);
    expect(await prisma.paymentOrder.count()).toBe(0);
  });

  it('llmComplete 对演示租户直接拒绝（不烧 token）', async () => {
    await expect(llmComplete(DEMO_TENANT_ID, 'generation', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/演示/);
  });
});

describe('demo · 种子', () => {
  it('seedDemo 建出固定 ID 的只读演示租户 + 跨模块假数据', async () => {
    await seedDemo();
    expect((await prisma.tenant.findUnique({ where: { id: DEMO_TENANT_ID } }))?.plan).toBe('personal');
    expect((await prisma.member.findUnique({ where: { id: DEMO_MEMBER_ID } }))?.role).toBe('viewer'); // ★ 只读
    expect(await prisma.publishRecord.count({ where: { accountId: DEMO_ACCOUNT_ID } })).toBeGreaterThan(0);
    expect(await prisma.topicIdea.count({ where: { accountId: DEMO_ACCOUNT_ID } })).toBeGreaterThan(0);
    expect(await prisma.draft.count({ where: { accountId: DEMO_ACCOUNT_ID } })).toBeGreaterThan(0);
    expect(await prisma.watchlistItem.count()).toBeGreaterThan(0);
  });

  it('重复 seedDemo 幂等，不翻倍', async () => {
    await seedDemo();
    const pubs = await prisma.publishRecord.count({ where: { accountId: DEMO_ACCOUNT_ID } });
    const comps = await prisma.competitorAccount.count();
    await seedDemo();
    expect(await prisma.publishRecord.count({ where: { accountId: DEMO_ACCOUNT_ID } })).toBe(pubs);
    expect(await prisma.competitorAccount.count()).toBe(comps); // 竞对按唯一键 upsert
    expect(await prisma.member.count({ where: { id: DEMO_MEMBER_ID } })).toBe(1);
  });

  it('ensureDemoTenant 返回固定 ID 并懒种一次', async () => {
    const r = await ensureDemoTenant();
    expect(r).toEqual({ tenantId: DEMO_TENANT_ID, memberId: DEMO_MEMBER_ID });
    expect(await prisma.member.count({ where: { id: DEMO_MEMBER_ID } })).toBe(1);
    // 再调不重复建成员
    await ensureDemoTenant();
    expect(await prisma.member.count({ where: { id: DEMO_MEMBER_ID } })).toBe(1);
  });
});
