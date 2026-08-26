import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 批 3：跑着跑着再说一句话。
//
// 在此之前，一次执行是**一句话定终身**：派出去之后想补一句「顺便看看小红书那边」，
// 只能等它跑完、再重新派一次——而那次不知道前面查过什么，从零开始。
//
// 【三个消费点，缺一个就丢话，而且丢得无声无息】
//   ① 每轮开头           —— 正常情况
//   ② 转「等你确认」之前 —— 附言要跟着这次决定一起送进去
//   ③ 到终态之前         —— 「就快跑完时想起还有件事」，恰恰是最常见的追问时机

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  calls: [] as { messages: { role: string; content?: string }[] }[],
  onCall: null as null | (() => Promise<void>),
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: { role: string; content?: string }[]) => {
    h.calls.push({ messages });
    if (h.onCall) await h.onCall();
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView, appendUserNote, decidePendingCall, transition } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { appendNote, drainNotes, pendingNoteCount } = await import('@/lib/agent/notes');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
const call = (name: string, args: unknown, id = 'c1') => ({ id, name, arguments: JSON.stringify(args) });
/** 这一轮送给模型的消息里，有没有带上那句补充 */
const sawNote = (i: number, text: string) =>
  (h.calls[i]?.messages ?? []).some((m) => m.role === 'user' && (m.content ?? '').includes(text));

beforeEach(async () => {
  h.script = []; h.calls = []; h.onCall = null;
  await prisma.agentRunNote.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.notification.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

describe('附言是 insert-only 的，不会被并发写丢掉', () => {
  it('排干先标记再返回：标记失败就当没读到（宁可下轮再来，也不能送两遍）', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();

    await appendNote(turn.runId, '第一句');
    await appendNote(turn.runId, '第二句');
    expect(await pendingNoteCount(turn.runId)).toBe(2);

    const msgs = await drainNotes(turn.runId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toContain('第一句');
    // 排干之后就不该再有第二次
    expect(await pendingNoteCount(turn.runId)).toBe(0);
    expect(await drainNotes(turn.runId)).toHaveLength(0);
  });

  it('两条线同时排干，同一句话只会被送一次', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    await appendNote(turn.runId, '只说一次');

    const [a, b] = await Promise.all([drainNotes(turn.runId), drainNotes(turn.runId)]);
    expect(a.length + b.length, '同一句话被送了两遍').toBe(1);
  });

  it('送给模型时标明是「中途补充的」', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    await appendNote(turn.runId, '顺便看看小红书');
    const [m] = await drainNotes(turn.runId);
    // 不标的话模型会把它当成对上一条工具结果的回应，理解成「用户在纠正我刚才那一步」
    expect(m.content).toContain('用户补充');
  });

  it('空话不记（点了按钮但没打字）', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    await appendNote(turn.runId, '   ');
    expect(await pendingNoteCount(turn.runId)).toBe(0);
  });
});

