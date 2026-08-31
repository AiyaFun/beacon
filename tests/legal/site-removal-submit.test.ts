import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { isSiteRemovalRequested, SITE_KIND, SITE_PLATFORM } from '@/lib/legal/removal';

// 站点类申请**提交**这条路的真跑（2026-08-29）。
//
// 【为什么要单独真跑】它是一个**公开、未登录**的写入口，而且一条 pending 就会让
// 全站停止抓取那个域名。前面 tests/legal/site-removal.test.ts 测的是「闸」与「执行」，
// 但**提交**那一段（平台校验分叉、归一、去重键）只有源码断言——
// 而这一轮已经吃过两次亏：`/llms.txt` 漏进 middleware、三条写库路径从没真跑过。
// 一条从提交到生效的端到端，才能证明这个权利真的能被行使。

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.77' }) }));

const { actSubmitDataRemoval } = await import('@/app/(public)/legal/data-request/actions');

describe('站点停采：从提交到生效', () => {
  beforeEach(async () => {
    await prisma.dataRemovalRequest.deleteMany({});
  });

  it('🔒 端到端：提交 → 入库 → 闸立刻生效', async () => {
    const r = await actSubmitDataRemoval({
      kind: SITE_KIND, platform: '', handle: 'https://www.Example.com/about',
      contact: 'owner@example.com', reason: '我是站长',
    });
    expect(r.ok, r.error).toBe(true);

    const row = await prisma.dataRemovalRequest.findFirst({ where: { kind: SITE_KIND } });
    expect(row).toBeTruthy();
    // 归一到主机名：去协议、去 www、转小写。不归一的话闸永远匹配不上
    expect(row!.handle).toBe('example.com');
    expect(row!.platform).toBe(SITE_PLATFORM);
    expect(row!.status).toBe('pending');

    // pending 就该停——这才是「先停采再核验」这句承诺的兑现
    expect(await isSiteRemovalRequested('http://example.com/anything')).toBe(true);
    expect(await isSiteRemovalRequested('https://blog.example.com')).toBe(true);
    // 而后缀相似的站点不受影响
    expect(await isSiteRemovalRequested('https://notexample.com')).toBe(false);
  });

  it('🔒 站点类不要求选平台（要求了的话用户根本提交不上来）', async () => {
    const r = await actSubmitDataRemoval({
      kind: SITE_KIND, platform: '', handle: 'foo.cn',
      contact: 'a@b.com', reason: '',
    });
    expect(r.ok, r.error).toBe(true);
  });

  it('认不出域名 → 明确报错，而不是存一条永远匹配不上的申请', async () => {
    const r = await actSubmitDataRemoval({
      kind: SITE_KIND, platform: '', handle: '//',
      contact: 'a@b.com', reason: '',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('域名');
    expect(await prisma.dataRemovalRequest.count()).toBe(0);
  });

  it('重复提交同一个站点被去重', async () => {
    const one = { kind: SITE_KIND, platform: '', handle: 'dup.com', contact: 'a@b.com', reason: '' };
    expect((await actSubmitDataRemoval(one)).ok).toBe(true);
    const again = await actSubmitDataRemoval(one);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('这个站点');
    expect(await prisma.dataRemovalRequest.count()).toBe(1);
  });

  it('🔒 账号类照旧要选平台（加了 site 分叉不能把原来的闸放松）', async () => {
    const r = await actSubmitDataRemoval({
      kind: 'account', platform: '', handle: 'someone',
      contact: 'a@b.com', reason: '',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('平台');
  });

  it('🔒 kind 拼错 → 退回权限最小的那一类，不是站点类', async () => {
    // fail-open 的典型形状：拼错的值静默变成权限更大的那一类
    const r = await actSubmitDataRemoval({
      kind: 'siteee', platform: 'douyin', handle: 'someone',
      contact: 'a@b.com', reason: '',
    });
    expect(r.ok, r.error).toBe(true);
    const row = await prisma.dataRemovalRequest.findFirst();
    expect(row!.kind).toBe('account');
    expect(row!.platform).toBe('douyin');
  });
});
