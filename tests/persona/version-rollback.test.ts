import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { readPersona } from '@/lib/persona';

// 人设版本回滚。PersonaVersion 此前只写不读——快照存了一堆，回滚功能不存在。
// 关键设计：回滚**生成新版本**而不是删掉后续版本，历史是审计线索，回滚本身也要留痕。
const session = {
  memberId: 'm1', tenantId: 't-pv', workspaceId: 'w-pv', accountId: 'a-pv',
  memberName: '张三', role: 'owner', plan: 'pro',
};
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actRollbackPersona } = await import('@/app/(app)/persona/actions');

const card = (identity: string) =>
  JSON.stringify({ identity, audience: '受众', valueProp: '', niche: '', tone: '', canDo: [], cantDo: [], platforms: [] });

async function setup(accountId = session.accountId) {
  const tenant = await prisma.tenant.upsert({
    where: { id: session.tenantId }, update: {}, create: { id: session.tenantId, name: 'pv' },
  });
  await prisma.workspace.upsert({
    where: { id: session.workspaceId }, update: {},
    create: { id: session.workspaceId, tenantId: tenant.id, name: 'ws' },
  });
  await prisma.creatorAccount.upsert({
    where: { id: accountId }, update: { personaCard: card('第三版') },
    create: { id: accountId, workspaceId: session.workspaceId, name: 'acc', platform: 'douyin', personaCard: card('第三版') },
  });
  const v1 = await prisma.personaVersion.create({ data: { accountId, version: 1, snapshot: card('第一版'), editedBy: '张三' } });
  await prisma.personaVersion.create({ data: { accountId, version: 2, snapshot: card('第二版'), editedBy: '张三' } });
  await prisma.personaVersion.create({ data: { accountId, version: 3, snapshot: card('第三版'), editedBy: '张三' } });
  return v1;
}

beforeEach(async () => {
  await prisma.personaVersion.deleteMany();
  await prisma.creatorAccount.deleteMany();
});

describe('actRollbackPersona · 人设版本回滚', () => {
  it('回到 v1 → 账号人设卡内容变回 v1', async () => {
    const v1 = await setup();
    const r = await actRollbackPersona(v1.id);
    expect(r.ok).toBe(true);

    const acc = await prisma.creatorAccount.findUnique({ where: { id: session.accountId } });
    expect(readPersona(acc!.personaCard).identity).toBe('第一版');
  });

  it('🔒 回滚生成新版本（v4），不删除 v2/v3——历史是审计线索', async () => {
    const v1 = await setup();
    const r = await actRollbackPersona(v1.id);
    expect(r.version).toBe(4);

    const all = await prisma.personaVersion.findMany({ orderBy: { version: 'asc' } });
    expect(all.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    // 新版本内容等于被回滚的那一版
    expect(readPersona(all[3].snapshot).identity).toBe('第一版');
    // 且留下「谁回滚的、回滚自哪一版」
    expect(all[3].editedBy).toContain('回滚自 v1');
  });

  it('🔒 跨账号：不能回滚别人账号的版本', async () => {
    await setup();
    const other = await prisma.creatorAccount.create({
      data: { id: 'a-other', workspaceId: session.workspaceId, name: 'other', platform: 'douyin', personaCard: card('别人') },
    });
    const otherV = await prisma.personaVersion.create({
      data: { accountId: other.id, version: 1, snapshot: card('别人的历史') },
    });

    const r = await actRollbackPersona(otherV.id);
    expect(r.ok).toBe(false);
    // 自己的人设没被动过
    const mine = await prisma.creatorAccount.findUnique({ where: { id: session.accountId } });
    expect(readPersona(mine!.personaCard).identity).toBe('第三版');
  });

  it('版本不存在 → 报错而不是静默成功', async () => {
    await setup();
    expect((await actRollbackPersona('nope')).ok).toBe(false);
  });
});
