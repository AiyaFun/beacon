import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// GET /api/account/export 的三道闸：登录态 / 角色 / 同源。
// 直接调 route handler（它就是个函数），不起服务器。
//
// 为什么单测矩阵不够：`tests/rbac.test.ts` 只证明 `can('viewer','data.export')` 为假，
// 证明不了这条路由**真的调了** can()。权限漏在路由里、矩阵测试照样全绿——
// 这类「守卫写没写」的缺口只有打到入口上才拦得住。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '我', role: 'owner', plan: 'free' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));

const { GET } = await import('@/app/api/account/export/route');

function get(headers: Record<string, string> = {}) {
  return GET(new Request('http://localhost/api/account/export', { headers }) as never);
}

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  const t = await prisma.tenant.create({ data: { name: '导出测试', plan: 'free' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: '主工作区' } });
  await prisma.creatorAccount.create({ data: { workspaceId: w.id, name: '主号', platform: 'douyin' } });
  session.tenantId = t.id;
  session.workspaceId = w.id;
  session.role = 'owner';
});

describe('GET /api/account/export', () => {
  it('owner → 200，返回带附件头的 JSON', async () => {
    const res = await get({ 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    // 中文文件名走 RFC 5987，ASCII 名兜底
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.creatorAccounts).toHaveLength(1);
  });

  it('admin → 200（管理员同样可导出）', async () => {
    session.role = 'admin';
    expect((await get()).status).toBe(200);
  });

  it('editor → 403（逐页看得到 ≠ 能打包带走）', async () => {
    session.role = 'editor';
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('权限不足');
  });

  it('viewer → 403', async () => {
    session.role = 'viewer';
    expect((await get()).status).toBe(403);
  });

  it('跨站发起 → 403（同源闸）', async () => {
    const res = await get({ 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('没有 sec-fetch-site 头时放行（老浏览器/curl；鉴权在会话上，同源闸只是加固）', async () => {
    expect((await get()).status).toBe(200);
  });
});
