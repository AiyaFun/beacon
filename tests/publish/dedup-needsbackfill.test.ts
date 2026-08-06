import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { learnFromPerformance } from '@/lib/insight/learn';

// P0 回归锁：发布记录去重 + needsBackfill 闭环 + performance 记忆措辞契约。
//
// 覆盖三件本轮加固：
//   1. 缺链接的记录被打 needsBackfill，贴了链接的不打；
//   2. 同账号同作品ID只留一条 —— 登记发布骨架 + 数据回填 upsert 到同一条，不各建一条；
//   3. performance 记忆改稳定聚合措辞（不含易变百分比/单篇标题）→ 同一篇反复回流不再堆僵尸条目。
//
// 真 SQLite，只 mock session/next-cache（与 backfill-activation.test.ts 同风格）。

const AWEME = '7065264218437717285';
const AWEME2 = '7065264218437799999';

let accountId: string;
let workspaceId: string;

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '测试账号', platform: 'douyin', handle: 'MS4wLjABAAAAxyz' },
  });
  return { accountId: acc.id, workspaceId: ws.id };
}

beforeEach(async () => {
  vi.resetModules();
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.memoryEntry.deleteMany();
  const s = await seed();
  accountId = s.accountId;
  workspaceId = s.workspaceId;
});

function mockSession() {
  const session = {
    memberId: 'm1',
    tenantId: 'tt',
    workspaceId,
    accountId,
    memberName: '张三',
    role: 'owner',
    plan: 'pro',
  };
  // withSession = 会话 + RLS 事务；SQLite 下 withTenant 本来就直接传全局 prisma 当 tx，
  // 这里照搬同一语义。只 mock getSession 会让已迁移的 action 报「No export defined」。
  vi.doMock('@/lib/session', () => ({
    getSession: async () => session,
    getSessionOrNull: async () => session,
    withSession: async (fn: (s: unknown, tx: unknown) => unknown) => fn(session, prisma),
  }));
  vi.doMock('next/cache', () => ({ revalidatePath: () => {} }));
}

describe('needsBackfill 标记', () => {
  it('贴了链接 → needsBackfill=false，解析出 platformItemId', async () => {
    mockSession();
    const { actBackfill } = await import('@/app/(app)/data/actions');
    const res = await actBackfill('douyin', 100, 5, false, {
      url: `https://www.douyin.com/video/${AWEME}`,
      aigcConfirmed: true,
    });
    expect(res.ok).toBe(true);
    const rec = await prisma.publishRecord.findUniqueOrThrow({ where: { id: res.id! } });
    expect(rec.platformItemId).toBe(AWEME);
    expect(rec.needsBackfill).toBe(false);
  });

  it('未贴链接 → needsBackfill=true，platformItemId=null，警告如实告知', async () => {
    mockSession();
    const { actBackfill } = await import('@/app/(app)/data/actions');
    const res = await actBackfill('douyin', 100, 5, false, { aigcConfirmed: true });
    expect(res.ok).toBe(true);
    const rec = await prisma.publishRecord.findUniqueOrThrow({ where: { id: res.id! } });
    expect(rec.platformItemId).toBeNull();
    expect(rec.needsBackfill).toBe(true);
    expect(res.warning).toContain('自动回流');
  });
});

describe('去重：同账号同作品ID只留一条', () => {
  it('登记骨架(空metrics) + 数据回填同一作品 → upsert 到同一条，metrics 被填、缺链接标记解除', async () => {
    // 模拟 studio actRegisterPublish 先建的骨架：有 platformItemId、metrics 为空
    const skeleton = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: AWEME, needsBackfill: false, title: '登记标题' },
    });

    mockSession();
    const { actBackfill } = await import('@/app/(app)/data/actions');
    const res = await actBackfill('douyin', 4200, 88, false, {
      url: `https://www.douyin.com/video/${AWEME}`,
      aigcConfirmed: true,
    });
    expect(res.ok).toBe(true);
    // 关键：没有新建第二条
    expect(await prisma.publishRecord.count({ where: { accountId } })).toBe(1);
    // 更新的是同一条骨架
    expect(res.id).toBe(skeleton.id);
    const rec = await prisma.publishRecord.findUniqueOrThrow({ where: { id: skeleton.id } });
    expect(JSON.parse(rec.metrics)).toMatchObject({ views: 4200, likes: 88 });
    expect(rec.title).toBe('登记标题'); // 回填不抹掉登记侧的标题
  });

  it('连续两次回填同一作品 → 仍只一条，metrics 取最新', async () => {
    mockSession();
    const { actBackfill } = await import('@/app/(app)/data/actions');
    const url = `https://www.douyin.com/video/${AWEME}`;
    await actBackfill('douyin', 100, 5, false, { url, aigcConfirmed: true });
    await actBackfill('douyin', 900, 50, false, { url, aigcConfirmed: true });
    expect(await prisma.publishRecord.count({ where: { accountId } })).toBe(1);
    const rec = await prisma.publishRecord.findFirstOrThrow({ where: { accountId } });
    expect(JSON.parse(rec.metrics)).toMatchObject({ views: 900 });
  });

  it('缺链接的两条各自独立（platformItemId=null 不受唯一约束）', async () => {
    mockSession();
    const { actBackfill } = await import('@/app/(app)/data/actions');
    await actBackfill('douyin', 100, 5, false, { aigcConfirmed: true });
    await actBackfill('douyin', 200, 9, false, { aigcConfirmed: true });
    expect(await prisma.publishRecord.count({ where: { accountId } })).toBe(2);
  });
});

