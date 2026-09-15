import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { issueHotFitToken } from '@/lib/topic/adopt-token';
import type { HotFitAnalysis } from '@/lib/topic/combine';

const session = {
  memberId: 'm-hotfit', tenantId: 't-hotfit', workspaceId: 'w-hotfit', accountId: 'a-hotfit',
  memberName: '测试创作者', role: 'owner', plan: 'pro',
};

vi.mock('@/lib/session', async () => {
  const { prisma } = await import('@/lib/db');
  return {
    getSession: async () => session,
    getSessionOrNull: async () => session,
    withSession: async (fn: (s: unknown, tx: unknown) => unknown) => fn(session, prisma),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actAdoptHotAngleAsTopic } = await import('@/app/(app)/actions');

const analysis = (over: Partial<HotFitAnalysis> = {}): HotFitAnalysis => ({
  hotTitle: 'AI智能体开源生态爆发',
  fit: 88,
  verdict: '值得做',
  angles: [
    { angle: '实测 5 款最火开源 Agent：宣传很丰满，落地到底卡在哪？', why: '契合账号硬核测评人设，打破同行空洞吹捧' },
    { angle: '第二个角度', why: '' },
  ],
  production: [],
  risk: '',
  mocked: false,
  ...over,
});
const tokenFor = (a: HotFitAnalysis = analysis(), accountId = session.accountId) => issueHotFitToken(accountId, a);

describe('actAdoptHotAngleAsTopic · 热点结合角度一键采纳入库', () => {
  beforeEach(async () => {
    const tenant = await prisma.tenant.upsert({
      where: { id: session.tenantId },
      update: {},
      create: { id: session.tenantId, name: 'tenant-hotfit' },
    });
    await prisma.workspace.upsert({
      where: { id: session.workspaceId },
      update: {},
      create: { id: session.workspaceId, tenantId: tenant.id, name: 'ws-hotfit' },
    });
    await prisma.creatorAccount.upsert({
      where: { id: session.accountId },
      update: {},
      create: { id: session.accountId, workspaceId: session.workspaceId, name: '创作者A', platform: 'douyin' },
    });
  });

  it('成功将结合分析产出的切入角采纳为 accepted 选题：内容全部来自凭证', async () => {
    const res = await actAdoptHotAngleAsTopic({ token: tokenFor(), angleIndex: 0 });
    expect(res.ok).toBe(true);
    expect(res.topicId).toBeDefined();

    const created = await prisma.topicIdea.findUnique({ where: { id: res.topicId } });
    expect(created).not.toBeNull();
    expect(created?.title).toBe('实测 5 款最火开源 Agent：宣传很丰满，落地到底卡在哪？');
    expect(created?.angle).toBe('契合账号硬核测评人设，打破同行空洞吹捧');
    expect(created?.state).toBe('accepted');
    expect(created?.sourceType).toBe('hot');
    expect(created?.sourceRef).toBe('AI智能体开源生态爆发');
    expect(created?.totalScore).toBe(88);
    expect(created?.mocked).toBe(false);
  });

  it('🔒 来源校验：篡改凭证 / 别的账号的凭证 / 过期凭证 / 不存在的序号，一律拒绝', async () => {
    const before = await prisma.topicIdea.count({ where: { accountId: session.accountId, sourceType: 'hot' } });
    const good = tokenFor();
    const [body, sig] = [good.slice(0, good.lastIndexOf('.')), good.slice(good.lastIndexOf('.') + 1)];
    // 改载荷（把 fit 改成 100）但签名不变
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.fit = 100;
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect((await actAdoptHotAngleAsTopic({ token: forged, angleIndex: 0 })).ok).toBe(false);

    const other = await actAdoptHotAngleAsTopic({ token: tokenFor(analysis(), 'a-someone-else'), angleIndex: 0 });
    expect(other.ok).toBe(false);
    expect(other.error).toBe('采纳凭证不属于当前账号');

    const expired = issueHotFitToken(session.accountId, analysis(), Date.now() - 48 * 3600 * 1000);
    const exp = await actAdoptHotAngleAsTopic({ token: expired, angleIndex: 0 });
    expect(exp.ok).toBe(false);
    expect(exp.error).toMatch(/过期/);

    expect((await actAdoptHotAngleAsTopic({ token: good, angleIndex: 7 })).error).toBe('切入角度不存在');
    expect((await actAdoptHotAngleAsTopic({ token: good, angleIndex: -1 })).error).toBe('切入角度不存在');
    expect((await actAdoptHotAngleAsTopic({ token: '', angleIndex: 0 })).ok).toBe(false);
    expect((await actAdoptHotAngleAsTopic({ token: 12345, angleIndex: 'x' } as never)).ok).toBe(false);
    expect((await actAdoptHotAngleAsTopic(null as never)).ok).toBe(false);

    // 以上没有一条落库
    expect(await prisma.topicIdea.count({ where: { accountId: session.accountId, sourceType: 'hot' } })).toBe(before);
  });

  it('凭证里的空角度拒绝入库', async () => {
    const res = await actAdoptHotAngleAsTopic({ token: tokenFor(analysis({ angles: [{ angle: '   ', why: '理由' }] })), angleIndex: 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('切入角度不能为空');
  });

  it('评分即使凭证里越界也夹到 0-100；Mock 兜底出来的分析采纳后 mocked=true', async () => {
    const hi = await actAdoptHotAngleAsTopic({ token: tokenFor(analysis({ hotTitle: '热点H', fit: 9999 })), angleIndex: 0 });
    expect(hi.ok).toBe(true);
    expect((await prisma.topicIdea.findUnique({ where: { id: hi.topicId } }))?.totalScore).toBe(100);

    const mk = await actAdoptHotAngleAsTopic({ token: tokenFor(analysis({ hotTitle: '热点M', mocked: true })), angleIndex: 1 });
    expect(mk.ok).toBe(true);
    const row = await prisma.topicIdea.findUnique({ where: { id: mk.topicId } });
    expect(row?.mocked).toBe(true);
    expect(row?.title).toBe('第二个角度');
    expect(row?.angle).toBe('第二个角度'); // why 为空时回退到角度本身
  });

  it('超长文本截断入库而不是打回', async () => {
    const res = await actAdoptHotAngleAsTopic({
      token: tokenFor(analysis({ hotTitle: 'T'.repeat(500), angles: [{ angle: 'A'.repeat(500), why: 'W'.repeat(2000) }] })),
      angleIndex: 0,
    });
    expect(res.ok).toBe(true);
    const row = await prisma.topicIdea.findUnique({ where: { id: res.topicId } });
    expect(row?.title).toHaveLength(200);
    expect(row?.sourceRef).toHaveLength(200);
    expect(row?.angle).toHaveLength(600);
  });

  it('🔒 并发五次采纳同一切入角（双击/重试）最终只剩一条，五次都返回同一个 topicId', async () => {
    const token = tokenFor(analysis({ hotTitle: '双击热点', angles: [{ angle: '双击角度', why: '理由' }] }));
    const results = await Promise.all(Array.from({ length: 5 }, () => actAdoptHotAngleAsTopic({ token, angleIndex: 0 })));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => r.topicId));
    expect(ids.size).toBe(1);
    const rows = await prisma.topicIdea.findMany({ where: { accountId: session.accountId, sourceRef: '双击热点', title: '双击角度' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe([...ids][0]);
    // 串行再来一次也命中幂等键
    const again = await actAdoptHotAngleAsTopic({ token, angleIndex: 0 });
    expect(again.duplicate).toBe(true);
    expect(again.topicId).toBe(rows[0].id);
  });
});
