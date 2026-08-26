import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { toolByName } from '@/lib/agent/tools';

// 数据与洞察类工具。两条性质最要紧，都属于「不红也不 404、只是悄悄说错话」的那类：
//
//   ① **读对表**。account_performance 曾经查的是 OwnPost，而插件回填与发布登记
//      写的是 PublishRecord——用户在数据看板上看得见几十条，问 AI 却得到
//      「还没有回流的作品数据」。功能看着在，其实一直没接上。
//   ② **缺席不许当 0**。抖音公开页没有播放量，这是「平台没有」不是「表现差」。
//      给模型回 0 的下场项目里出过两次（全平台互动率 0.0%、按互动率排序被摁到最底）。

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.ownPost.deleteMany();
  await prisma.readerComment.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

const run = (name: string, args: Record<string, unknown> = {}) => toolByName(name)!.run(ctx, args);

describe('account_performance 读的是真正有数据的那张表', () => {
  it('插件回填/发布登记写的 PublishRecord 必须被读到', async () => {
    await prisma.publishRecord.create({
      data: {
        accountId: ctx.accountId,
        platform: 'douyin',
        title: '一条真发过的作品',
        metrics: JSON.stringify({ likes: 320, comments: 15 }),
      },
    });

    const r = await run('account_performance');
    expect(r.ok).toBe(true);
    const rows = r.data as { title: string; likes: number | null }[];
    // 这一条就是那次缺陷的复现：读 OwnPost 的写法在这里会得到空数组
    expect(rows, '发布记录必须出现在 AI 看到的数据里').toHaveLength(1);
    expect(rows[0].title).toBe('一条真发过的作品');
    expect(rows[0].likes).toBe(320);
  });

  it('抖音没有播放量 → 给 null 并附「为什么没有」，绝不写 0', async () => {
    await prisma.publishRecord.create({
      data: {
        accountId: ctx.accountId,
        platform: 'douyin',
        title: '没有播放量的作品',
        metrics: JSON.stringify({ likes: 100 }), // 抖音公开页只有点赞，没有播放
      },
    });

    const rows = (await run('account_performance')).data as Record<string, unknown>[];
    expect(rows[0].views, '缺席必须是 null——写 0 会让模型算出假的互动率').toBeNull();
    expect(rows[0]['views_缺席原因'], '只给 null 模型分不清「平台没有」和「真的是 0」').toBeTruthy();
    expect(rows[0].likes).toBe(100);
  });

  it('一条发布记录都没有、但导入过历史作品 → 要指路，而不是干说「没有数据」', async () => {
    await prisma.ownPost.create({
      data: { accountId: ctx.accountId, platform: 'douyin', title: '导入的老作品', metrics: '{}' },
    });
    const r = await run('account_performance');
    expect(r.summary).toContain('导入过');
  });

  it('什么都没有时如实说没有', async () => {
    const r = await run('account_performance');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('还没有作品数据');
  });
});

