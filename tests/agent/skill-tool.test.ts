import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// run_skill：AI 拿一个技能去改写某篇草稿。
//
// 【为什么这一份是行为测试而不是源码断言】源码断言在这里会假绿：
// 把 `if (skill.outputKind === 'image')` 改成 `if (false && …)`，字符串还在、
// 位置也还在 runSkill 之前，扫源码的守卫照过不误——而闸门已经不存在了。
// 这两条都要验的是**真的没花钱**、**真的没落库**，所以直接盯 runSkill 有没有被调到。

const h = vi.hoisted(() => ({ ran: [] as { skillId: string }[], result: null as unknown }));

vi.mock('@/lib/skills', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/skills')>();
  return {
    ...real,
    runSkill: async (opts: { skillId: string }) => {
      h.ran.push({ skillId: opts.skillId });
      return h.result;
    },
  };
});

const { toolByName } = await import('@/lib/agent/tools');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
let draftId: string;

async function makeSkill(outputKind: string, name: string) {
  const skill = await prisma.contentSkill.create({
    data: {
      tenantId: ctx.tenantId,
      slug: `custom-${name}-${Date.now()}`,
      name,
      description: '测试用',
      promptTemplate: '改写：{{content}}',
      outputKind,
      platform: 'xiaohongshu',
      category: outputKind === 'image' ? 'visual' : 'format',
    },
  });
  await prisma.skillInstall.create({ data: { tenantId: ctx.tenantId, skillId: skill.id, enabled: true } });
  return skill.id;
}

beforeEach(async () => {
  h.ran = [];
  h.result = { ok: true, output: '改写后的正文', outputKind: 'markdown', mocked: false, skillName: 'X', riskLevel: 'low', hits: [] };
  await prisma.skillInstall.deleteMany();
  await prisma.contentSkill.deleteMany();
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
  await prisma.draftVersion.create({ data: { draftId: draft.id, seq: 1, authorType: 'human', content: '原始正文'.repeat(10) } });
  draftId = draft.id;
});

const run = (args: Record<string, unknown>) => toolByName('run_skill')!.run(ctx, args);
const versionCount = () => prisma.draftVersion.count({ where: { draftId } });

describe('出图技能不许走这条路', () => {
  it('image 技能当场拒绝，且**一分钱都没花**', async () => {
    const skillId = await makeSkill('image', '封面技能');
    const r = await run({ skill_id: skillId, draft_id: draftId });

    expect(r.ok).toBe(false);
    // 关键：闸门在 runSkill 之前。挪到之后（或被 `false &&` 关掉）这条立刻变红
    expect(h.ran, 'image 技能不该真的跑起来').toEqual([]);
    expect(r.error).toMatch(/封面|出图/);
    // 它的 output 只是印在封面上的标题那几个字，落进草稿版本 = 把整篇正文换成一行字
    expect(await versionCount(), '不该产生新版本').toBe(1);
  });

  it('文本技能正常跑，结果存成新版本', async () => {
    const skillId = await makeSkill('markdown', '小红书改写');
    const r = await run({ skill_id: skillId, draft_id: draftId });

    expect(r.ok).toBe(true);
    expect(h.ran.length).toBe(1);
    expect(await versionCount()).toBe(2);
  });
});

describe('Mock 产出一律不落库', () => {
  it('没接真模型时如实说没保存——写进去用户会直接拿这段示例文案去发', async () => {
    h.result = { ok: true, output: '（示例内容）', outputKind: 'markdown', mocked: true, skillName: 'X', riskLevel: 'low', hits: [] };
    const skillId = await makeSkill('markdown', '小红书改写');
    const r = await run({ skill_id: skillId, draft_id: draftId });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/示例|真实模型/);
    expect(await versionCount(), 'Mock 产出不该落库').toBe(1);
  });
});

describe('归属与前置校验', () => {
  it('别的工作区的草稿读不到（模型可能把别处见过的 id 直接拿来用）', async () => {
    const skillId = await makeSkill('markdown', '小红书改写');
    const other = await prisma.tenant.create({ data: { name: 'T2', plan: 'personal' } });
    const ows = await prisma.workspace.create({ data: { tenantId: other.id, name: 'W2' } });
    const oacc = await prisma.creatorAccount.create({
      data: { workspaceId: ows.id, name: '别人', platform: 'douyin', personaCard: '{}' },
    });
    const od = await prisma.draft.create({ data: { accountId: oacc.id, title: '别人的稿', platform: 'douyin' } });
    await prisma.draftVersion.create({ data: { draftId: od.id, seq: 1, authorType: 'human', content: '别人的正文' } });

    const r = await run({ skill_id: skillId, draft_id: od.id });
    expect(r.ok).toBe(false);
    expect(h.ran).toEqual([]);
  });

  it('空正文不跑：技能没有可作用的内容，跑了也只是白烧一次调用', async () => {
    const skillId = await makeSkill('markdown', '小红书改写');
    const empty = await prisma.draft.create({ data: { accountId: ctx.accountId, title: '空的', platform: 'xiaohongshu' } });
    const r = await run({ skill_id: skillId, draft_id: empty.id });
    expect(r.ok).toBe(false);
    expect(h.ran).toEqual([]);
  });
});