describe('actAttachPublishUrl 补链接', () => {
  it('给缺链接记录补链接 → 落 platformItemId、解除 needsBackfill', async () => {
    mockSession();
    const { actBackfill, actAttachPublishUrl } = await import('@/app/(app)/data/actions');
    const created = await actBackfill('douyin', 100, 5, false, { aigcConfirmed: true });
    expect((await prisma.publishRecord.findUniqueOrThrow({ where: { id: created.id! } })).needsBackfill).toBe(true);

    const res = await actAttachPublishUrl(created.id!, `https://www.douyin.com/video/${AWEME}`);
    expect(res.ok).toBe(true);
    expect(res.platformItemId).toBe(AWEME);
    const rec = await prisma.publishRecord.findUniqueOrThrow({ where: { id: created.id! } });
    expect(rec.platformItemId).toBe(AWEME);
    expect(rec.needsBackfill).toBe(false);
  });

  it('补的链接对应作品ID已在另一条记录上 → 拒绝，不动任何记录', async () => {
    mockSession();
    const { actBackfill, actAttachPublishUrl } = await import('@/app/(app)/data/actions');
    // 记录 A 已占用 AWEME
    await actBackfill('douyin', 100, 5, false, { url: `https://www.douyin.com/video/${AWEME}`, aigcConfirmed: true });
    // 记录 B 缺链接，想补成同一个 AWEME
    const b = await actBackfill('douyin', 200, 9, false, { aigcConfirmed: true });
    const res = await actAttachPublishUrl(b.id!, `https://www.douyin.com/video/${AWEME}`);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('已登记');
    // B 仍缺链接
    expect((await prisma.publishRecord.findUniqueOrThrow({ where: { id: b.id! } })).needsBackfill).toBe(true);
  });

  it('链接非法解析不出作品ID → 拒绝并保持 needsBackfill', async () => {
    mockSession();
    const { actBackfill, actAttachPublishUrl } = await import('@/app/(app)/data/actions');
    const created = await actBackfill('douyin', 100, 5, false, { aigcConfirmed: true });
    const res = await actAttachPublishUrl(created.id!, '这不是一个链接');
    expect(res.ok).toBe(false);
    expect((await prisma.publishRecord.findUniqueOrThrow({ where: { id: created.id! } })).needsBackfill).toBe(true);
  });
});

describe('performance 记忆措辞契约', () => {
  async function baseline() {
    for (let i = 0; i < 3; i++) {
      await prisma.publishRecord.create({
        data: { accountId, platform: 'douyin', title: `基线${i}`, metrics: '{"views":100}' },
      });
    }
  }

  it('高表现 → performance 记忆是稳定聚合措辞，不含易变百分比/单篇标题', async () => {
    await baseline();
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: AWEME, title: '爆款', metrics: '{"views":1000}' },
    });
    const insights = await learnFromPerformance(accountId, workspaceId, rec.id);

    const perf = await prisma.memoryEntry.findMany({ where: { workspaceId, accountId, type: 'performance' } });
    expect(perf).toHaveLength(1);
    expect(perf[0].content).not.toMatch(/%|《/); // 无百分比、无单篇标题
    expect(perf[0].content).toContain('高表现内容特征');
    // 单篇的超基线明细仍即时回显在 insights（不进长期记忆）
    expect(insights.some((i) => i.kind === 'overperform')).toBe(true);
  });

  it('同一篇反复回流 → performance 记忆仍只一条（去重累计，不堆僵尸条目）', async () => {
    await baseline();
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: AWEME, title: '爆款', metrics: '{"views":1000}' },
    });
    await learnFromPerformance(accountId, workspaceId, rec.id);
    // 模拟 T+7d 又回流一次，播放更高
    await prisma.publishRecord.update({ where: { id: rec.id }, data: { metrics: '{"views":3000}' } });
    await learnFromPerformance(accountId, workspaceId, rec.id);

    const perf = await prisma.memoryEntry.findMany({ where: { workspaceId, accountId, type: 'performance' } });
    expect(perf).toHaveLength(1); // 不是两条
    expect(perf[0].hitCount).toBe(2); // 累计命中
  });

  it('两篇不同的高表现内容 → 累计到同一条聚合记忆并生效', async () => {
    await baseline();
    const r1 = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: AWEME, title: '爆款一', metrics: '{"views":1000}' },
    });
    const r2 = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: AWEME2, title: '爆款二', metrics: '{"views":1200}' },
    });
    await learnFromPerformance(accountId, workspaceId, r1.id);
    await learnFromPerformance(accountId, workspaceId, r2.id);

    const perf = await prisma.memoryEntry.findMany({ where: { workspaceId, accountId, type: 'performance' } });
    expect(perf).toHaveLength(1);
    expect(perf[0].hitCount).toBe(2);
    expect(perf[0].active).toBe(true); // 攒到 2 篇 → 生效注入
  });
});
