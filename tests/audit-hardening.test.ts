import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// 2026-09-11 审计加固（reports/2026-09-11-beacon-functional-implementation-audit-and-plan.html）：
// 知识绑定跨工作区、工单并发抢占、网关严格模式、接力持久等待。每条都是「静默成功」型缺陷，
// 所以用例专门验「错的那条路现在会红」。

vi.mock('@/lib/llm/gateway', async (orig) => {
  const real = await orig<typeof import('@/lib/llm/gateway')>();
  return { ...real, llmComplete: async () => ({ text: '（剧本）', provider: 'scripted', model: 'scripted', mocked: false }) };
});
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));
// 子运行不真的跑（不踢后台循环）：这里要验的是「等待落库 → 终态叫醒 → 续跑」这条线，不是模型对话。
// 不 mock 的话 mock 出来的模型会在几十毫秒内把子运行跑完，用例里的状态迁移就成了竞态。
vi.mock('@/lib/agent/kick', () => ({ kickAgentRun: () => {}, settleAgentKicks: async () => {} }));

const ROOT = path.resolve(__dirname, '..');
const code = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'A', platform: 'douyin', personaCard: '{}' } });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: 'me', role: 'owner' } });
  return { tenantId: tenant.id, workspaceId: ws.id, accountId: acc.id, memberId: member.id };
}

describe('知识绑定：唯一键带工作区', () => {
  it('两个工作区给同一个内置模板绑同一个标签，各自成功、互不覆盖', async () => {
    const { bindKnowledge, listBindings } = await import('@/lib/agent/knowledge');
    const a = await fixture(); const b = await fixture();
    const tpl = await prisma.workflowTemplate.create({ data: { slug: `bot-${Date.now()}`, name: 'B', steps: '[]', mode: 'autonomous', isBuiltin: true } });
    expect((await bindKnowledge(a.workspaceId, tpl.id, a.memberId, { sourceType: 'library_tag', sourceId: '职场' })).ok).toBe(true);
    expect((await bindKnowledge(b.workspaceId, tpl.id, b.memberId, { sourceType: 'library_tag', sourceId: '职场' })).ok).toBe(true);
    expect(await listBindings(a.workspaceId, tpl.id)).toHaveLength(1);
    expect(await listBindings(b.workspaceId, tpl.id)).toHaveLength(1);
    const rows = await prisma.agentKnowledgeBinding.findMany({ where: { templateId: tpl.id } });
    expect(new Set(rows.map((r) => r.workspaceId)).size).toBe(2);
  });
  it('记忆只能整体绑；标签不能带分隔符；不存在的素材类型拒绝', async () => {
    const { bindKnowledge } = await import('@/lib/agent/knowledge');
    const a = await fixture();
    const tpl = await prisma.workflowTemplate.create({ data: { slug: `bot2-${Date.now()}`, name: 'B', steps: '[]', mode: 'autonomous', isBuiltin: true } });
    expect((await bindKnowledge(a.workspaceId, tpl.id, a.memberId, { sourceType: 'memory', sourceId: 'x' })).ok).toBe(false);
    expect((await bindKnowledge(a.workspaceId, tpl.id, a.memberId, { sourceType: 'library_tag', sourceId: 'a,b' })).ok).toBe(false);
    expect((await bindKnowledge(a.workspaceId, tpl.id, a.memberId, { sourceType: 'material_type', sourceId: '没有这种' })).ok).toBe(false);
    expect((await bindKnowledge(a.workspaceId, tpl.id, a.memberId, { sourceType: 'material_type', sourceId: '*' })).ok).toBe(true);
  });
});

