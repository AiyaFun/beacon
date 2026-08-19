import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { buildPublishPlan, applyTaskReceipt, readPlan } from '@/lib/publish/plan';
import { capOf, channelOf, TASK_STATUS_LABEL } from '@/lib/publish/capability';
import { textToWxHtml, wxDigest, publishToWechat } from '@/lib/publish/wechat-mp';

// 一键发布。这一组用例里最要紧的一条：**「已填进后台」不是「已发布」**。
// 把两者混成一个状态，用户会以为稿子出去了——这是这个功能唯一会造成真实损失的错报。

let ws: { id: string };
let accountId: string;
let draftId: string;
let memberId: string;

beforeEach(async () => {
  await prisma.publishTask.deleteMany();
  await prisma.publishPlan.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.draft.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  accountId = account.id;
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  memberId = member.id;

  const draft = await prisma.draft.create({ data: { accountId, title: '原稿标题', platform: 'douyin' } });
  await prisma.draftVersion.create({ data: { draftId: draft.id, seq: 1, authorType: 'ai', content: '原稿正文' } });
  draftId = draft.id;
});

describe('能力矩阵：不许承诺走不通的通道', () => {
  it('只有公众号是官方接口直发', () => {
    const api = ['wechat', 'douyin', 'xiaohongshu', 'bilibili', 'shipinhao', 'x', 'youtube', 'tiktok']
      .filter((p) => channelOf(p) === 'api');
    expect(api).toEqual(['wechat']);
  });

  it('每条通道都要给出「为什么是这条」，不许留空让用户以为是我们没做', () => {
    for (const p of ['wechat', 'douyin', 'xiaohongshu', 'bilibili', 'shipinhao', 'x', 'youtube', 'tiktok']) {
      expect(capOf(p).why.length, `${p} 缺少通道说明`).toBeGreaterThan(10);
    }
  });

  it('状态文案把「填好了」和「发布了」说成两件事', () => {
    expect(TASK_STATUS_LABEL.filled).toContain('等你点发布');
    expect(TASK_STATUS_LABEL.published).toBe('已发布');
    expect(TASK_STATUS_LABEL.filled).not.toBe(TASK_STATUS_LABEL.published);
  });
});

describe('建计划', () => {
  it('没确认 AIGC 声明就不许建', async () => {
    const r = await buildPublishPlan({
      workspaceId: ws.id, accountId, draftId, memberId, platforms: ['douyin'], aigcConfirmed: false,
    });
    expect(r.ok).toBe(false);
  });

  it('每个平台一条任务，通道按能力矩阵定', async () => {
    const r = await buildPublishPlan({
      workspaceId: ws.id, accountId, draftId, memberId,
      platforms: ['douyin', 'wechat', 'x'], aigcConfirmed: true,
    });
    expect(r.ok).toBe(true);
    const plan = await readPlan(ws.id, (r as { planId: string }).planId);
    expect(plan?.tasks.map((t) => t.channel).sort()).toEqual(['api', 'extension', 'manual']);
  });

  it('有该平台的派生稿就用派生稿；没有则用原稿并如实标注', async () => {
    const child = await prisma.draft.create({
      data: { accountId, title: '小红书版标题', platform: 'xiaohongshu', parentDraftId: draftId },
    });
    await prisma.draftVersion.create({ data: { draftId: child.id, seq: 1, authorType: 'ai', content: '小红书版正文' } });

    const r = await buildPublishPlan({
      workspaceId: ws.id, accountId, draftId, memberId,
      platforms: ['xiaohongshu', 'bilibili'], aigcConfirmed: true,
    });
    const plan = await readPlan(ws.id, (r as { planId: string }).planId);
    const xhs = plan!.tasks.find((t) => t.platform === 'xiaohongshu')!;
    const bili = plan!.tasks.find((t) => t.platform === 'bilibili')!;

    expect(xhs.content).toBe('小红书版正文');
    expect(xhs.extra.usedBaseDraft).toBe(false);
    expect(bili.content).toBe('原稿正文');
    expect(bili.extra.usedBaseDraft).toBe(true); // 用了原稿必须说出来
  });

  it('空正文不许建计划（发一篇空稿是纯粹的事故）', async () => {
    const empty = await prisma.draft.create({ data: { accountId, title: '空稿', platform: 'douyin' } });
    const r = await buildPublishPlan({
      workspaceId: ws.id, accountId, draftId: empty.id, memberId, platforms: ['douyin'], aigcConfirmed: true,
    });
    expect(r.ok).toBe(false);
  });
});