describe('三个消费点', () => {
  it('①还在跑：下一轮就带上那句话', async () => {
    h.script = [
      { toolCalls: [call('list_topics', { limit: 1 })] },
      { text: '好的，我也看了小红书。' },
    ];
    // 第一轮模型调用发生时插一句话进去。
    // 【别用外面那个 runId】startAgentRun 的 kick 是异步的：它可能在
    // `runId = turn.runId` **赋值之前**就调到模型，那一下 appendNote 会被整个跳过，
    // 于是第二轮当然看不到那句话——用例间歇变红，而产品其实没坏。
    // 这个形状本轮撞过四次，一律改成「回调里现查当前在跑的那条」。
    h.onCall = async () => {
      if (h.calls.length !== 1) return;
      const live = await prisma.agentRun.findFirst({ where: { workspaceId: ctx.workspaceId, status: 'running' } });
      if (live) await appendNote(live.id, '顺便看看小红书');
    };
    const turn = await startAgentRun(ctx, '查选题');
    void turn;
    await settleAgentKicks();

    expect(sawNote(1, '顺便看看小红书'), '第二轮没带上中途那句话').toBe(true);
  });

  // 【这条守的是「正要弹确认卡」那一刻打的字】不排干的话它会一直悬着——
  // 用户看着确认卡，以为自己补充的要求已经被听到了。
  it('②停下来等确认之前先排干', async () => {
    h.script = [{ toolCalls: [call('create_draft', { title: 'T', platform: 'douyin' })] }, { text: '建好了' }];
    // 同①的理由：kick 是异步的，外层那个 runId 可能还没赋值，回调里现查
    h.onCall = async () => {
      if (h.calls.length !== 1) return;
      const live = await prisma.agentRun.findFirst({ where: { workspaceId: ctx.workspaceId, status: 'running' } });
      if (live) await appendNote(live.id, '标题要情绪化一点');
    };
    const turn = await startAgentRun(ctx, '建个草稿');
    const runId = turn.runId;
    await settleAgentKicks();

    expect((await getAgentRunView(ctx, runId)).status).toBe('awaiting_confirm');
    expect(await pendingNoteCount(runId), '停下来等确认时还有话没送达').toBe(0);
  });

  // 【最容易漏的一个】「就快跑完时想起还有件事」是最常见的追问时机，
  // 而那时模型已经把话说出口了——不在这里检查，那句话永远没人读。
  it('③它以为做完了，但用户刚又说了一句 → 不许收工，带着新要求再想一轮', async () => {
    h.script = [
      { text: '查完了，你有 2 条选题。' },
      { text: '小红书那边我也看了，另外补 3 条。' },
    ];
    // 同①的理由：kick 是异步的，外层那个 runId 可能还没赋值，回调里现查
    h.onCall = async () => {
      if (h.calls.length !== 1) return;
      const live = await prisma.agentRun.findFirst({ where: { workspaceId: ctx.workspaceId, status: 'running' } });
      if (live) await appendNote(live.id, '顺便看看小红书');
    };
    const turn = await startAgentRun(ctx, '查选题');
    const runId = turn.runId;
    await settleAgentKicks();

    const view = await getAgentRunView(ctx, runId);
    expect(view.status).toBe('done');
    expect(view.answer, '收工前那句补充被丢掉了').toContain('小红书');
    expect(sawNote(1, '顺便看看小红书')).toBe(true);
  });

  it('界面上要标出「还没送达」——用户打完字就以为生效了', async () => {
    const turn = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, turn.runId)).pendingNotes).toBeUndefined();

    await appendNote(turn.runId, '还没送到的一句');
    expect((await getAgentRunView(ctx, turn.runId)).pendingNotes).toBe(1);
  });
});

