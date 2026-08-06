import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

import { actAddCustomWord, actRemoveCustomWord, actToggleCustomWord } from '@/app/(app)/compliance/actions';

beforeEach(async () => {
  await prisma.sensitiveWord.deleteMany({ where: { tenantId: 't1' } });
});

describe('自定义词库 CRUD (F6-7)', () => {
  it('添加自定义词条', async () => {
    const r = await actAddCustomWord({ word: '测试词', action: 'warn' });
    expect(r.ok).toBe(true);
    const w = await prisma.sensitiveWord.findFirst({ where: { word: '测试词', tenantId: 't1' } });
    expect(w).toBeTruthy();
    expect(w!.tier).toBe('custom');
    expect(w!.action).toBe('warn');
  });

  it('添加带平台和建议', async () => {
    const r = await actAddCustomWord({ word: '极限词', action: 'block', platform: 'douyin', suggestion: '换一种说法' });
    expect(r.ok).toBe(true);
    const w = await prisma.sensitiveWord.findFirst({ where: { word: '极限词', tenantId: 't1' } });
    expect(w!.platform).toBe('douyin');
    expect(w!.suggestion).toBe('换一种说法');
  });

  it('拒绝空词条', async () => {
    const r = await actAddCustomWord({ word: '  ', action: 'warn' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/长度/);
  });

  it('拒绝超长词条', async () => {
    const r = await actAddCustomWord({ word: 'x'.repeat(21), action: 'warn' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/长度/);
  });

  it('拒绝重复词条', async () => {
    await actAddCustomWord({ word: '重复', action: 'warn' });
    const r = await actAddCustomWord({ word: '重复', action: 'block' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/已存在/);
  });

  it('删除自定义词条', async () => {
    await actAddCustomWord({ word: '待删', action: 'suggest' });
    const w = await prisma.sensitiveWord.findFirst({ where: { word: '待删', tenantId: 't1' } });
    const r = await actRemoveCustomWord(w!.id);
    expect(r.ok).toBe(true);
    expect(await prisma.sensitiveWord.findUnique({ where: { id: w!.id } })).toBeNull();
  });

  it('删除不存在的词条 → 失败', async () => {
    const r = await actRemoveCustomWord('nonexistent-id');
    expect(r.ok).toBe(false);
  });

  it('不能删除别人的词条', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '别人的', tier: 'custom', action: 'warn', tenantId: 'other-tenant' },
    });
    const w = await prisma.sensitiveWord.findFirst({ where: { word: '别人的', tenantId: 'other-tenant' } });
    const r = await actRemoveCustomWord(w!.id);
    expect(r.ok).toBe(false);
    expect(await prisma.sensitiveWord.findUnique({ where: { id: w!.id } })).toBeTruthy();
  });

  it('切换启用/停用', async () => {
    await actAddCustomWord({ word: '切换', action: 'warn' });
    const w = await prisma.sensitiveWord.findFirst({ where: { word: '切换', tenantId: 't1' } });
    expect(w!.enabled).toBe(true);

    const r1 = await actToggleCustomWord(w!.id);
    expect(r1.ok).toBe(true);
    const after = await prisma.sensitiveWord.findUnique({ where: { id: w!.id } });
    expect(after!.enabled).toBe(false);

    const r2 = await actToggleCustomWord(w!.id);
    expect(r2.ok).toBe(true);
    const again = await prisma.sensitiveWord.findUnique({ where: { id: w!.id } });
    expect(again!.enabled).toBe(true);
  });

  it('不能切换别人的词条', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '别人2', tier: 'custom', action: 'block', tenantId: 'other-tenant' },
    });
    const w = await prisma.sensitiveWord.findFirst({ where: { word: '别人2', tenantId: 'other-tenant' } });
    const r = await actToggleCustomWord(w!.id);
    expect(r.ok).toBe(false);
  });

  it('自定义词被检测引擎命中', async () => {
    await actAddCustomWord({ word: '私域', action: 'block', suggestion: '社群' });
    const { checkText } = await import('@/lib/compliance/engine');
    const res = await checkText('欢迎加入私域交流', 'xiaohongshu', 't1');
    expect(res.riskLevel).toBe('block');
    expect(res.hits.some((h) => h.word === '私域' && h.tier === 'custom')).toBe(true);
  });
});
