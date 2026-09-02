import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 工作流执行器。要钉住三条：
//   ① 一步失败就停（在错的基础上继续跑只会继续花钱）；
//   ② 发布步**只建计划、绝不真发**（模板是可以分享的，分享来的模板不该能把你的稿子发出去）；
//   ③ Mock 模型下不把示例内容写进草稿。

const h = vi.hoisted(() => ({ mocked: false, text: '这是一版初稿正文。' }));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({
    text: h.text, provider: 'p', model: 'm', mocked: h.mocked,
  }),
  llmCompleteStream: async () => new ReadableStream(),
  resolveProvider: async () => ({ mocked: h.mocked, name: 'p' }),
}));
vi.mock('@/lib/memory/core', () => ({
  buildMemoryContext: async () => '',
  writeMemory: async () => {},
  searchMemory: async () => [],
}));

const { runWorkflow } = await import('@/lib/workflow/run');
const { createTemplate } = await import('@/lib/workflow/market');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string };

beforeEach(async () => {
  h.mocked = false;
  await prisma.publishTask.deleteMany();
  await prisma.publishPlan.deleteMany();
  await prisma.workflowRun.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.topicIdea.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '号', platform: 'xiaohongshu', personaCard: '{}' },
  });
  await prisma.topicIdea.create({
    data: { accountId: account.id, title: '一个选题', angle: '一个切入角', state: 'accepted', totalScore: 90 },
  });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: 'm1' };
});

async function tpl(steps: unknown, name = '测试模板') {
  const r = await createTemplate(ctx.tenantId, ctx.memberId, { name, persona: '单测职责', steps });
  return (r as { id: string }).id;
}

describe('执行', () => {
  it('初稿步跑通后草稿里有正文', async () => {
    const id = await tpl([{ kind: 'draft', platform: 'xiaohongshu' }]);
    const run = await runWorkflow(ctx, id);
    expect(run.status).toBe('done');
    expect(run.draftId).toBeTruthy();
    const v = await prisma.draftVersion.findFirst({ where: { draftId: run.draftId! } });
    expect(v?.content).toContain('初稿');
  });

  it('Mock 模型下停在初稿这一步，不把示例内容写进草稿', async () => {
    h.mocked = true;
    const id = await tpl([{ kind: 'draft' }]);
    const run = await runWorkflow(ctx, id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('真实模型');
    expect(await prisma.draftVersion.count()).toBe(0);
  });

  it('一步失败就停，后面的步骤不再跑', async () => {
    // 第一步指向一个不存在的技能 → 失败；第二步是发布，不该被执行
    const id = await tpl([{ kind: 'skill', slug: 'no-such-skill' }, { kind: 'publish', platforms: ['wechat'] }]);
    const run = await runWorkflow(ctx, id);
    expect(run.status).toBe('failed');
    expect(run.logs).toHaveLength(1);
    expect(await prisma.publishPlan.count()).toBe(0);
  });

  it('发布步只建计划，不产生任何发布记录', async () => {
    const id = await tpl([{ kind: 'draft', platform: 'xiaohongshu' }, { kind: 'publish', platforms: ['xiaohongshu', 'wechat'] }]);
    const run = await runWorkflow(ctx, id);
    expect(run.status).toBe('done');

    const plans = await prisma.publishPlan.findMany({ include: { tasks: true } });
    expect(plans).toHaveLength(1);
    expect(plans[0].tasks).toHaveLength(2);
    // 关键：计划里的任务都还没发出去，也没有任何发布记录
    expect(plans[0].tasks.every((t) => t.status === 'ready')).toBe(true);
    expect(await prisma.publishRecord.count()).toBe(0);
  });

  it('每一步的结果都留痕（失败时要能看出停在哪一步）', async () => {
    const id = await tpl([{ kind: 'draft' }, { kind: 'skill', slug: 'nope' }]);
    const run = await runWorkflow(ctx, id);
    expect(run.logs.map((l) => l.ok)).toEqual([true, false]);
    expect(run.logs[1].message).toContain('nope');
    const saved = await prisma.workflowRun.findUnique({ where: { id: run.runId } });
    expect(saved?.status).toBe('failed');
    expect(saved?.error).toContain('第 2 步');
  });

  it('别的租户的模板跑不了', async () => {
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const id = await tpl([{ kind: 'draft' }]);
    await expect(runWorkflow({ ...ctx, tenantId: other.id }, id)).rejects.toThrow(/模板/);
  });
});
