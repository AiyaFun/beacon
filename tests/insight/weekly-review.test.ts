import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 周度运营复盘：本周有发布 → 生成 ReviewReport(kind=weekly) + 站内通知；无发布 → 不出。
// stub LLM 网关返回合法 JSON。

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({ text: JSON.stringify({ conclusions: ['本周均播上升'], suggestions: ['继续晚间发布'] }), mocked: false, degraded: false }),
}));

const { generateWeeklyReview, scanWeeklyReviews } = await import('@/lib/insight/review');

let tenantId: string, workspaceId: string, accountId: string;

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.reviewReport.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '我的账号', platform: 'douyin' } });
  tenantId = tenant.id; workspaceId = ws.id; accountId = acc.id;
});

async function publish(daysAgo: number, views: number, fromRecommend = false) {
  await prisma.publishRecord.create({
    data: { accountId, platform: 'douyin', platformItemId: 'p' + Math.random(), title: 't', fromRecommend, publishedAt: new Date(Date.now() - daysAgo * 86_400_000), metrics: JSON.stringify({ views }) },
  });
}

describe('generateWeeklyReview', () => {
  it('本周有发布 → 生成周报 + 站内通知', async () => {
    await publish(2, 100000, true);
    await publish(5, 60000, false);
    await publish(10, 40000); // 上周
    const r = await generateWeeklyReview({ tenantId, accountId, workspaceId });
    expect(r).not.toBeNull();
    expect(r!.published).toBe(2);
    expect(r!.conclusions.length).toBeGreaterThan(0);
    expect(await prisma.reviewReport.count({ where: { accountId, kind: 'weekly' } })).toBe(1);
    const n = await prisma.notification.findFirst({ where: { kind: 'weekly_review' } });
    expect(n?.title).toContain('本周复盘');
  });

  it('本周无发布 → 不出周报', async () => {
    await publish(10, 40000); // 只有上周
    const r = await generateWeeklyReview({ tenantId, accountId, workspaceId });
    expect(r).toBeNull();
    expect(await prisma.reviewReport.count()).toBe(0);
  });

  it('scanWeeklyReviews 关闭 weeklyReview 的工作区跳过', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { automationConfig: JSON.stringify({ weeklyReview: false }) } });
    await publish(2, 100000);
    const r = await scanWeeklyReviews({ workspaceId });
    expect(r.generated).toBe(0);
  });
});
