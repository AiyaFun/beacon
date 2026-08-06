import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 团队选题投票（app/(app)/topics/actions.ts actVoteTopic）。
// 锁三件事：一人一票且可改可撤、跨账号不能乱投、**票数不进任何算法**。

let session = { memberId: '', accountId: '', workspaceId: '', tenantId: '', role: 'owner' as const };
vi.mock('@/lib/session', () => ({ getSession: async () => session }));
// server action 里的 revalidatePath 需要 Next 的请求上下文，单测里没有（全库同一套写法）
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actVoteTopic } = await import('@/app/(app)/topics/actions');

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
  const m1 = await prisma.member.create({ data: { tenantId: tenant.id, name: '甲', role: 'owner' } });
  const m2 = await prisma.member.create({ data: { tenantId: tenant.id, name: '乙', role: 'editor' } });
  const topic = await prisma.topicIdea.create({
    data: { accountId: acc.id, title: 'T', angle: 'a', state: 'recommended', totalScore: 80 },
  });
  session = { memberId: m1.id, accountId: acc.id, workspaceId: ws.id, tenantId: tenant.id, role: 'owner' };
  return { tenantId: tenant.id, workspaceId: ws.id, accountId: acc.id, m1: m1.id, m2: m2.id, topicId: topic.id };
}

beforeEach(async () => {
  await prisma.topicVote.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.member.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('投票', () => {
  it('首次投票落一行', async () => {
    const { topicId, m1 } = await seed();
    expect(await actVoteTopic(topicId, 'up')).toEqual({ ok: true });
    const v = await prisma.topicVote.findUnique({ where: { topicId_memberId: { topicId, memberId: m1 } } });
    expect(v!.value).toBe('up');
  });

  it('改投另一个值 → 覆盖，不是加一行（一人一票）', async () => {
    const { topicId } = await seed();
    await actVoteTopic(topicId, 'up');
    await actVoteTopic(topicId, 'down');
    const all = await prisma.topicVote.findMany({ where: { topicId } });
    expect(all).toHaveLength(1);
    expect(all[0].value).toBe('down');
  });

  it('再点一次同一个值 → 撤票（省掉一个「取消」按钮）', async () => {
    const { topicId } = await seed();
    await actVoteTopic(topicId, 'up');
    await actVoteTopic(topicId, 'up');
    expect(await prisma.topicVote.count({ where: { topicId } })).toBe(0);
  });

  it('不同成员各投各的', async () => {
    const { topicId, m2 } = await seed();
    await actVoteTopic(topicId, 'up');
    session = { ...session, memberId: m2 };
    await actVoteTopic(topicId, 'down');
    const all = await prisma.topicVote.findMany({ where: { topicId } });
    expect(all).toHaveLength(2);
    expect(all.filter((v) => v.value === 'up')).toHaveLength(1);
    expect(all.filter((v) => v.value === 'down')).toHaveLength(1);
  });

  it('不是本账号的选题 → 拒绝（拿到别人的 id 也投不进去）', async () => {
    await seed();
    const other = await prisma.tenant.create({ data: { name: 'other' } });
    const otherWs = await prisma.workspace.create({ data: { tenantId: other.id, name: 'w2' } });
    const otherAcc = await prisma.creatorAccount.create({ data: { workspaceId: otherWs.id, name: 'b', platform: 'douyin' } });
    const otherTopic = await prisma.topicIdea.create({
      data: { accountId: otherAcc.id, title: '别人的选题', angle: 'a', state: 'recommended' },
    });
    const r = await actVoteTopic(otherTopic.id, 'up');
    expect(r.ok).toBe(false);
    expect(await prisma.topicVote.count()).toBe(0);
  });

  it('选题不存在 → 拒绝而不是崩', async () => {
    await seed();
    expect((await actVoteTopic('nope', 'up')).ok).toBe(false);
  });

  it('选题被删 → 票一并删（不留无法归属的幽灵票）', async () => {
    const { topicId } = await seed();
    await actVoteTopic(topicId, 'up');
    await prisma.topicIdea.delete({ where: { id: topicId } });
    expect(await prisma.topicVote.count()).toBe(0);
  });

  it('成员被删 → 他的票一并删', async () => {
    const { topicId, m1 } = await seed();
    await actVoteTopic(topicId, 'up');
    await prisma.member.delete({ where: { id: m1 } });
    expect(await prisma.topicVote.count()).toBe(0);
  });

  it('票数**不改动选题的分**——它是协调信号不是质量信号', async () => {
    const { topicId, m2 } = await seed();
    const before = await prisma.topicIdea.findUnique({ where: { id: topicId } });
    await actVoteTopic(topicId, 'up');
    session = { ...session, memberId: m2 };
    await actVoteTopic(topicId, 'up');
    const after = await prisma.topicIdea.findUnique({ where: { id: topicId } });
    expect(after!.totalScore).toBe(before!.totalScore);
    expect(after!.scores).toBe(before!.scores);
    expect(after!.state).toBe(before!.state);
  });
});