describe('跑完之后接着说一句：同一条运行继续', () => {
  async function runToDone(goal: string) {
    h.script = [{ text: '第一段做完了' }];
    const t = await startAgentRun(ctx, goal);
    await settleAgentKicks();
    return t.runId;
  }

  // 【为什么必须是同一条】新开一条的话，它不知道前面查过什么、建过什么草稿——
  // 用户说「刚才那篇标题再改改」，新运行只能从头再查一遍，还很可能得出不一样的结论。
  it('终态追问 = 同一条运行回到 running，不新开一条', async () => {
    const runId = await runToDone('第一段');
    const before = await prisma.agentRun.count();

    h.script = [{ text: '按你说的改好了' }];
    await appendUserNote(ctx, runId, '标题再改改');
    await settleAgentKicks();

    expect(await prisma.agentRun.count(), '不该新开一条运行').toBe(before);
    const row = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(row?.status).toBe('done');
    expect(row?.answer).toContain('按你说的改好了');
  });

  it('续跑保留原来的上下文（这才是「同一条」的意义）', async () => {
    const runId = await runToDone('查一下选题');
    h.calls = [];
    h.script = [{ text: '改好了' }];
    await appendUserNote(ctx, runId, '标题再改改');
    await settleAgentKicks();

    const msgs = h.calls[0]?.messages ?? [];
    // 第一段那句目标还在对话里
    expect(msgs.some((m) => (m.content ?? '').includes('查一下选题')), '续跑丢了原来的上下文').toBe(true);
    expect(msgs.some((m) => (m.content ?? '').includes('标题再改改'))).toBe(true);
  });

  it('续跑给新的一段预算，轮数重新算（否则它一睁眼就撞上「额度用完」）', async () => {
    const runId = await runToDone('第一段');
    const before = await prisma.agentRun.findUnique({ where: { id: runId }, select: { callBudget: true, rounds: true } });
    expect(before!.rounds).toBeGreaterThan(0);

    h.script = [{ text: '第二段' }];
    await appendUserNote(ctx, runId, '接着做');
    await settleAgentKicks();

    const after = await prisma.agentRun.findUnique({ where: { id: runId }, select: { callBudget: true, rounds: true } });
    expect(after!.callBudget, '预算没有追加').toBeGreaterThan(before!.callBudget);
  });

  // 【去重键里的 episode 就是为这个存在的】只按 (runId, status) 去重的话，
  // 第二次跑完不会通知——而追问的人正是最想知道「又跑完了」的那个。
  it('续跑让激活段 +1，于是「又跑完了」会再通知一次', async () => {
    const runId = await runToDone('第一段');
    expect(await prisma.notification.count()).toBe(1);

    h.script = [{ text: '第二段做完了' }];
    await appendUserNote(ctx, runId, '接着做');
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: runId }, select: { episode: true } });
    expect(row?.episode).toBe(1);
    expect(await prisma.notification.count(), '第二次跑完必须再通知一次').toBe(2);
  });

  it('失败的那条也能接着跑（「接着跑」同时是失败任务的重试入口）', async () => {
    h.script = [{ text: '不该跑到这里', toolCalls: undefined }];
    const t = await startAgentRun(ctx, '会失败的');
    await settleAgentKicks();
    await transition(t.runId, 'done', 'failed', { error: '假装失败了' });

    h.script = [{ text: '这次成了' }];
    await appendUserNote(ctx, t.runId, '再试一次');
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: t.runId } });
    expect(row?.status).toBe('done');
    expect(row?.error, '续跑成功后不该还挂着上次的错误').toBeNull();
  });

  it('还在跑的那条只记下来，不重复踢（那会让两条推理线写同一行）', async () => {
    const t = await startAgentRun(ctx, '随便');
    // 先把开跑那一波推完再清计数器：startAgentRun 的 kick 是异步的，
    // 不等它就清的话，它稍后调的那次模型会被算到「追问触发的」头上（假红）
    await settleAgentKicks();
    await prisma.agentRun.update({ where: { id: t.runId }, data: { status: 'running' } });
    h.calls = [];

    await appendUserNote(ctx, t.runId, '补一句');
    // 没有新的模型调用被触发——那句话在下一轮才会被读到
    expect(h.calls.length).toBe(0);
    expect(await pendingNoteCount(t.runId)).toBe(1);
  });
});

describe('只有发起人能追问', () => {
  // 与「只有发起人能确认」同一条理由：这次执行按他的权限跑，
  // 别人往里塞一句话就等于用他的权限做他没同意的事。
  it('换个人追问直接拒绝', async () => {
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    const other = await prisma.member.create({ data: { tenantId: ctx.tenantId, name: '李四', role: 'editor' } });

    await expect(appendUserNote({ ...ctx, memberId: other.id }, t.runId, '我也说一句'))
      .rejects.toThrow(/只有发起/);
    expect(await pendingNoteCount(t.runId)).toBe(0);
  });

  it('别的工作区的人连这条运行都看不到', async () => {
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    const otherWs = await prisma.workspace.create({ data: { tenantId: ctx.tenantId, name: 'W2' } });

    await expect(appendUserNote({ ...ctx, workspaceId: otherWs.id }, t.runId, '偷偷说一句'))
      .rejects.toThrow(/不存在/);
  });

  it('空话不记也不报错地吞掉——如实告诉用户', async () => {
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    await expect(appendUserNote(ctx, t.runId, '  ')).rejects.toThrow(/说点什么/);
  });
});