describe('回执：filled ≠ published', () => {
  async function mkPlan(platforms: string[]) {
    const r = await buildPublishPlan({ workspaceId: ws.id, accountId, draftId, memberId, platforms, aigcConfirmed: true });
    const plan = await readPlan(ws.id, (r as { planId: string }).planId);
    return plan!;
  }

  it('报 filled 只改状态，**不产生任何发布记录**', async () => {
    const plan = await mkPlan(['douyin']);
    const r = await applyTaskReceipt({ workspaceId: ws.id, taskId: plan.tasks[0].id, status: 'filled' });
    expect(r.ok).toBe(true);

    const after = await readPlan(ws.id, plan.id);
    expect(after!.tasks[0].status).toBe('filled');
    expect(await prisma.publishRecord.count()).toBe(0);
    // 草稿也不能被改成已发布
    expect((await prisma.draft.findUnique({ where: { id: draftId } }))!.status).toBe('editing');
  });

  it('报 published 才落发布记录，并按**任务的平台**归属', async () => {
    const plan = await mkPlan(['xiaohongshu']); // 草稿本身是抖音的，任务是小红书
    const task = plan.tasks[0];
    const r = await applyTaskReceipt({
      workspaceId: ws.id,
      taskId: task.id,
      status: 'published',
      url: 'https://www.xiaohongshu.com/explore/64f0a1b2c3d4e5f60718293a',
    });
    expect(r.ok).toBe(true);

    const records = await prisma.publishRecord.findMany();
    expect(records).toHaveLength(1);
    // 记成抖音的话，回流会去抖音找这条作品，永远找不到且看不出原因
    expect(records[0].platform).toBe('xiaohongshu');
    expect(records[0].platformItemId).toBe('64f0a1b2c3d4e5f60718293a');
    expect(records[0].needsBackfill).toBe(false);
  });

  it('没有链接照样能记一笔，但要标成「缺链接、回流不可用」', async () => {
    const plan = await mkPlan(['douyin']);
    const r = await applyTaskReceipt({ workspaceId: ws.id, taskId: plan.tasks[0].id, status: 'published' });
    expect(r.ok).toBe(true);
    const rec = await prisma.publishRecord.findFirst();
    expect(rec!.needsBackfill).toBe(true);
    expect((r as { warnings: string[] }).warnings.join()).toContain('回流');
  });

  it('全部任务走到终态后计划自动关闭', async () => {
    const plan = await mkPlan(['douyin', 'x']);
    await applyTaskReceipt({ workspaceId: ws.id, taskId: plan.tasks[0].id, status: 'skipped' });
    expect((await prisma.publishPlan.findUnique({ where: { id: plan.id } }))!.status).toBe('open');
    await applyTaskReceipt({
      workspaceId: ws.id, taskId: plan.tasks[1].id, status: 'published', url: 'https://x.com/a/status/1234567890',
    });
    expect((await prisma.publishPlan.findUnique({ where: { id: plan.id } }))!.status).toBe('done');
  });

  it('别的工作区的任务动不了', async () => {
    const plan = await mkPlan(['douyin']);
    const r = await applyTaskReceipt({ workspaceId: 'other-ws', taskId: plan.tasks[0].id, status: 'published' });
    expect(r.ok).toBe(false);
  });
});

describe('公众号', () => {
  it('没配凭证时如实报错，绝不假装发出去了', async () => {
    const r = await publishToWechat({ workspaceId: ws.id, accountId, title: 'T', content: 'C', coverAssetId: 'x' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('凭证');
  });

  it('正文转 HTML 会转义尖括号（否则用户写的 <script> 会被当成标签发出去）', () => {
    const html = textToWxHtml('第一段 <b>粗</b>\n换行\n\n第二段');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('<br/>');
    expect(html.split('<p>').length - 1).toBe(2);
  });

  it('摘要截到 120 字（公众号上限），不靠平台替我们截', () => {
    expect(wxDigest('字'.repeat(300)).length).toBe(120);
  });
});
