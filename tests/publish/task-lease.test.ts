import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { GET } from '@/app/api/publish/tasks/route';
import { INGEST_TOKEN_HEADER } from '@/lib/ingest/competitor';

// 发布任务的租约。
//
// 【它修的是什么】这个队列曾经是**无锁广播**：任何持采集令牌的执行体 GET 一次
// 就看到全部待办。用户既装了浏览器插件、又在 Mac mini 上跑着本机执行体时，
// 同一篇稿子会被各填一遍——要是还开了「代点发布」，那就是**发两次**。
// 发布是不可撤销的对外动作，这不是体验问题。

let wsId: string;
let tokenA: string;
let tokenB: string;

const call = (token: string) =>
  GET(new Request('http://x/api/publish/tasks', { headers: { [INGEST_TOKEN_HEADER]: token } }));

const tasksOf = async (res: Response) => ((await res.json()) as { tasks?: { id: string }[] }).tasks ?? [];

beforeEach(async () => {
  await prisma.publishTask.deleteMany();
  await prisma.publishPlan.deleteMany();
  await prisma.ingestToken.deleteMany();
  await prisma.draftVersion.deleteMany();
  await prisma.draft.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  wsId = ws.id;
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'xiaohongshu', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });

  // 两台执行体：一台是浏览器插件，一台是 Mac mini 上的本机执行体
  tokenA = `bcn_a_${Math.random().toString(36).slice(2)}`;
  tokenB = `bcn_b_${Math.random().toString(36).slice(2)}`;
  await prisma.ingestToken.create({ data: { workspaceId: ws.id, token: tokenA, label: '浏览器插件', memberId: member.id } });
  await prisma.ingestToken.create({ data: { workspaceId: ws.id, token: tokenB, label: 'Mac mini', memberId: member.id } });

  const draft = await prisma.draft.create({ data: { accountId: account.id, title: '一篇稿子', platform: 'xiaohongshu' } });
  const plan = await prisma.publishPlan.create({
    data: { workspaceId: ws.id, accountId: account.id, draftId: draft.id, status: 'open', createdBy: member.id },
  });
  await prisma.publishTask.create({
    data: {
      planId: plan.id, platform: 'xiaohongshu', channel: 'extension', status: 'ready',
      title: '一篇稿子', content: '正文', extra: '{}',
    },
  });
});

describe('同一条活不给两个执行体', () => {
  it('A 领走之后，B 就看不到它了', async () => {
    const first = await tasksOf(await call(tokenA));
    expect(first, 'A 该领到那一条').toHaveLength(1);

    const second = await tasksOf(await call(tokenB));
    expect(second, 'B 还看得到 = 同一篇稿子会被各填一遍').toHaveLength(0);
  });

  it('A 自己再问一次，还是能看到（它就是正在做这条的那个）', async () => {
    await call(tokenA);
    const again = await tasksOf(await call(tokenA));
    expect(again, '自己领的活自己要能接着看，否则刷新一下面板就空了').toHaveLength(1);
  });

  it('租约到期后 B 才接得走（A 那边可能已经关掉了）', async () => {
    await call(tokenA);
    await prisma.publishTask.updateMany({ data: { leaseUntil: new Date(Date.now() - 1000) } });

    const afterExpiry = await tasksOf(await call(tokenB));
    expect(afterExpiry, '租约过期了还不放出来，那条活就永远没人做了').toHaveLength(1);
  });

  it('租约是 30 分钟——比浏览器任务长，因为这一步人在环里', async () => {
    const before = Date.now();
    await call(tokenA);
    const row = await prisma.publishTask.findFirstOrThrow();
    const minutes = (row.leaseUntil!.getTime() - before) / 60_000;
    // 按机器的节奏计时（15 分钟）会把用户正在看的那条抢走
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThanOrEqual(31);
  });

  it('领活会记下是谁领的（排查「这条谁在做」要用）', async () => {
    await call(tokenA);
    const row = await prisma.publishTask.findFirstOrThrow();
    expect(row.claimedBy).toBeTruthy();
    expect(row.claimedBy).not.toBe('legacy');
  });
});

describe('别家工作区一条都看不到', () => {
  it('拿别的工作区的令牌来问，得到空', async () => {
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const otherWs = await prisma.workspace.create({ data: { tenantId: other.id, name: 'OW' } });
    const otherToken = `bcn_o_${Math.random().toString(36).slice(2)}`;
    await prisma.ingestToken.create({ data: { workspaceId: otherWs.id, token: otherToken, label: '别家' } });

    expect(await tasksOf(await call(otherToken))).toHaveLength(0);
    // 而且不能因此把别人的活租走
    const row = await prisma.publishTask.findFirstOrThrow({ where: { plan: { workspaceId: wsId } } });
    expect(row.claimedBy).toBeNull();
  });

  it('没有令牌一律 401', async () => {
    const res = await GET(new Request('http://x/api/publish/tasks'));
    expect(res.status).toBe(401);
  });
});