describe('界面上不摆「点了必定报错」的按钮', () => {
  // 同事的运行也看得见（从运行中心点进来），那是刻意的。但确认、追问、接着跑、终止
  // **只有发起人做得了**——服务端会拒。不告诉界面的话，同事看到的是一排必定报错的按钮，
  // 而 /runs 不放确认按钮防的正是这件事。
  it('AgentTurn 带上「是不是我发起的」，且按发起人算', async () => {
    const t = await startAgentRun(ctx, '我派的');
    await settleAgentKicks();

    expect((await getAgentRunView(ctx, t.runId)).mine).toBe(true);
    const other = await prisma.member.create({ data: { tenantId: ctx.tenantId, name: '李四', role: 'editor' } });
    expect((await getAgentRunView({ ...ctx, memberId: other.id }, t.runId)).mine).toBe(false);
  });

  it('执行面板的确认卡、三出口、终止都按它渲染', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/(app)/assistant/AgentPanel.tsx'), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src, '确认卡没按发起人分开').toMatch(/turn\.pending && turn\.mine/);
    expect(src, '「接着跑」那一栏没判发起人').toMatch(/ENDED\.includes\(turn\.status\) && turn\.mine/);
    expect(src, '终止按钮没判发起人').toMatch(/turn\.mine && \(turn\.status === 'awaiting_confirm'/);
    // 不是发起人时要说清楚为什么推不动，而不是什么都不显示
    expect(src, '同事那边没有任何说明').toMatch(/不是你派的/);
    // 徽章也要跟着换人称：「等你确认」对推不动它的人是句错话，而徽章比说明先入眼
    expect(src, '徽章没按发起人换人称').toMatch(/status === 'awaiting_confirm' && mine === false/);
    expect(src).toMatch(/等发起人确认/);
  });
});

describe('新表的生命周期（导出 / 注销 / 到期清理）', () => {
  it('运行记录被删时附言跟着走，不留孤儿', async () => {
    const t = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    await appendNote(t.runId, '一句话');
    expect(await prisma.agentRunNote.count()).toBe(1);

    await prisma.agentRun.delete({ where: { id: t.runId } });
    expect(await prisma.agentRunNote.count(), '附言单独留着没有任何意义，且会变成永久孤儿').toBe(0);
  });

  it('两份 schema 与生产迁移 SQL 都有这张表，且 RLS 补了策略', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(read(f), `${f} 少了 AgentRunNote`).toMatch(/model AgentRunNote/);
    }
    const sql = read('prisma/postgres/26-agent-note.sql');
    expect(sql, '生产迁移没建这张表').toMatch(/CREATE TABLE IF NOT EXISTS "AgentRunNote"/);
    // 【生产靠的是这份 SQL，不是 schema.prisma】级联写在这里才算数：
    // 漏了的话运行记录到期清理会撞 FK 报错，或者留下一堆永远没人读的孤儿附言
    // 【这份 SQL 里有两张表挂在 AgentRun 上】只断「出现过一次」的话，
    // 另一张漏掉 CASCADE 照样绿——而漏掉的后果是删运行时留下一堆孤儿行。
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1]);
    const cascades = (sql.match(/REFERENCES "AgentRun"\("id"\) ON DELETE CASCADE/g) ?? []).length;
    expect(tables.length, '一张表都没扫到，正则大概坏了').toBeGreaterThanOrEqual(2);
    expect(cascades, `${tables.join('、')} 里有表的外键没写 ON DELETE CASCADE`).toBe(tables.length);
    // 两份 schema 里也要是 Cascade（本地开发与整机版走的是它）
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const block = read(f).match(/model AgentRunNote \{[\s\S]*?\n\}/)?.[0] ?? '';
      expect(block, `${f} 的 AgentRunNote 没写 onDelete: Cascade`).toMatch(/onDelete: Cascade/);
    }
    // 【建了新表必须补 RLS】不补的话这张表对所有租户都是敞开的
    expect(read('prisma/postgres/02-rls.sql'), 'RLS 漏了新表').toMatch(/tenant_isolation ON "AgentRunNote"/);
  });
});
