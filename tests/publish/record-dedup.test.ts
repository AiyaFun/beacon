import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { buildPublishPlan, applyTaskReceipt } from '@/lib/publish/plan';

// 回归锁：**一篇稿子 + 一个平台 = 一条发布记录**。
//
// 为什么需要这一组：唯一约束 (accountId, platformItemId) 在 platformItemId=null 时形同虚设
// （SQL 里 NULL 互异），于是两条真实路径都会悄悄堆重复记录——
//   · 「登记发布」先不贴链接、拿到链接后再登记一次；
//   · 插件把 published 回执重发一次（网络重试/用户又点了一次）。
// 重复的后果不是报错，是**数字慢慢变假**：/data 篇数翻倍、learn 基线同一篇算两次、
// 第一条永远停在 needsBackfill=true 让「N 篇缺链接」的提示永远消不掉。
//
// 顺带锁住记忆侧：writeMemory 同内容是累加 hitCount 的，hitCount≥2 就激活进 prompt。
// 重复登记不该把一次发布伪装成「反复验证过的结论」。

const AWEME = '7065264218437717285';

let ws: { id: string };
let accountId: string;
let draftId: string;
let memberId: string;

beforeEach(async () => {
  vi.resetModules();
  await prisma.publishTask.deleteMany();
  await prisma.publishPlan.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.memoryEntry.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  accountId = account.id;
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  memberId = member.id;
  const draft = await prisma.draft.create({ data: { accountId, title: '原稿标题', platform: 'douyin' } });
  await prisma.draftVersion.create({ data: { draftId: draft.id, seq: 1, authorType: 'ai', content: '原稿正文' } });
  draftId = draft.id;
});

function mockSession() {
  const session = {
    memberId,
    tenantId: 'tt',
    workspaceId: ws.id,
    accountId,
    memberName: '张三',
    role: 'owner',
    plan: 'personal',
  };
  vi.doMock('@/lib/session', () => ({
    getSession: async () => session,
    getSessionOrNull: async () => session,
    withSession: async (fn: (s: unknown, tx: unknown) => unknown) => fn(session, prisma),
  }));
  vi.doMock('next/cache', () => ({ revalidatePath: () => {} }));
}

async function planWithOneTask(platforms = ['douyin']) {
  const plan = await buildPublishPlan({
    workspaceId: ws.id,
    accountId,
    draftId,
    memberId,
    platforms,
    aigcConfirmed: true,
  });
  if (!plan.ok) throw new Error('建计划失败');
  return prisma.publishTask.findFirstOrThrow({ where: { planId: plan.planId } });
}