describe('内容工单：状态与事件同事务、期望阶段抢占', () => {
  it('同一单并发验收与驳回只有一个成功，事件与状态一致', async () => {
    const { createWorkItem, advanceWorkItem, linkWorkItem, acceptWorkItem, rejectWorkItem, getWorkItem } = await import('@/lib/workitem/core');
    const f = await fixture();
    const draft = await prisma.draft.create({ data: { accountId: f.accountId, title: '稿', platform: 'douyin' } });
    const id = (await createWorkItem(f.workspaceId, f.memberId, { title: 'x', accountId: f.accountId, draftId: draft.id }) as { id: string }).id;
    expect((await advanceWorkItem(f.workspaceId, id, f.memberId, 'review')).ok).toBe(true);
    const [a, r] = await Promise.all([acceptWorkItem(f.workspaceId, id, f.memberId), rejectWorkItem(f.workspaceId, id, f.memberId, '不行')]);
    expect([a.ok, r.ok].filter(Boolean)).toHaveLength(1);
    const v = (await getWorkItem(f.workspaceId, id))!;
    const decisive = v.events.filter((e) => e.kind === 'accept' || e.kind === 'reject');
    expect(decisive).toHaveLength(1);
    expect(v.stage).toBe(decisive[0].kind === 'accept' ? 'ready' : 'drafting');
    // 挂别的账号的选题/发布记录会被拒
    expect((await linkWorkItem(f.workspaceId, id, f.memberId, { kind: 'topic', refId: 'nope' })).ok).toBe(false);
  });
  it('派活关系走关系表：并发挂两次同一运行只留一条', async () => {
    const { createWorkItem, attachRun, getWorkItem } = await import('@/lib/workitem/core');
    const f = await fixture();
    const id = (await createWorkItem(f.workspaceId, f.memberId, { title: 'x', accountId: f.accountId }) as { id: string }).id;
    const run = await prisma.agentRun.create({ data: { workspaceId: f.workspaceId, accountId: f.accountId, memberId: f.memberId, goal: 'g', status: 'done' } });
    await Promise.all([attachRun(f.workspaceId, id, run.id, f.memberId), attachRun(f.workspaceId, id, run.id, f.memberId)]);
    expect((await getWorkItem(f.workspaceId, id))!.runIds).toEqual([run.id]);
    expect(await prisma.workItemRun.count({ where: { workItemId: id } })).toBe(1);
  });
});

