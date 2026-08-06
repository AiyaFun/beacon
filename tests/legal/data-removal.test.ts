import { describe, it, expect, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 这条 action 现在带 IP 频率限制（公开写入口，一条 pending 就让全平台停采该账号），
// 而 headers() 在单测里没有请求上下文。给一个固定 IP 即可——限流本身的行为
// 由 tests/ratelimit.test.ts 覆盖，这里只是让 action 能跑起来。
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9' }) }));

const { actSubmitDataRemoval } = await import('@/app/(public)/legal/data-request/actions');

// F9-4 被监控账号移除申请（PIPL 权利人拒绝权）
describe('数据移除申请 (F9-4)', () => {
  afterAll(async () => {
    await prisma.dataRemovalRequest.deleteMany({ where: { handle: { startsWith: 'test-removal-' } } });
    await prisma.dataRemovalRequest.deleteMany({ where: { handle: { startsWith: 'act-removal-' } } });
  });

  it('创建移除申请，默认 pending 状态', async () => {
    const r = await prisma.dataRemovalRequest.create({
      data: {
        platform: 'douyin',
        handle: 'test-removal-001',
        contact: 'someone@example.com',
        reason: '我是该账号本人，要求停止采集',
      },
    });
    expect(r.status).toBe('pending');
    expect(r.resolvedAt).toBeNull();
    expect(r.platform).toBe('douyin');
  });

  it('reason 可为空', async () => {
    const r = await prisma.dataRemovalRequest.create({
      data: { platform: 'xiaohongshu', handle: 'test-removal-002', contact: '13800000000' },
    });
    expect(r.reason).toBeNull();
  });

  it('去重查询：同账号同联系人 pending 只应存在一条', async () => {
    await prisma.dataRemovalRequest.create({
      data: { platform: 'weibo', handle: 'test-removal-003', contact: 'dup@example.com' },
    });
    const existing = await prisma.dataRemovalRequest.findFirst({
      where: { platform: 'weibo', handle: 'test-removal-003', contact: 'dup@example.com', status: 'pending' },
    });
    expect(existing).toBeTruthy();
  });

  it('状态可流转到 removed', async () => {
    const r = await prisma.dataRemovalRequest.create({
      data: { platform: 'bilibili', handle: 'test-removal-004', contact: 'x@x.com' },
    });
    const updated = await prisma.dataRemovalRequest.update({
      where: { id: r.id },
      data: { status: 'removed', resolvedAt: new Date() },
    });
    expect(updated.status).toBe('removed');
    expect(updated.resolvedAt).toBeTruthy();
  });

  it('按状态查询待处理申请', async () => {
    const pending = await prisma.dataRemovalRequest.findMany({
      where: { status: 'pending', handle: { startsWith: 'test-removal-' } },
    });
    expect(pending.every((p) => p.status === 'pending')).toBe(true);
    expect(pending.length).toBeGreaterThanOrEqual(2);
  });

  describe('actSubmitDataRemoval 校验', () => {
    it('拒绝无效平台', async () => {
      const r = await actSubmitDataRemoval({ platform: 'notaplatform', handle: 'act-removal-x', contact: 'a@b.com' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('平台');
    });

    it('拒绝过短的 handle', async () => {
      const r = await actSubmitDataRemoval({ platform: 'douyin', handle: 'a', contact: 'a@b.com' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('主页');
    });

    it('拒绝过短的联系方式', async () => {
      const r = await actSubmitDataRemoval({ platform: 'douyin', handle: 'act-removal-ok', contact: 'x' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('联系方式');
    });

    it('有效输入写入成功', async () => {
      const r = await actSubmitDataRemoval({
        platform: 'douyin',
        handle: 'act-removal-100',
        contact: 'valid@example.com',
        reason: '本人申请',
      });
      expect(r.ok).toBe(true);
      const saved = await prisma.dataRemovalRequest.findFirst({ where: { handle: 'act-removal-100' } });
      expect(saved).toBeTruthy();
      expect(saved!.platform).toBe('douyin');
    });

    it('重复提交同账号同联系人被去重拦截', async () => {
      const input = { platform: 'x', handle: 'act-removal-dup', contact: 'dup2@example.com' };
      const first = await actSubmitDataRemoval(input);
      expect(first.ok).toBe(true);
      const second = await actSubmitDataRemoval(input);
      expect(second.ok).toBe(false);
      expect(second.error).toContain('已提交');
    });

    it('字段超长被截断不报错', async () => {
      const r = await actSubmitDataRemoval({
        platform: 'bilibili',
        handle: 'act-removal-' + '长'.repeat(300),
        contact: 'longtest@example.com',
        reason: '理'.repeat(2000),
      });
      expect(r.ok).toBe(true);
      const saved = await prisma.dataRemovalRequest.findFirst({ where: { contact: 'longtest@example.com' } });
      expect(saved!.handle.length).toBeLessThanOrEqual(200);
      expect((saved!.reason ?? '').length).toBeLessThanOrEqual(1000);
    });
  });
});
