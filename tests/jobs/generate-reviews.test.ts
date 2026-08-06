import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { HANDLERS } from '@/lib/jobs/handlers';
import { DEMO_WORKSPACE_ID } from '@/lib/demo/guard';

// generate_reviews 自动复盘 job：发布满 7 天、有 topicId、≥2 快照、未复盘、工作区开关开 → 生成。
// 关闭开关 / demo 工作区 / 数据不齐 / 已复盘 → 跳过。真 SQLite + Mock LLM（复盘落库但 mocked）。

async function mkAccount(automationConfig = '{}', workspaceId?: string) {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({
    data: workspaceId ? { id: workspaceId, tenantId: tenant.id, name: 'w', automationConfig } : { tenantId: tenant.id, name: 'w', automationConfig },
  });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
  return { tenantId: tenant.id, workspaceId: ws.id, accountId: acc.id };
}

async function mkPublished(accountId: string, daysAgo: number, snapDays: number[]) {
  const pub = new Date(Date.now() - daysAgo * 86_400_000);
  const topic = await prisma.topicIdea.create({ data: { accountId, title: 's', angle: 'x', sourceType: 'hot', state: 'published', totalScore: 70 } });
  const rec = await prisma.publishRecord.create({ data: { accountId, platform: 'douyin', platformItemId: `p${Math.random()}`, title: 't', topicId: topic.id, publishedAt: pub } });
  for (const d of snapDays) {
    await prisma.performanceSnapshot.create({ data: { publishId: rec.id, takenAt: new Date(pub.getTime() + d * 86_400_000), milestone: `D+${d}`, source: 'tikhub', metrics: JSON.stringify({ views: 10000 * d }) } });
  }
  return rec.id;
}

beforeEach(async () => {
  await prisma.reviewReport.deleteMany();
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('generate_reviews 自动复盘', () => {
  it('满足条件 → 生成复盘', async () => {
    const { accountId } = await mkAccount('{}');
    const recId = await mkPublished(accountId, 10, [1, 3, 5]);
    const r = await HANDLERS.generate_reviews({});
    expect(r.detail).toContain('生成 1 篇');
    expect(await prisma.reviewReport.count({ where: { refId: recId, kind: 'article' } })).toBe(1);
  });

  it('工作区关闭「自动复盘」→ 跳过', async () => {
    const { accountId } = await mkAccount(JSON.stringify({ autoReview: false }));
    await mkPublished(accountId, 10, [1, 3, 5]);
    await HANDLERS.generate_reviews({});
    expect(await prisma.reviewReport.count()).toBe(0);
  });

  it('快照 <2 → 数据不齐，跳过', async () => {
    const { accountId } = await mkAccount('{}');
    await mkPublished(accountId, 10, [1]);
    await HANDLERS.generate_reviews({});
    expect(await prisma.reviewReport.count()).toBe(0);
  });

  it('发布不足 7 天 → 不在窗口内', async () => {
    const { accountId } = await mkAccount('{}');
    await mkPublished(accountId, 3, [1, 2]);
    await HANDLERS.generate_reviews({});
    expect(await prisma.reviewReport.count()).toBe(0);
  });

  it('演示工作区 → 排除', async () => {
    const { accountId } = await mkAccount('{}', DEMO_WORKSPACE_ID);
    await mkPublished(accountId, 10, [1, 3, 5]);
    await HANDLERS.generate_reviews({});
    expect(await prisma.reviewReport.count()).toBe(0);
  });

  it('已有复盘 → 不重复生成', async () => {
    const { accountId } = await mkAccount('{}');
    await mkPublished(accountId, 10, [1, 3, 5]);
    await HANDLERS.generate_reviews({});
    await HANDLERS.generate_reviews({});
    expect(await prisma.reviewReport.count()).toBe(1);
  });
});
