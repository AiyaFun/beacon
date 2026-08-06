import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 记忆就地编辑。此前用户只能删除——看到一条学错的记忆，唯一选择是删掉再指望系统重新学对。
// 锁住：只改 content 不让改学习状态、跨工作区防护、改后向量跟着重算（否则语义召回还按旧内容匹配）。
const session = {
  memberId: 'm1', tenantId: 't-mem', workspaceId: 'w-mem', accountId: 'a-mem',
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

const embedCalls: { id: string; text: string }[] = [];
vi.mock('@/lib/vector/store', () => ({
  upsertMemoryEmbedding: async (id: string, text: string) => { embedCalls.push({ id, text }); },
}));

const { actUpdateMemory } = await import('@/app/(app)/persona/actions');

async function mkMemory(content: string, workspaceId = session.workspaceId) {
  const tenant = await prisma.tenant.upsert({
    where: { id: session.tenantId }, update: {}, create: { id: session.tenantId, name: 'mem' },
  });
  await prisma.workspace.upsert({
    where: { id: workspaceId }, update: {},
    create: { id: workspaceId, tenantId: tenant.id, name: 'ws' },
  });
  return prisma.memoryEntry.create({
    data: { workspaceId, type: 'preference', content, confidence: 0.3, hitCount: 1, active: false },
  });
}

beforeEach(async () => {
  embedCalls.length = 0;
  await prisma.memoryEntry.deleteMany();
});

describe('actUpdateMemory · 记忆就地编辑', () => {
  it('改内容成功，并置为「你确认过」（高置信 + 生效）', async () => {
    const m = await mkMemory('偏好长文');
    const r = await actUpdateMemory(m.id, '偏好短平快的清单体');
    expect(r.ok).toBe(true);

    const after = await prisma.memoryEntry.findUnique({ where: { id: m.id } });
    expect(after!.content).toBe('偏好短平快的清单体');
    // 用户亲手改的是直接陈述而非推断，故提到高置信并立即生效
    expect(after!.confidence).toBe(0.9);
    expect(after!.active).toBe(true);
  });

  it('🔒 内容变了必须重算向量，否则语义召回还按旧内容匹配（改了等于没改）', async () => {
    const m = await mkMemory('偏好长文');
    await actUpdateMemory(m.id, '偏好清单体');
    expect(embedCalls).toEqual([{ id: m.id, text: '偏好清单体' }]);
  });

  it('内容没变 → 不写库也不动向量（避免无谓的置信度跳变）', async () => {
    const m = await mkMemory('偏好长文');
    const r = await actUpdateMemory(m.id, '  偏好长文  '); // 仅首尾空白差异
    expect(r.ok).toBe(true);
    const after = await prisma.memoryEntry.findUnique({ where: { id: m.id } });
    expect(after!.confidence).toBe(0.3); // 未被提权
    expect(embedCalls).toHaveLength(0);
  });

  it('空内容 / 超长内容 → 拒绝', async () => {
    const m = await mkMemory('偏好长文');
    expect((await actUpdateMemory(m.id, '   ')).ok).toBe(false);
    expect((await actUpdateMemory(m.id, 'x'.repeat(301))).ok).toBe(false);
    const after = await prisma.memoryEntry.findUnique({ where: { id: m.id } });
    expect(after!.content).toBe('偏好长文'); // 原值未被破坏
  });

  it('🔒 跨工作区：不能改别的工作区的记忆', async () => {
    const m = await mkMemory('别人的记忆', 'w-other');
    const r = await actUpdateMemory(m.id, '篡改');
    expect(r.ok).toBe(false);
    expect((await prisma.memoryEntry.findUnique({ where: { id: m.id } }))!.content).toBe('别人的记忆');
  });

  it('记忆不存在 → 报错而不是静默成功', async () => {
    expect((await actUpdateMemory('nope', '内容')).ok).toBe(false);
  });
});
