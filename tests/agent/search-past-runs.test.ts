import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 翻过去的执行记录（2026-09-02）。只查本工作区、不查自己、返回原文片段。

const { toolByName } = await import('@/lib/agent/tools');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string; runId?: string };
let otherWs = '';

beforeEach(async () => {
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const other = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W2' } });
  otherWs = other.id;
  const account = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' } });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

async function pastRun(workspaceId: string, goal: string, steps: { tool: string; result: string; ok?: boolean }[], answer?: string) {
  const run = await prisma.agentRun.create({ data: { workspaceId, memberId: ctx.memberId, goal, status: 'done', answer } });
  let seq = 0;
  for (const s of steps) {
    await prisma.agentStep.create({ data: { runId: run.id, seq: ++seq, kind: 'tool_result', tool: s.tool, result: s.result, ok: s.ok ?? true } });
  }
  return run;
}

const search = (query: string, extra: Record<string, unknown> = {}) => toolByName('search_past_runs')!.run(ctx, { query, ...extra });

describe('search_past_runs', () => {
  it('在步骤结果里找到，片段是原文、带工具名与是否成功', async () => {
    await pastRun(ctx.workspaceId, '采一遍竞对', [
      { tool: 'collect_competitor', result: '账号「老王聊车」页面改版了，只采到标题没有播放量', ok: false },
    ]);
    const r = await search('老王聊车');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('老王聊车');
    expect(r.summary).toContain('collect_competitor');
    expect(r.summary).toContain('没成');
    expect(r.summary).toContain('采一遍竞对');
  });

  it('目标与最终答复也能命中', async () => {
    await pastRun(ctx.workspaceId, '给小红书写三条标题', [], '写好了：A / B / C');
    expect((await search('小红书')).summary).toContain('给小红书写三条标题');
    expect((await search('写好了')).summary).toContain('最终答复');
  });

  it('🔒 别的工作区的看不到', async () => {
    await pastRun(otherWs, '别人的秘密任务', [{ tool: 'x', result: '别人的秘密结果' }]);
    const r = await search('秘密');
    expect(r.summary).toContain('没有');
    expect((r.data as { hits: unknown[] }).hits).toHaveLength(0);
  });

  it('🔒 不把正在跑的这次自己查出来', async () => {
    const me = await pastRun(ctx.workspaceId, '现在这次：查一下抖音', [{ tool: 'y', result: '抖音数据…' }]);
    ctx.runId = me.id;
    const r = await search('抖音');
    expect((r.data as { hits: unknown[] }).hits).toHaveLength(0);
  });

  it('同一次运行只留一条命中，条数按 limit 封顶', async () => {
    await pastRun(ctx.workspaceId, '大采集', Array.from({ length: 10 }, (_, i) => ({ tool: 't', result: `抖音第 ${i} 条` })));
    await pastRun(ctx.workspaceId, '另一次', [{ tool: 't', result: '抖音另一条' }]);
    const r = await search('抖音', { limit: 5 });
    const hits = (r.data as { hits: { runId: string }[] }).hits;
    expect(new Set(hits.map((h) => h.runId)).size).toBe(hits.length);
    expect(hits.length).toBe(2);
  });

  it('关键词太短/太长如实拒绝', async () => {
    expect((await search('a')).ok).toBe(false);
    expect((await search('x'.repeat(41))).ok).toBe(false);
  });

  it('系统提示告诉了模型什么时候用它（不然工具只是摆设）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('lib/agent/run.ts', 'utf8');
    const i = src.indexOf('function systemPrompt(');
    const body = src.slice(i, src.indexOf('\n}\n', i));
    expect(body).toContain('search_past_runs');
  });
});
