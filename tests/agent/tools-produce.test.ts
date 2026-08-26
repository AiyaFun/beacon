import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 产出与发布类工具。这一组直接对着两条既有红线，所以守卫也钉在红线上：
//   ① **建计划 ≠ 发出去**，且「已填进后台」≠「已发布」——合并这两个说法，
//      用户会以为稿子已经出去了，这是这条线上最致命的错报；
//   ② 会诊那种十几次模型调用的活，**租户必须显式传下去**——不传就走「翻会话」，
//      而后台跑的执行翻不到会话，于是一个配额都不计、演示租户也拦不住。

const h = vi.hoisted(() => ({
  conveneArgs: [] as unknown[],
  coverResult: null as unknown,
}));

vi.mock('@/lib/advisor/panel', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/advisor/panel')>();
  return {
    ...real,
    convene: async (...args: unknown[]) => {
      h.conveneArgs = args;
      const session = await prisma.advisorSession.create({
        data: { accountId: args[0] as string, topicSeed: (args[2] as string) ?? null, status: 'done', summary: '结论' },
      });
      await prisma.advisorOpinion.create({
        data: { sessionId: session.id, personaKey: 'k', personaName: '数据席', personaRole: '看数据的', stance: 'neutral', suggestion: '从数据切', rationale: '因为' },
      });
      return session.id;
    },
  };
});

vi.mock('@/lib/cover/run', () => ({ runCover: async () => h.coverResult }));

const { toolByName } = await import('@/lib/agent/tools');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
let draftId: string;

beforeEach(async () => {
  h.conveneArgs = [];
  h.coverResult = { ok: true, images: [{ id: 'm1' }], spec: { label: '3:4' }, styleKey: 'clean' };
  await prisma.publishTask.deleteMany();
  await prisma.publishPlan.deleteMany();
  await prisma.advisorOpinion.deleteMany();
  await prisma.advisorSession.deleteMany();
  await prisma.draftVersion.deleteMany();
  await prisma.draft.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'xiaohongshu', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };

  const draft = await prisma.draft.create({ data: { accountId: account.id, title: '一篇稿子', platform: 'xiaohongshu' } });
  await prisma.draftVersion.create({ data: { draftId: draft.id, seq: 1, authorType: 'human', content: '正文'.repeat(50) } });
  draftId = draft.id;
});

const run = (name: string, args: Record<string, unknown> = {}) => toolByName(name)!.run(ctx, args);

describe('发布：建计划不等于发出去', () => {
  it('建完计划后必须明说「稿子还没有发出去」', async () => {
    const r = await run('create_publish_plan', { draftId, platforms: ['xiaohongshu'] });
    expect(r.ok).toBe(true);
    expect(r.summary, '不说破的话用户会以为已经发了').toContain('还没有发出去');

    // 库里只有计划与任务，没有任何发布记录
    expect(await prisma.publishPlan.count()).toBe(1);
    expect(await prisma.publishRecord.count(), '建计划绝不能产生发布记录').toBe(0);
  });

  it('只能手动发的平台要点名说出来', async () => {
    const r = await run('create_publish_plan', { draftId, platforms: ['xiaohongshu'] });
    // 小红书没有个人可用的发布接口，得用户自己点
    expect(r.summary).toContain('自己点发布');
  });

  it('这个工具是写操作，必须走确认闸', () => {
    const t = toolByName('create_publish_plan')!;
    expect(t.write, '不标 write 就会绕过确认，AI 能自己给用户排一堆发布计划').toBe(true);
  });

  it('别人的草稿建不了计划', async () => {
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const otherWs = await prisma.workspace.create({ data: { tenantId: other.id, name: 'OW' } });
    const otherAcc = await prisma.creatorAccount.create({
      data: { workspaceId: otherWs.id, name: '别人的号', platform: 'douyin', personaCard: '{}' },
    });
    const otherDraft = await prisma.draft.create({ data: { accountId: otherAcc.id, title: '别人的稿', platform: 'douyin' } });

    const r = await run('create_publish_plan', { draftId: otherDraft.id, platforms: ['douyin'] });
    expect(r.ok).toBe(false);
    expect(await prisma.publishPlan.count()).toBe(0);
  });
});

describe('发布：状态词不许合并', () => {
  it('「已填进后台」不能被讲成「已发布」', async () => {
    await run('create_publish_plan', { draftId, platforms: ['xiaohongshu'] });
    const task = await prisma.publishTask.findFirstOrThrow();
    await prisma.publishTask.update({ where: { id: task.id }, data: { status: 'filled' } });

    const rows = (await run('list_publish_plans')).data as { 各平台: { 状态: string }[] }[];
    const state = rows[0].各平台[0].状态;
    expect(state, '插件只能把内容填进后台，点不点发布是用户的事').toContain('等你点发布');
    expect(state).not.toBe('已发布');
  });
});

describe('会诊：租户必须显式传下去', () => {
  it('convene 拿到的是 ToolContext 里的 tenantId，不是靠翻会话', async () => {
    const r = await run('run_advisor', { topic: '露营装备怎么选' });
    expect(r.ok).toBe(true);
    // 第五个参数就是租户。传 undefined 的话 convene 会去翻会话，
    // 而后台跑的执行翻不到 → 配额一个都不计
    expect(h.conveneArgs[4], '不显式传租户，十几席会诊就是白送').toBe(ctx.tenantId);
  });

  it('这个工具很贵，必须标 costly（否则不弹确认就把钱花了）', () => {
    const t = toolByName('run_advisor')!;
    expect(t.costly).toBe(true);
  });

  it('没给题目也没给草稿时打回', async () => {
    const r = await run('run_advisor', {});
    expect(r.ok).toBe(false);
  });
});

describe('出图', () => {
  it('只回资产 id 与去哪看，绝不把图片字节塞进模型上下文', async () => {
    const r = await run('generate_image', { title: '三天两夜露营清单', platform: 'xiaohongshu' });
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, unknown>;
    expect(d.资产id).toEqual(['m1']);
    // 一张图的 base64 有几百 KB，进了上下文就把窗口撑爆
    expect(JSON.stringify(d), '不许出现图片数据').not.toContain('data:image');
  });

  it('配额用完与没配渠道要给不同的指引（用户要做的事不一样）', async () => {
    h.coverResult = { ok: false, error: '额度不够', reason: 'quota' };
    expect((await run('generate_image', { title: 'x', platform: 'xiaohongshu' })).error).toContain('套餐');

    h.coverResult = { ok: false, error: '没配渠道', reason: 'not_configured' };
    expect((await run('generate_image', { title: 'x', platform: 'xiaohongshu' })).error).toContain('接入与密钥');
  });

  it('别人的草稿 id 挂不上去', async () => {
    const other = await prisma.tenant.create({ data: { name: 'O2', plan: 'free' } });
    const otherWs = await prisma.workspace.create({ data: { tenantId: other.id, name: 'OW2' } });
    const otherAcc = await prisma.creatorAccount.create({
      data: { workspaceId: otherWs.id, name: '别人的号', platform: 'douyin', personaCard: '{}' },
    });
    const otherDraft = await prisma.draft.create({ data: { accountId: otherAcc.id, title: '别人的稿', platform: 'douyin' } });

    const r = await run('generate_image', { title: 'x', platform: 'xiaohongshu', draftId: otherDraft.id });
    expect(r.ok).toBe(false);
  });
});