describe('网关：显式指定的渠道不可用时报错，不静默换', () => {
  it('providerId 指向不存在/失效的渠道 → 抛错', async () => {
    const { resolveProvider } = await vi.importActual<typeof import('@/lib/llm/gateway')>('@/lib/llm/gateway');
    const f = await fixture();
    await expect(resolveProvider(f.tenantId, 'chat', { providerId: 'nope' })).rejects.toThrow(/不存在或已失效/);
    const failed = await prisma.modelProvider.create({ data: { tenantId: f.tenantId, label: 'x', vendor: 'deepseek', baseUrl: 'https://x', apiKeyEnc: 'enc', model: 'm', region: 'cn', routing: '{}', status: 'failed' } });
    await expect(resolveProvider(f.tenantId, 'chat', { providerId: failed.id })).rejects.toThrow();
  });
  it('🔒 源码：显式 providerId 落空的分支是 throw，不是继续路由', () => {
    const g = code('lib/llm/gateway.ts');
    expect(g).toMatch(/if \(opts\?\.providerId\) \{[\s\S]*?throw new Error/);
  });
});

describe('接力：持久等待，重启可续跑', () => {
  beforeEach(() => { vi.stubEnv('BEACON_QUEUE', 'local'); });

  it('派出子运行后流水线停在该步并记 waitingOn；子运行到终态后从同一步续跑到 done', async () => {
    const f = await fixture();
    const bot = await prisma.workflowTemplate.create({ data: { slug: `bot-relay-${Date.now()}`, name: '写手', emoji: '✍️', steps: '[]', mode: 'autonomous', isBuiltin: true, agentConfig: JSON.stringify({ systemPrompt: '', tools: ['list_drafts'] }) } });
    const relay = await prisma.workflowTemplate.create({ data: { slug: `relay-${Date.now()}`, name: '接力', steps: JSON.stringify([{ kind: 'handoff', bot: bot.slug, goal: '写一段', deliverable: 'answer', maxCalls: 3, timeoutMinutes: 5 }]), tenantId: f.tenantId } });
    const { createWorkflowRun, executeWorkflowRun } = await import('@/lib/workflow/run');
    const ctx = { ...f, trigger: 'manual' as const };
    const wfId = await createWorkflowRun(ctx, relay.id);
    const v1 = await executeWorkflowRun(ctx, wfId);
    expect(v1.status).toBe('running');
    const row1 = (await prisma.workflowRun.findUnique({ where: { id: wfId } }))!;
    expect(row1.waitingOn).toMatch(/^run:/);
    expect(row1.stepIndex).toBe(0);
    expect(row1.memberId).toBe(f.memberId);
    const childId = row1.waitingOn!.slice(4);
    const child = (await prisma.agentRun.findUnique({ where: { id: childId } }))!;
    expect(child.agentTemplateId).toBe(bot.id);
    expect(child.origin).toBe('workflow');

    // 模拟：进程重启，什么内存状态都没有；子运行到终态（走状态迁移，触发终态钩子）
    const { transition } = await import('@/lib/agent/run');
    const { settleWorkflowKicks } = await import('@/lib/workflow/kick');
    const ok = await transition(childId, ['queued', 'running'], 'done', { answer: '这是一段足够长的交付说明，够二十个字了吧应该够了', pending: null, waitingOn: null, leaseUntil: null });
    expect(ok).toBe(true);
    await settleWorkflowKicks();
    const row2 = (await prisma.workflowRun.findUnique({ where: { id: wfId } }))!;
    expect(row2.status).toBe('done');
    expect(row2.waitingOn).toBeNull();
    const logs = JSON.parse(row2.log) as { ok: boolean; brief?: { text: string } }[];
    expect(logs).toHaveLength(1);
    expect(logs[0].ok).toBe(true);
    expect(logs[0].brief?.text).toContain('交付说明');
  });

  it('巡检：子运行超时 → 终止子运行、流水线判失败；等待中的不会被当「跑飞」判死', async () => {
    const f = await fixture();
    const bot = await prisma.workflowTemplate.create({ data: { slug: `bot-relay2-${Date.now()}`, name: '写手', steps: '[]', mode: 'autonomous', isBuiltin: true, agentConfig: JSON.stringify({ systemPrompt: '', tools: ['list_drafts'] }) } });
    const relay = await prisma.workflowTemplate.create({ data: { slug: `relay2-${Date.now()}`, name: '接力', steps: JSON.stringify([{ kind: 'handoff', bot: bot.slug, goal: 'x', deliverable: 'answer', timeoutMinutes: 1 }]), tenantId: f.tenantId } });
    const { createWorkflowRun, executeWorkflowRun } = await import('@/lib/workflow/run');
    const ctx = { ...f, trigger: 'manual' as const };
    const wfId = await createWorkflowRun(ctx, relay.id);
    await executeWorkflowRun(ctx, wfId);
    const childId = (await prisma.workflowRun.findUnique({ where: { id: wfId } }))!.waitingOn!.slice(4);
    // 让子运行卡在「等确认」（乐观锁：后台循环再想把它改成 done 会落空），模拟一跳停住没人点头
    const { transition, LIVE_STATUSES } = await import('@/lib/agent/run');
    expect(await transition(childId, LIVE_STATUSES, 'awaiting_confirm', { pending: '{"name":"x","arguments":"{}"}', leaseUntil: null })).toBe(true);
    // 把等待时间「拨」到 3 小时前：既超过 timeoutMinutes，也超过跑飞阈值（2 小时）
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await prisma.workflowRun.update({ where: { id: wfId }, data: { updatedAt: old } });
    expect((await prisma.workflowRun.findUnique({ where: { id: wfId } }))!.updatedAt.getTime()).toBeLessThan(Date.now() - 60 * 60_000);
    const { tickAgentRuns } = await import('@/lib/agent/tick');
    await tickAgentRuns();
    const row = (await prisma.workflowRun.findUnique({ where: { id: wfId } }))!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/超过 1 分钟/);
    expect((await prisma.agentRun.findUnique({ where: { id: childId } }))!.status).toBe('cancelled');
  });

  it('🔒 源码：接力不在进程里轮询；终态钩子会叫醒流水线；巡检跳过持久等待中的流水线', () => {
    expect(code('lib/workflow/handoff.ts')).not.toMatch(/setTimeout/);
    expect(code('lib/agent/run.ts')).toMatch(/resumeWorkflowAfterChild\(runId\)/);
    expect(code('lib/agent/tick.ts')).toMatch(/waitingOn: null, updatedAt/);
    expect(code('lib/workflow/run.ts')).toMatch(/waitingOn: waiting/);
  });
});
