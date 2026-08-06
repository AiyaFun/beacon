import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { LEGAL_VERSION } from '@/lib/legal';

describe('法律文本与同意管理 (F9-8)', () => {
  let memberId: string;

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'consent-test' } });
    const member = await prisma.member.create({
      data: { tenantId: tenant.id, name: 'tester', phone: '19900000099' },
    });
    memberId = member.id;
  });

  afterAll(async () => {
    await prisma.member.deleteMany({ where: { id: memberId } });
    await prisma.tenant.deleteMany({ where: { name: 'consent-test' } });
  });

  it('LEGAL_VERSION 格式正确', () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}\.\d{2}$/);
  });

  it('新建 Member 的 consentAt/consentVersion 默认为 null', async () => {
    const member = await prisma.member.findUnique({ where: { id: memberId } });
    expect(member!.consentAt).toBeNull();
    expect(member!.consentVersion).toBeNull();
  });

  it('记录用户同意后字段正确', async () => {
    const now = new Date();
    await prisma.member.update({
      where: { id: memberId },
      data: { consentAt: now, consentVersion: LEGAL_VERSION },
    });

    const updated = await prisma.member.findUnique({ where: { id: memberId } });
    expect(updated!.consentAt).toEqual(now);
    expect(updated!.consentVersion).toBe(LEGAL_VERSION);
  });

  it('撤回同意时可重置为 null', async () => {
    await prisma.member.update({
      where: { id: memberId },
      data: { consentAt: null, consentVersion: null },
    });

    const member = await prisma.member.findUnique({ where: { id: memberId } });
    expect(member!.consentAt).toBeNull();
    expect(member!.consentVersion).toBeNull();
  });

  it('版本变更后可更新 consentVersion', async () => {
    await prisma.member.update({
      where: { id: memberId },
      data: { consentAt: new Date(), consentVersion: '2026.01' },
    });

    const old = await prisma.member.findUnique({ where: { id: memberId } });
    expect(old!.consentVersion).toBe('2026.01');

    await prisma.member.update({
      where: { id: memberId },
      data: { consentAt: new Date(), consentVersion: LEGAL_VERSION },
    });

    const updated = await prisma.member.findUnique({ where: { id: memberId } });
    expect(updated!.consentVersion).toBe(LEGAL_VERSION);
  });
});
