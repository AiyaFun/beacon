import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// 批 6：打磨。三件都是「早先的批次留下的半截」——
//   · LlmCallLog.runId 批 0 就加了，直到现在才有读它的地方
//   · 对外调用面一直只能发起与查状态，派错了只能等它跑完
//   · 通知红点是工作区级的，而「等你确认」只有发起人点得动

const h = vi.hoisted(() => ({ script: [] as { text?: string }[] }));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return { text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView, transition } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { unreadNotificationCount, listNotifications, notify } = await import('@/lib/notify');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.script = [];
  await prisma.llmCallLog.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.notification.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

describe('这次花了多少', () => {
  // 【为什么按 token 而不只按次数】长任务后段每次调用都背着接近上限的对话，
  // 单次成本是短调用的十倍量级。只报「调了 N 次」会让用户以为
  // 「10 次的任务只有 1 次的十倍贵」——实际差得远。
  it('按账本现算调用数与 token，Mock 不算（它不花钱）', async () => {
    h.script = [{ text: '好' }];
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();

    await prisma.llmCallLog.createMany({
      data: [
        { tenantId: ctx.tenantId, fn: 'chat', runId: t.runId, provider: 'p', model: 'm', mocked: false, promptTokens: 1200, completionTokens: 300 },
        { tenantId: ctx.tenantId, fn: 'chat', runId: t.runId, provider: 'p', model: 'm', mocked: false, promptTokens: 800, completionTokens: 200 },
        { tenantId: ctx.tenantId, fn: 'chat', runId: t.runId, provider: 'mock', model: 'mock', mocked: true, promptTokens: 999, completionTokens: 999 },
      ],
    });

    const view = await getAgentRunView(ctx, t.runId);
    expect(view.cost?.calls, 'Mock 调用不该算进去').toBe(2);
    expect(view.cost?.tokens).toBe(2500);
  });

  it('一次都没烧就不显示（别摆一行「0 次调用」）', async () => {
    h.script = [{ text: '好' }];
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, t.runId)).cost).toBeUndefined();
  });

  it('别的执行的调用不算在我头上', async () => {
    h.script = [{ text: '好' }, { text: '好' }];
    const a = await startAgentRun(ctx, '甲');
    const b = await startAgentRun(ctx, '乙');
    await settleAgentKicks();
    await prisma.llmCallLog.create({
      data: { tenantId: ctx.tenantId, fn: 'chat', runId: b.runId, provider: 'p', model: 'm', mocked: false, promptTokens: 100, completionTokens: 100 },
    });
    expect((await getAgentRunView(ctx, a.runId)).cost).toBeUndefined();
    expect((await getAgentRunView(ctx, b.runId)).cost?.calls).toBe(1);
  });

  it('界面上真的摆出来了，且带 token 不只带次数', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'app/(app)/assistant/AgentPanel.tsx'), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
    expect(src, '任务视图没显示花了多少').toMatch(/turn\.cost/);
    expect(src, '只报了次数——长任务的单次成本是短调用的十倍量级').toMatch(/tokens/);
  });
});

describe('对外调用面：可以终止，但永远不能确认', () => {
  // 【两者的性质不一样】
  //   确认 = 替用户同意一件他没看过的事。调用方常常是另一个模型，
  //          模型 A 起草、模型 B 代签，那条规矩就等于没有。
  //   终止 = 不做。它不产生任何新的写操作，最坏是白跑一趟。
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

  it('有 DELETE（终止），没有确认接口', () => {
    const src = read('app/api/v1/runs/[id]/route.ts');
    expect(src, '对外调用面没有终止接口——派错的活只能等它跑完').toMatch(/export async function DELETE/);
    expect(src, '对外调用面不许有确认接口').not.toMatch(/decidePendingCall|confirm_run|actDecide/);
  });

  it('MCP 那三个方法里也没有确认', () => {
    const src = read('mcp-server.ts');
    expect(src).not.toMatch(/decidePendingCall|confirm_run/);
  });

  it('终止走的是同一个 cancelAgentRun（归属校验在它里面）', () => {
    const src = read('app/api/v1/runs/[id]/route.ts');
    expect(src, '另开了一套终止逻辑——两边的闸迟早各走各的').toMatch(/cancelAgentRun\(auth\.ctx, id\)/);
  });

  it('终止真的终止得了，且拿到别人的 runId 也动不了', async () => {
    const { cancelAgentRun } = await import('@/lib/agent/run');
    h.script = [{ text: '好' }];
    const t = await startAgentRun(ctx, '随便');
    // 【先 settle 再改状态】startAgentRun 的 kick 是异步的：不等它跑完就把状态改成 running，
    // 它可能在 cancel 之前把运行推到 done，于是 transition(LIVE→cancelled) 落空、用例间歇变红。
    // 这个形状本轮撞过三次，一律先 settle。
    await settleAgentKicks();
    await prisma.agentRun.update({ where: { id: t.runId }, data: { status: 'running' } });

    const otherWs = await prisma.workspace.create({ data: { tenantId: ctx.tenantId, name: 'W2' } });
    await expect(cancelAgentRun({ ...ctx, workspaceId: otherWs.id }, t.runId)).rejects.toThrow();
    expect((await prisma.agentRun.findUnique({ where: { id: t.runId } }))?.status).toBe('running');

    await cancelAgentRun(ctx, t.runId);
    expect((await prisma.agentRun.findUnique({ where: { id: t.runId } }))?.status).toBe('cancelled');
  });
});

describe('红点不该为一件我推不动的事亮起来', () => {
  it('点名给别人的通知，我这儿不计数也不列出来', async () => {
    const other = await prisma.member.create({ data: { tenantId: ctx.tenantId, name: '李四', role: 'editor' } });
    await notify({ workspaceId: ctx.workspaceId, kind: 'system', title: '人人可见的' });
    await notify({ workspaceId: ctx.workspaceId, kind: 'system', title: '只给我的', memberId: ctx.memberId });
    await notify({ workspaceId: ctx.workspaceId, kind: 'system', title: '只给同事的', memberId: other.id });

    expect(await unreadNotificationCount(ctx.workspaceId, ctx.memberId), '同事那条不该让我看到红点').toBe(2);
    expect(await unreadNotificationCount(ctx.workspaceId, other.id)).toBe(2);
    // 不传 memberId 时保持旧行为（全都数）
    expect(await unreadNotificationCount(ctx.workspaceId)).toBe(3);

    const mine = await listNotifications(ctx.workspaceId, 12, ctx.memberId);
    expect(mine.map((n) => n.title)).not.toContain('只给同事的');
  });

  it('AI 执行的通知点名给发起人（那几件只有他推得动）', async () => {
    h.script = [{ text: '做完了' }];
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();

    const note = await prisma.notification.findFirst({ where: { workspaceId: ctx.workspaceId } });
    expect(note?.memberId, 'AI 执行的通知没点名——同事会为一件自己做不了的事看到红点').toBe(ctx.memberId);
  });

  it('顶栏两处都按人过滤（红点与列表对不上会更奇怪）', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'components/Topbar.tsx'), 'utf8');
    expect(src).toMatch(/unreadNotificationCount\(session\.workspaceId, session\.memberId\)/);
    expect(src).toMatch(/listNotifications\(session\.workspaceId, 12, session\.memberId\)/);
  });
});
