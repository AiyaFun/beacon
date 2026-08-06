import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { decisionQuality } from '@/lib/insight/decision-quality';

// 决策质量统计：推荐采纳率 / 智囊团命中率 / 验证-证伪切入角 / 已复盘。真 SQLite。

let workspaceId: string, accountId: string;

beforeEach(async () => {
  await prisma.memoryEntry.deleteMany();
  await prisma.advisorOpinion.deleteMany();
  await prisma.advisorSession.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
  workspaceId = ws.id;
  accountId = acc.id;
});

const topic = (state: string, sourceType = 'hot') => prisma.topicIdea.create({ data: { accountId, title: 't', angle: 'x', sourceType, state } });

describe('decisionQuality', () => {
  it('推荐采纳率 = 采纳 /（采纳+拒绝），pending 不计入', async () => {
    await topic('published'); // 采纳
    await topic('accepted'); // 采纳
    await topic('rejected'); // 拒绝
    await topic('recommended'); // pending，不计入分母
    const dq = await decisionQuality(accountId, workspaceId);
    expect(dq.recommendAdopted).toBe(2);
    expect(dq.recommendRejected).toBe(1);
    expect(dq.adoptRatePct).toBe(67); // 2/3
  });

  it('无采纳/拒绝样本 → 采纳率 null', async () => {
    await topic('recommended');
    const dq = await decisionQuality(accountId, workspaceId);
    expect(dq.adoptRatePct).toBeNull();
  });

  it('智囊团命中率来自 adopted 非空的意见', async () => {
    const session = await prisma.advisorSession.create({ data: { accountId, status: 'done', summary: 's' } });
    const op = (adopted: boolean | null) => prisma.advisorOpinion.create({ data: { sessionId: session.id, personaKey: 'k', personaName: 'n', personaRole: 'expert', stance: 's', suggestion: 'x', adopted } });
    await op(true); await op(true); await op(false); await op(null);
    const dq = await decisionQuality(accountId, workspaceId);
    expect(dq.advisorAdopted).toBe(2);
    expect(dq.advisorRejected).toBe(1);
    expect(dq.advisorHitRatePct).toBe(67);
  });

  it('验证/证伪切入角统计 active preference 记忆', async () => {
    await prisma.memoryEntry.create({ data: { workspaceId, accountId, type: 'preference', content: '切入角「A」在抖音被数据验证有效', confidence: 0.6, active: true } });
    await prisma.memoryEntry.create({ data: { workspaceId, accountId, type: 'preference', content: '切入角「B」在抖音未跑出基线', confidence: 0.4, active: true } });
    await prisma.memoryEntry.create({ data: { workspaceId, accountId, type: 'preference', content: '切入角「C」在抖音被数据验证有效', confidence: 0.3, active: false } }); // 未生效不计
    const dq = await decisionQuality(accountId, workspaceId);
    expect(dq.angleProven).toBe(1);
    expect(dq.angleFailed).toBe(1);
  });

  it('已复盘选题数', async () => {
    await topic('reviewed');
    await topic('reviewed');
    await topic('published');
    const dq = await decisionQuality(accountId, workspaceId);
    expect(dq.reviewed).toBe(2);
  });
});
