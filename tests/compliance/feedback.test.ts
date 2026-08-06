import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';

describe('合规误报反馈 (F6-8)', () => {
  let tenantId: string;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'feedback-test' } });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.complianceFeedback.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { name: 'feedback-test' } });
  });

  it('创建反馈记录', async () => {
    const f = await prisma.complianceFeedback.create({
      data: {
        tenantId,
        word: '最好',
        tier: 'legal',
        context: '这个产品是我用过最好的之一',
        reason: '此处"最好"用于主观评价而非广告极限词',
      },
    });
    expect(f.status).toBe('pending');
    expect(f.word).toBe('最好');
    expect(f.resolvedAt).toBeNull();
  });

  it('查询租户下的反馈列表', async () => {
    const list = await prisma.complianceFeedback.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].tier).toBe('legal');
  });

  it('更新反馈状态为已采纳', async () => {
    const f = await prisma.complianceFeedback.findFirst({ where: { tenantId } });
    const updated = await prisma.complianceFeedback.update({
      where: { id: f!.id },
      data: { status: 'accepted', resolvedAt: new Date() },
    });
    expect(updated.status).toBe('accepted');
    expect(updated.resolvedAt).toBeTruthy();
  });

  it('更新反馈状态为已驳回', async () => {
    const f2 = await prisma.complianceFeedback.create({
      data: {
        tenantId,
        word: '100%有效',
        tier: 'legal',
        context: '100%有效成分',
        reason: '此处指成分含量，非疗效承诺',
      },
    });
    const updated = await prisma.complianceFeedback.update({
      where: { id: f2.id },
      data: { status: 'rejected', resolvedAt: new Date() },
    });
    expect(updated.status).toBe('rejected');
  });

  it('不同租户的反馈相互隔离', async () => {
    const other = await prisma.tenant.create({ data: { name: 'other-feedback' } });
    await prisma.complianceFeedback.create({
      data: {
        tenantId: other.id,
        word: '独家',
        tier: 'legal',
        context: '独家采访',
        reason: '新闻用语',
      },
    });

    const mine = await prisma.complianceFeedback.findMany({ where: { tenantId } });
    const theirs = await prisma.complianceFeedback.findMany({ where: { tenantId: other.id } });
    expect(mine.every((f) => f.tenantId === tenantId)).toBe(true);
    expect(theirs.every((f) => f.tenantId === other.id)).toBe(true);

    await prisma.complianceFeedback.deleteMany({ where: { tenantId: other.id } });
    await prisma.tenant.delete({ where: { id: other.id } });
  });

  it('context 长度截断不报错', async () => {
    const longContext = '长'.repeat(200);
    const f = await prisma.complianceFeedback.create({
      data: { tenantId, word: 'test', tier: 'custom', context: longContext, reason: 'ok' },
    });
    expect(f.context.length).toBe(200);
  });
});
