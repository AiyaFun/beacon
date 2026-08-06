import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 批量采纳 / 批量拒绝。
// 关键约束：批量走的必须是与单条**同一条**业务路径——采纳/拒绝除了改 state，
// 还要写偏好记忆（「越用越懂我」的养料）。若为了快而绕成 updateMany，
// 批量操作就会悄悄什么都不学，那比慢更糟。
const session = {
  memberId: 'm1', tenantId: 't-bulk', workspaceId: 'w-bulk', accountId: 'a-bulk',
  memberName: '张三', role: 'owner', plan: 'pro',
};
// withSession = 会话 + RLS 事务。dev/测试是 SQLite，withTenant 本来就直接把全局 prisma 当 tx 传，
// 所以这里照搬同一语义：给回调注入假会话 + 真 prisma。
// （只 mock getSession 会让所有已迁移到 withSession 的 action 报「No export defined」。）
vi.mock('@/lib/session', async () => {
  const { prisma } = await import('@/lib/db');
  return {
    getSession: async () => session,
    getSessionOrNull: async () => session,
    withSession: async (fn: (s: unknown, tx: unknown) => unknown) => fn(session, prisma),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actBulkAccept, actBulkReject } = await import('@/app/(app)/topics/actions');

async function mkTopics(n: number, accountId = session.accountId) {
  const tenant = await prisma.tenant.upsert({
    where: { id: session.tenantId }, update: {}, create: { id: session.tenantId, name: 'bulk' },
  });
  await prisma.workspace.upsert({
    where: { id: session.workspaceId }, update: {},
    create: { id: session.workspaceId, tenantId: tenant.id, name: 'ws' },
  });
  await prisma.creatorAccount.upsert({
    where: { id: accountId }, update: {},
    create: { id: accountId, workspaceId: session.workspaceId, name: 'acc', platform: 'douyin' },
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = await prisma.topicIdea.create({
      data: { accountId, title: `选题${i}`, angle: `角度${i}`, state: 'recommended', sourceType: 'hot' },
    });
    ids.push(t.id);
  }
  return ids;
}

beforeEach(async () => {
  await prisma.memoryEntry.deleteMany();
  await prisma.topicIdea.deleteMany();
});

describe('actBulkAccept / actBulkReject', () => {
  it('批量采纳：全部转 accepted', async () => {
    const ids = await mkTopics(3);
    const r = await actBulkAccept(ids);
    expect(r).toMatchObject({ ok: true, done: 3, failed: 0 });
    expect(await prisma.topicIdea.count({ where: { state: 'accepted' } })).toBe(3);
  });

  it('🔒 批量采纳同样写偏好记忆（不能为了快而绕过学习闭环）', async () => {
    const ids = await mkTopics(2);
    await actBulkAccept(ids);
    const mems = await prisma.memoryEntry.findMany({ where: { type: 'preference' } });
    expect(mems.length).toBe(2);
    expect(mems[0].content).toContain('采纳');
  });

  it('批量拒绝：写入共同原因，并记进偏好记忆', async () => {
    const ids = await mkTopics(2);
    const r = await actBulkReject(ids, '这批都不合人设');
    expect(r).toMatchObject({ ok: true, done: 2, failed: 0 });
    const rows = await prisma.topicIdea.findMany();
    expect(rows.every((t) => t.state === 'rejected')).toBe(true);
    expect(rows.every((t) => t.rejectReason === '这批都不合人设')).toBe(true);
    const mems = await prisma.memoryEntry.findMany({ where: { type: 'preference' } });
    expect(mems[0].content).toContain('这批都不合人设');
  });

  it('单条失败不中断整批：混入不存在的 id 只计 failed', async () => {
    const ids = await mkTopics(2);
    const r = await actBulkAccept([...ids, 'does-not-exist']);
    expect(r.done).toBe(2);
    expect(r.failed).toBe(1);
    expect(await prisma.topicIdea.count({ where: { state: 'accepted' } })).toBe(2);
  });

  it('🔒 跨账号的选题不会被批量处理', async () => {
    const mine = await mkTopics(1);
    const other = await mkTopics(1, 'a-other');
    const r = await actBulkAccept([...mine, ...other]);
    expect(r.done).toBe(1);
    expect(r.failed).toBe(1);
    expect((await prisma.topicIdea.findUnique({ where: { id: other[0] } }))!.state).toBe('recommended');
  });

  it('去重 + 上限 50：重复 id 只处理一次', async () => {
    const ids = await mkTopics(1);
    const r = await actBulkAccept([ids[0], ids[0], ids[0]]);
    expect(r.done).toBe(1);
  });
});
