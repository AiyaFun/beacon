import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { toolByName } from '@/lib/agent/tools';
import { createTemplate, installTemplate, uninstallTemplate, ensureBuiltinTemplates } from '@/lib/workflow/market';

// list_agents：AI 眼里「这个团队能派哪些智能体」。
//
// 【这一份守的是什么】页面和 AI 必须看到同一份名单。它们曾经各查各的：
// 页面走 listTemplates（自建的天然可用、内置的看安装行的 enabled），
// AI 直接查 WorkflowInstall 表——于是两个洞同时存在：
//   ① 自建模板从来不写安装行 → 用户自己建的智能体对 AI 永远不存在，run_agent 也派不动；
//   ② 卸载只是把 enabled 置 false → 卸载掉的内置智能体照样被 AI 列出来还能派。
// 两条都是**静默失效**：页面上一切正常，只有对话里不对劲。
//
// 所以这里是行为测试而不是源码断言：断言「AI 看到的名单」本身，
// 而不是断言某处调了 listTemplates——后者换个等价写法就假绿。

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  await prisma.workflowInstall.deleteMany();
  await prisma.workflowRun.deleteMany();
  await prisma.workflowTemplate.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'xiaohongshu', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

const listAgents = async () => {
  const r = await toolByName('list_agents')!.run(ctx, {});
  return (r.data as { id: string; name: string; duty: string; steps: number }[]) ?? [];
};

describe('AI 看到的智能体名单', () => {
  it('用户自己建的智能体，建完 AI 立刻看得见', async () => {
    const created = await createTemplate(ctx.tenantId, ctx.memberId, {
      name: '我的日更流程',
      persona: '要发日更时派我',
      steps: [{ kind: 'draft', platform: 'xiaohongshu' }],
    });
    expect(created.ok).toBe(true);

    const rows = await listAgents();
    expect(rows.map((r) => r.name).join(), '自建智能体必须出现在 AI 的名单里').toContain('我的日更流程');
    // 职责说明要原样带上：模型靠它决定派谁
    expect(rows.find((r) => r.name.includes('我的日更流程'))?.duty).toContain('日更');
  });

  it('内置智能体：没装看不见，装了看得见，卸载后又看不见', async () => {
    await ensureBuiltinTemplates();
    const builtin = await prisma.workflowTemplate.findFirst({ where: { slug: 'daily-xhs' } });
    expect(builtin, '内置模板应已落库').toBeTruthy();

    expect((await listAgents()).some((r) => r.id === builtin!.id), '没装的内置模板不该出现').toBe(false);

    await installTemplate(ctx.tenantId, builtin!.id);
    expect((await listAgents()).some((r) => r.id === builtin!.id), '装了就该出现').toBe(true);

    // 卸载是把安装行 enabled 置 false（不是删行）——只删行的写法会让这条恒绿
    await uninstallTemplate(ctx.tenantId, builtin!.id);
    expect((await listAgents()).some((r) => r.id === builtin!.id), '卸载后 AI 就不该再派得动它').toBe(false);
  });

  it('别家租户的自建智能体一个都不许出现', async () => {
    const other = await prisma.tenant.create({ data: { name: '别家', plan: 'personal' } });
    const otherMember = await prisma.member.create({ data: { tenantId: other.id, name: '李四', role: 'owner' } });
    await createTemplate(other.id, otherMember.id, {
      name: '别家的流程',
      persona: '别家职责',
      steps: [{ kind: 'draft', platform: 'xiaohongshu' }],
    });

    const rows = await listAgents();
    expect(rows.map((r) => r.name).join(), '跨租户可见就是越权').not.toContain('别家的流程');
  });
});
