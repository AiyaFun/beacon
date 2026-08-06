import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { checkText, invalidateDfaCache } from '@/lib/compliance/engine';

// 误报申诉的状态流转。
//
// 此前**没有任何动作能改 status**：UI 画了三个徽章（待处理/已采纳/已驳回），
// 但只有 pending 可达——三分之二的状态是不可达死分支，用户提了申诉就永远停在待处理。
// 这里端到端跑 actResolveFeedback，锁住：权限收口、跨租户防护、幂等、以及
// 「采纳自定义词申诉要顺手停用那个词」（否则「已采纳」只是个标签，下次还拦）。
let role = 'owner';
const session = {
  memberId: 'm1', tenantId: 't-fb', workspaceId: 'w-fb', accountId: 'a-fb',
  memberName: '张三', get role() { return role; }, plan: 'pro',
};
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actResolveFeedback } = await import('@/app/(app)/compliance/actions');

async function mkFeedback(word: string, tier: string, tenantId = session.tenantId) {
  await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: tenantId } });
  return prisma.complianceFeedback.create({
    data: { tenantId, word, tier, context: 'ctx', reason: '这是主观评价不是极限词' },
  });
}

beforeEach(async () => {
  role = 'owner';
  await prisma.complianceFeedback.deleteMany();
  await prisma.sensitiveWord.deleteMany();
  invalidateDfaCache();
});

describe('actResolveFeedback · 申诉状态流转', () => {
  it('驳回：pending → rejected，并写 resolvedAt', async () => {
    const fb = await mkFeedback('最好', 'legal');
    const r = await actResolveFeedback(fb.id, 'rejected');
    expect(r.ok).toBe(true);

    const after = await prisma.complianceFeedback.findUnique({ where: { id: fb.id } });
    expect(after!.status).toBe('rejected');
    expect(after!.resolvedAt).not.toBeNull();
  });

  it('🔒 采纳自定义词申诉 → 顺手停用该词，且当次检测立即不再拦（缓存已失效）', async () => {
    await prisma.sensitiveWord.create({
      data: { tenantId: session.tenantId, word: '独家', tier: 'custom', action: 'block', enabled: true },
    });
    invalidateDfaCache();
    // 停用前：拦
    expect((await checkText('本店独家供应', 'douyin', session.tenantId)).riskLevel).toBe('block');

    const fb = await mkFeedback('独家', 'custom');
    const r = await actResolveFeedback(fb.id, 'accepted');
    expect(r.ok).toBe(true);
    expect(r.disabledWord).toBe(true);

    const w = await prisma.sensitiveWord.findFirst({ where: { word: '独家' } });
    expect(w!.enabled).toBe(false);
    // 停用后：立即放行（若只靠 TTL，这里会仍然是 block）
    expect((await checkText('本店独家供应', 'douyin', session.tenantId)).riskLevel).toBe('pass');
  });

  it('采纳全局词（legal）申诉 → 记结论但不停用（全局词库不受单租户申诉影响）', async () => {
    await prisma.sensitiveWord.create({
      data: { tenantId: null, word: '国家级', tier: 'legal', action: 'block', enabled: true },
    });
    const fb = await mkFeedback('国家级', 'legal');
    const r = await actResolveFeedback(fb.id, 'accepted');
    expect(r.ok).toBe(true);
    expect(r.disabledWord).toBe(false); // 没停用

    const w = await prisma.sensitiveWord.findFirst({ where: { word: '国家级' } });
    expect(w!.enabled).toBe(true); // 全局词仍生效
    expect((await prisma.complianceFeedback.findUnique({ where: { id: fb.id } }))!.status).toBe('accepted');
  });

  it('幂等：已处理过的申诉不能再改一次', async () => {
    const fb = await mkFeedback('最好', 'legal');
    expect((await actResolveFeedback(fb.id, 'accepted')).ok).toBe(true);
    const second = await actResolveFeedback(fb.id, 'rejected');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('已经处理过');
    expect((await prisma.complianceFeedback.findUnique({ where: { id: fb.id } }))!.status).toBe('accepted');
  });

  it('🔒 跨租户：不能处理别的租户的申诉', async () => {
    const fb = await mkFeedback('最好', 'legal', 't-other');
    const r = await actResolveFeedback(fb.id, 'accepted');
    expect(r.ok).toBe(false);
    expect((await prisma.complianceFeedback.findUnique({ where: { id: fb.id } }))!.status).toBe('pending');
  });

  it('🔒 权限：editor 不能处理申诉（收口到 owner/admin）', async () => {
    const fb = await mkFeedback('最好', 'legal');
    role = 'editor';
    await expect(actResolveFeedback(fb.id, 'accepted')).rejects.toThrow();
    expect((await prisma.complianceFeedback.findUnique({ where: { id: fb.id } }))!.status).toBe('pending');
  });
});
