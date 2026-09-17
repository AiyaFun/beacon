import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 删草稿（右键菜单那条路）。打桩同 new-actions.test.ts：session 固定、真 SQLite。
//
// 这里只盯三件「删错了就静默坏掉」的事：
//   ① 版本跟着走（外键 Cascade，不能留孤儿版本）；
//   ② 发布记录**不跟着走**，只把 draftId 摘成 null——那是「看效果」的全部家底；
//   ③ 开着的内容工单挂着它就不许删（工单 draftId 是松引用，删了不报错、只会让工单点不开）。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

async function base() {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.upsert({
    where: { id: 'a1' },
    create: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin' },
    update: {},
  });
  // 另一个账号：用来验「不是我的草稿删不掉」
  await prisma.creatorAccount.upsert({
    where: { id: 'a2' },
    create: { id: 'a2', workspaceId: 'w1', name: '别人的账号', platform: 'douyin' },
    update: {},
  });
}

async function seedDraft(id: string, accountId = 'a1') {
  await prisma.draft.create({ data: { id, accountId, title: `稿子 ${id}`, platform: 'douyin', status: 'editing' } });
  await prisma.draftVersion.create({ data: { draftId: id, seq: 1, authorType: 'ai', content: '一版正文' } });
  await prisma.draftVersion.create({ data: { draftId: id, seq: 2, authorType: 'human', content: '我改过的正文' } });
  return id;
}

beforeEach(async () => {
  session.role = 'owner';
  session.accountId = 'a1';
  await base();
  await prisma.contentWorkItem.deleteMany({ where: { workspaceId: 'w1' } });
  await prisma.publishRecord.deleteMany({ where: { accountId: { in: ['a1', 'a2'] } } });
  await prisma.draftVersion.deleteMany({ where: { draft: { accountId: { in: ['a1', 'a2'] } } } });
  await prisma.draft.deleteMany({ where: { accountId: { in: ['a1', 'a2'] } } });
});

describe('删草稿', () => {
  it('删掉草稿，版本一并删掉（不留孤儿版本）', async () => {
    const { actDeleteDraft } = await import('@/app/(app)/studio/actions');
    await seedDraft('d1');
    expect(await prisma.draftVersion.count({ where: { draftId: 'd1' } })).toBe(2);

    const r = await actDeleteDraft('d1');
    expect(r.ok).toBe(true);
    expect(await prisma.draft.findUnique({ where: { id: 'd1' } })).toBeNull();
    expect(await prisma.draftVersion.count({ where: { draftId: 'd1' } })).toBe(0);
  });

  it('发布记录留着，只把 draftId 摘成 null——播放/互动数据不该被删稿连坐', async () => {
    const { actDeleteDraft } = await import('@/app/(app)/studio/actions');
    await seedDraft('d2');
    await prisma.publishRecord.create({
      data: {
        id: 'p1', accountId: 'a1', draftId: 'd2', platform: 'douyin',
        title: '已经发出去的那篇', platformItemId: 'item-1',
        metrics: JSON.stringify({ views: 12000 }),
      },
    });

    expect((await actDeleteDraft('d2')).ok).toBe(true);

    const rec = await prisma.publishRecord.findUnique({ where: { id: 'p1' } });
    expect(rec).not.toBeNull();
    expect(rec!.draftId).toBeNull();           // 指针摘掉：查不到的 id 比 null 更难排查
    expect(rec!.metrics).toContain('12000');   // 家底还在
  });

  it('开着的内容工单挂着它 → 拒绝删除，草稿原封不动', async () => {
    const { actDeleteDraft } = await import('@/app/(app)/studio/actions');
    await seedDraft('d3');
    await prisma.contentWorkItem.create({
      data: {
        id: 'w-open', workspaceId: 'w1', accountId: 'a1', title: '这周那篇长文',
        status: 'open', stage: 'drafting', draftId: 'd3', createdBy: 'm1',
      },
    });

    const r = await actDeleteDraft('d3');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('工单');
    expect(await prisma.draft.findUnique({ where: { id: 'd3' } })).not.toBeNull();
  });

  it('工单已经关掉了就不拦（只有 open 才是「还在用」）', async () => {
    const { actDeleteDraft } = await import('@/app/(app)/studio/actions');
    await seedDraft('d4');
    await prisma.contentWorkItem.create({
      data: {
        id: 'w-done', workspaceId: 'w1', accountId: 'a1', title: '上周那篇',
        status: 'done', stage: 'published', draftId: 'd4', createdBy: 'm1',
      },
    });

    expect((await actDeleteDraft('d4')).ok).toBe(true);
    expect(await prisma.draft.findUnique({ where: { id: 'd4' } })).toBeNull();
  });

  it('别的账号的草稿删不掉（按 id 直接投也不行）', async () => {
    const { actDeleteDraft } = await import('@/app/(app)/studio/actions');
    await seedDraft('d5', 'a2');

    const r = await actDeleteDraft('d5');
    expect(r.ok).toBe(false);
    expect(await prisma.draft.findUnique({ where: { id: 'd5' } })).not.toBeNull();
  });

  it('viewer 不许删（RBAC 拦在动作里，不是拦在按钮上）', async () => {
    const { actDeleteDraft } = await import('@/app/(app)/studio/actions');
    await seedDraft('d6');
    session.role = 'viewer';

    await expect(actDeleteDraft('d6')).rejects.toThrow();
    expect(await prisma.draft.findUnique({ where: { id: 'd6' } })).not.toBeNull();
  });
});
