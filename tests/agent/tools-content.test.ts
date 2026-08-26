import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 内容与记忆类工具。这一组最容易长出来的静默错有三个，各钉一条：
//   ① 写记忆用了缺省置信度 → 库里有这条、但**不生效**，用户以为 AI 记住了其实没有；
//   ② 抓不到的平台不先判断就去试抓 → 用户等十秒才收到一句失败；
//   ③ 剪藏时 AI 那步降级了却不说破 → 模型对用户说「已经帮你总结好了」而摘要是空的。

const h = vi.hoisted(() => ({ clipResult: null as unknown }));

vi.mock('@/lib/clip', () => ({
  clipUrl: async () => h.clipResult,
}));

const { toolByName } = await import('@/lib/agent/tools');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.clipResult = { ok: true, id: 'i1', title: '一篇文章', summary: '摘要', points: ['要点'], analysis: '分析', degraded: false };
  await prisma.memoryEntry.deleteMany();
  await prisma.inspirationItem.deleteMany();
  await prisma.material.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'xiaohongshu', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

const run = (name: string, args: Record<string, unknown> = {}) => toolByName(name)!.run(ctx, args);

describe('write_memory 写进去就得真的生效', () => {
  it('写一条记忆后它是 active 的（用缺省置信度会写成不生效的僵尸条）', async () => {
    const r = await run('write_memory', { type: 'preference', content: '不喜欢用感叹号' });
    expect(r.ok).toBe(true);

    const row = await prisma.memoryEntry.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } });
    expect(row.content).toBe('不喜欢用感叹号');
    // 这是关键：writeMemory 的新建缺省 confidence 是 0.3，而生效线是 0.5。
    // 用缺省值写进去 = 库里有这条但每次生成都不会带上它，用户以为「说了记住其实没记」
    expect(row.active, '写完就该生效，否则等于没记').toBe(true);
    expect(r.summary).toContain('记住了');
  });

  it('记忆挂在当前账号名下，不是工作区共享（共享会污染同工作区别的号）', async () => {
    await run('write_memory', { type: 'fact', content: '主做美妆测评' });
    const row = await prisma.memoryEntry.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } });
    expect(row.accountId).toBe(ctx.accountId);
  });

  it('类型不在四类里就打回，不静默写成 other', async () => {
    const r = await run('write_memory', { type: '随便', content: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('persona');
    expect(await prisma.memoryEntry.count()).toBe(0);
  });

  it('太长的不收（那就不是「一件事」了）', async () => {
    const r = await run('write_memory', { type: 'fact', content: '啊'.repeat(201) });
    expect(r.ok).toBe(false);
    expect(await prisma.memoryEntry.count()).toBe(0);
  });
});

describe('compliance_check 查到了什么，而不是拦不拦', () => {
  it('命中词按词去重并带上出现次数（同一个词三次不该报成三条风险）', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '最好', tier: 'platform', action: 'warn', platform: 'xiaohongshu', suggestion: '换成「我更常用」' },
    });
    const r = await run('compliance_check', { text: '这个最好，那个也最好，反正最好', platform: 'xiaohongshu' });

    expect(r.ok).toBe(true);
    const d = r.data as { 结论: string; 命中词: { word: string; 出现次数: number }[] };
    expect(d.命中词, '同一个词只该出现一条').toHaveLength(1);
    expect(d.命中词[0].出现次数).toBe(3);
    expect(d.结论).toBe('warn');
  });

  it('命中法律红线时要说清楚「按现状不能发」，并把理由给出来', async () => {
    await prisma.sensitiveWord.create({
      data: { word: '包治百病', tier: 'legal', action: 'block' },
    });
    const r = await run('compliance_check', { text: '这个产品包治百病', platform: 'xiaohongshu' });
    const d = r.data as { 结论: string; 红线: string | null };
    expect(d.结论).toBe('block');
    // gateSkillOutput 在这种情况下会把 hits 吞掉只回一句拒绝——那样模型没法告诉用户改哪里
    expect(d.红线, '要给出具体理由，不能只说「不合规」').toBeTruthy();
    expect(r.summary).toContain('不能发');
  });

  it('空文案直接打回', async () => {
    const r = await run('compliance_check', { text: '   ' });
    expect(r.ok).toBe(false);
  });
});

describe('search_library 查资讯库', () => {
  it('按关键词命中标题/摘要/备注', async () => {
    await prisma.inspirationItem.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, title: '关于露营装备的深度长文', summary: '讲了帐篷选购' },
    });
    await prisma.inspirationItem.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, title: '完全无关的一篇' },
    });

    const r = await run('search_library', { keyword: '露营' });
    const rows = r.data as { 标题: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].标题).toContain('露营');
  });

  it('工作区共享的条目（accountId 为空）也要能查到', async () => {
    await prisma.inspirationItem.create({
      data: { workspaceId: ctx.workspaceId, accountId: null, title: '同事存的一篇' },
    });
    const rows = (await run('search_library')).data as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('别的工作区的存档一条都不许出现', async () => {
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const otherWs = await prisma.workspace.create({ data: { tenantId: other.id, name: 'OW' } });
    await prisma.inspirationItem.create({ data: { workspaceId: otherWs.id, title: '别家的存档' } });

    const rows = (await run('search_library')).data as { 标题: string }[];
    expect(rows.map((r) => r.标题).join()).not.toContain('别家');
  });

  it('空库时要指路（怎么才能有东西），而不是干说「没有」', async () => {
    const r = await run('search_library');
    expect(r.summary).toContain('插件');
  });
});

describe('clip_url 收藏链接', () => {
  it('服务端抓不到的平台**当场**说清楚，不去试抓（试抓要等十秒）', async () => {
    const r = await run('clip_url', { url: 'https://mp.weixin.qq.com/s/abc' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('插件');
  });

  it('AI 那步降级了必须说破，不能让模型宣布「已经总结好了」', async () => {
    h.clipResult = { ok: true, id: 'i9', title: '一篇文章', summary: '', points: [], analysis: '', degraded: true };
    const r = await run('clip_url', { url: 'https://example.com/post' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('没能生成摘要');
  });

  it('正常收进来时给出摘要与要点', async () => {
    const r = await run('clip_url', { url: 'https://example.com/post' });
    expect(r.ok).toBe(true);
    expect((r.data as { 摘要: string }).摘要).toBe('摘要');
  });
});

describe('list_materials', () => {
  it('空素材库要说清楚「存了会很不一样」，而不是只说没有', async () => {
    const r = await run('list_materials');
    expect(r.summary).toContain('素材库还是空的');
  });

  it('列出本账号的素材', async () => {
    await prisma.material.create({
      data: { accountId: ctx.accountId, type: 'experience', content: '我在西藏骑行过 21 天', tags: '[]' },
    });
    const rows = (await run('list_materials')).data as { 内容: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].内容).toContain('西藏');
  });
});

describe('read_persona_memory', () => {
  it('没有新记忆时要说明「不代表以前没记住」', async () => {
    const r = await run('read_persona_memory');
    expect(r.summary).toContain('不代表');
  });
});