describe('登记发布：重复登记不堆记录', () => {
  it('先没链接、后补链接 → 仍只有一条，链接落在原来那条上', async () => {
    mockSession();
    const { actRegisterPublish } = await import('@/app/(app)/studio/actions');

    const first = await actRegisterPublish(draftId, { aigcConfirmed: true });
    expect(first.ok).toBe(true);
    const skeleton = await prisma.publishRecord.findFirstOrThrow({ where: { accountId } });
    expect(skeleton.needsBackfill).toBe(true);

    const second = await actRegisterPublish(draftId, {
      url: `https://www.douyin.com/video/${AWEME}`,
      aigcConfirmed: true,
    });
    expect(second.ok).toBe(true);

    const rows = await prisma.publishRecord.findMany({ where: { accountId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(skeleton.id); // 补在原来那条上，不是新起一条
    expect(rows[0].platformItemId).toBe(AWEME);
    expect(rows[0].needsBackfill).toBe(false);
  });

  it('重复登记不把发布记忆的 hitCount 顶过激活线', async () => {
    mockSession();
    const { actRegisterPublish } = await import('@/app/(app)/studio/actions');
    await actRegisterPublish(draftId, { aigcConfirmed: true });
    await actRegisterPublish(draftId, { url: `https://www.douyin.com/video/${AWEME}`, aigcConfirmed: true });

    const mem = await prisma.memoryEntry.findFirstOrThrow({ where: { accountId, type: 'performance' } });
    expect(mem.hitCount).toBe(1);
    expect(mem.active).toBe(false);
  });
});

describe('插件回执：重复投递是幂等的', () => {
  // 注：这条**同时**被两道闸挡着（plan.ts 的重复回执早退 + record.ts 的 prior 认领），
  // 单独拆掉任何一道它都还是绿的。它测的是用户看得见的结果，不是某一道闸；
  // 各自那道闸的红/绿由下面「发布时刻」和上面「hitCount」两条分别钉住。
  it('同一条任务重复上报 published（都没链接）→ 只有一条记录', async () => {
    const task = await planWithOneTask();
    await applyTaskReceipt({ workspaceId: ws.id, taskId: task.id, status: 'published', url: null });
    await applyTaskReceipt({ workspaceId: ws.id, taskId: task.id, status: 'published', url: null });
    expect(await prisma.publishRecord.count({ where: { accountId } })).toBe(1);
  });

  it('重复回执不许把发布时刻改成重试的时刻', async () => {
    // 早退闸真正独有的作用：published 分支会重写 publishTask.publishedAt。
    // 少了它，插件半夜重试一次就把「这篇是什么时候发的」改成了重试那一刻，
    // 而发布时刻正是发布时机分析（lib/insight/timing.ts）的输入。
    const task = await planWithOneTask();
    await applyTaskReceipt({ workspaceId: ws.id, taskId: task.id, status: 'published', url: null });
    const first = await prisma.publishTask.findUniqueOrThrow({ where: { id: task.id } });
    await new Promise((r) => setTimeout(r, 25));
    await applyTaskReceipt({ workspaceId: ws.id, taskId: task.id, status: 'published', url: null });
    const again = await prisma.publishTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(again.publishedAt?.getTime()).toBe(first.publishedAt?.getTime());
  });

  it('先报没链接、后补上链接的回执要放行（带来的是新信息）', async () => {
    const task = await planWithOneTask();
    await applyTaskReceipt({ workspaceId: ws.id, taskId: task.id, status: 'published', url: null });
    const r = await applyTaskReceipt({
      workspaceId: ws.id,
      taskId: task.id,
      status: 'published',
      url: `https://www.douyin.com/video/${AWEME}`,
    });
    expect(r.ok).toBe(true);
    const rows = await prisma.publishRecord.findMany({ where: { accountId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].platformItemId).toBe(AWEME);
    expect((await prisma.publishTask.findUniqueOrThrow({ where: { id: task.id } })).publishedUrl).toContain(AWEME);
  });
});

describe('去重的边界：不许连不该合的也合了', () => {
  it('一稿多平台 → 每个平台各一条记录', async () => {
    const plan = await buildPublishPlan({
      workspaceId: ws.id,
      accountId,
      draftId,
      memberId,
      platforms: ['douyin', 'xiaohongshu'],
      aigcConfirmed: true,
    });
    if (!plan.ok) throw new Error('建计划失败');
    const tasks = await prisma.publishTask.findMany({ where: { planId: plan.planId } });
    for (const t of tasks) {
      await applyTaskReceipt({ workspaceId: ws.id, taskId: t.id, status: 'published', url: null });
    }
    const rows = await prisma.publishRecord.findMany({ where: { accountId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platform).sort()).toEqual(['douyin', 'xiaohongshu']);
  });

  it('两篇不同的稿子发同一个平台 → 各自一条', async () => {
    mockSession();
    const { actRegisterPublish } = await import('@/app/(app)/studio/actions');
    const other = await prisma.draft.create({ data: { accountId, title: '另一篇', platform: 'douyin' } });
    await prisma.draftVersion.create({ data: { draftId: other.id, seq: 1, authorType: 'human', content: '另一篇正文' } });

    await actRegisterPublish(draftId, { aigcConfirmed: true });
    await actRegisterPublish(other.id, { aigcConfirmed: true });
    expect(await prisma.publishRecord.count({ where: { accountId } })).toBe(2);
  });
});