describe('work_metrics 单条作品', () => {
  it('带上逐日快照，能看出是哪天断的', async () => {
    const rec = await prisma.publishRecord.create({
      data: { accountId: ctx.accountId, platform: 'bilibili', title: '一条 B 站视频', metrics: JSON.stringify({ views: 100 }) },
    });
    await prisma.performanceSnapshot.create({
      data: { publishId: rec.id, takenAt: new Date(Date.now() - 86400_000), metrics: JSON.stringify({ views: 800 }), source: 'plugin' },
    });
    await prisma.performanceSnapshot.create({
      data: { publishId: rec.id, takenAt: new Date(), metrics: JSON.stringify({ views: 5200 }), source: 'plugin' },
    });

    const r = await run('work_metrics', { publishId: rec.id });
    expect(r.ok).toBe(true);
    const d = r.data as { 指标: Record<string, unknown>; 趋势: unknown[]; 快照条数: number };
    expect(d.快照条数).toBe(2);
    expect(d.趋势).toHaveLength(2);
    // 下结论要用「来源优先级」挑出来的那份（插件采的 5200），
    // 不是 PublishRecord.metrics 上那个登记时随手填的 100
    expect(d.指标.views, '要用权威值，不是登记时填的那个约数').toBe(5200);
  });

  it('别人账号的作品 id 读不到（模型可能把别处见过的 id 拿来用）', async () => {
    const otherTenant = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const otherWs = await prisma.workspace.create({ data: { tenantId: otherTenant.id, name: 'OW' } });
    const otherAcc = await prisma.creatorAccount.create({
      data: { workspaceId: otherWs.id, name: '别人的号', platform: 'douyin', personaCard: '{}' },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId: otherAcc.id, platform: 'douyin', title: '别人的作品', metrics: '{}' },
    });

    const r = await run('work_metrics', { publishId: rec.id });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不属于');
  });

  it('从没回流过的作品要说清楚「这个数是登记时填的」', async () => {
    const rec = await prisma.publishRecord.create({
      data: { accountId: ctx.accountId, platform: 'douyin', title: '手工登记的', metrics: JSON.stringify({ likes: 5 }) },
    });
    const d = (await run('work_metrics', { publishId: rec.id })).data as { 说明: string | null };
    expect(d.说明).toContain('没回流过');
  });
});

describe('list_comments 读者原声', () => {
  it('没有留存的评论时，要说清楚「保留 90 天」而不是「没人评论」', async () => {
    const r = await run('list_comments');
    expect(r.ok).toBe(true);
    expect(r.summary, '不能让模型对用户说「你的作品没人评论」').toContain('90 天');
  });

  it('有评论时给出分类占比与话题例句', async () => {
    // 同一条作品下同一句话只留一行（唯一键 workspaceId+platform+workKey+textHash），
    // 所以三条要各不相同
    const texts = ['这个剪辑软件叫什么呀，求教程', '剪辑软件求个教程链接', '想问下剪辑软件是哪个'];
    for (const [i, text] of texts.entries()) {
      await prisma.readerComment.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: ctx.accountId,
          scope: 'own',
          platform: 'douyin',
          workKey: 'douyin:w1',
          text,
          textHash: `h${i}`,
          kind: 'question',
        },
      });
    }
    const r = await run('list_comments');
    expect(r.ok).toBe(true);
    const d = r.data as { 总条数: number; 分类占比: unknown[] };
    expect(d.总条数).toBe(3);
    expect(d.分类占比.length).toBeGreaterThan(0);
  });
});

describe('genes_summary 爆款基因', () => {
  it('没有样本时说「还没有样本」，不说「基因弱」', async () => {
    const r = await run('genes_summary');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('还没有样本');
    // 文案要**主动说破**「这不是基因弱」——只说「算不出来」模型会自己补一句
    // 「你的内容特征不明显」，那是凭空结论
    expect(r.summary).toContain('不是');
  });
});

describe('algorithm_hint 平台算法诊断', () => {
  it('没有带播放量的样本时也给通用建议，且如实说样本为 0', async () => {
    const r = await run('algorithm_hint', { platform: 'douyin' });
    expect(r.ok).toBe(true);
    const d = r.data as { 样本数: number; 诊断: unknown[]; 基线: Record<string, unknown> };
    expect(d.样本数).toBe(0);
    expect(d.诊断.length, '样本不足也该给出一条说明，而不是空数组').toBeGreaterThan(0);
    // 算不出来的率必须是 null：写 0.0% 会让模型给出「你点赞率过低」这种凭空结论
    expect(d.基线.点赞率).toBeNull();
  });

  it('不传平台时用当前账号的主战平台', async () => {
    const r = await run('algorithm_hint');
    expect(r.ok).toBe(true);
    expect((r.data as { 平台: string }).平台).toBeTruthy();
  });
});
