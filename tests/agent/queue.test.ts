import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 批 1 的两组守卫：排队语义 与 「跑完了叫我一声」。
//
// 共同的形状是**它们走反了都不会报错**：
//   并发闸数错了状态 → 要么死锁（谁都跑不了）要么形同虚设（十条一起烧额度）；
//   提拔漏了触发点   → 排队的运行永远轮不上，而界面上它一直显示「在排队」；
//   通知去重键错了   → 要么刷屏要么静默，两种都只有用户会发现。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  /** 卡住模型调用：用来把运行按在 running 上，好腾出手来验并发闸 */
  hold: null as null | Promise<void>,
  calls: 0,
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    h.calls++;
    if (h.hold) await h.hold;
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, transition, cancelAgentRun, getAgentRunView } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { MAX_CONCURRENT_RUNS, MAX_QUEUED_RUNS, decideQueue, promoteQueued } = await import('@/lib/agent/queue');
const { notifyRefId, notifyRunStatus } = await import('@/lib/agent/notify-run');
const { tickAgentRuns, cancelStaleQueued } = await import('@/lib/agent/tick');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.script = [];
  h.hold = null;
  h.calls = 0;
  await prisma.notification.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

/** 直接造一条指定状态的运行（不经模型），用来把并发位占满 */
async function seedRun(status: string, extra: Record<string, unknown> = {}) {
  return prisma.agentRun.create({
    data: {
      workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
      goal: `占位 ${status}`, status, messages: '[]', ...extra,
    },
  });
}

describe('并发闸：上限只数 running', () => {
  it('位子没满就直接跑', async () => {
    const d = await decideQueue(ctx.workspaceId);
    expect(d.status).toBe('running');
  });

  it('running 满了就排队', async () => {
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) await seedRun('running');
    const d = await decideQueue(ctx.workspaceId);
    expect(d.status).toBe('queued');
    expect(d.queuePosition).toBe(1);
  });

  // 【这条守的是死锁】挂起态（等确认/等插件/等额度）**不占名额**。
  // 数它们的话：三个运行都停在「等你确认」，用户想再派一个却被拦住，
  // 而他要确认的那三个恰恰要他先腾出手来——两边互相等，谁也动不了。
  it('等确认/等插件/等额度的都不占名额，否则会死锁', async () => {
    await seedRun('awaiting_confirm');
    await seedRun('waiting_browser');
    await seedRun('waiting_quota');
    const d = await decideQueue(ctx.workspaceId);
    expect(d.status).toBe('running');
  });

  it('已经有人排队时，新来的一律排到队尾（不许插队）', async () => {
    await seedRun('queued');
    // 这一刻一个 running 都没有，位子是空的——但先来的还排着，不能让后到的先跑
    const d = await decideQueue(ctx.workspaceId);
    expect(d.status).toBe('queued');
    expect(d.queuePosition).toBe(2);
  });

  it('队排满了当场拒绝，而不是继续收', async () => {
    for (let i = 0; i < MAX_QUEUED_RUNS; i++) await seedRun('queued');
    await expect(decideQueue(ctx.workspaceId)).rejects.toThrow(/排队/);
  });

  it('并发闸按工作区算，不会误伤别的工作区', async () => {
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) await seedRun('running');
    const other = await prisma.workspace.create({ data: { tenantId: ctx.tenantId, name: 'W2' } });
    expect((await decideQueue(other.id)).status).toBe('running');
  });

  it('派活时真的会排队：位子满了新运行建成 queued 且不开跑', async () => {
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) await seedRun('running');
    const before = h.calls;
    const turn = await startAgentRun(ctx, '我也要跑');
    await settleAgentKicks();

    expect(turn.status).toBe('queued');
    expect(h.calls, '排队中的运行一次模型都不该调').toBe(before);
    // 界面上要说清楚是在排队、排第几位，而不是一个不动的「进行中」
    const view = await getAgentRunView(ctx, turn.runId);
    expect(view.waitingFor).toMatch(/排/);
  });
});

describe('提拔：位子空出来就叫下一个', () => {
  it('一个运行跑完 → 排队最久的那个自动开跑，而且一次只放一个', async () => {
    const runners = [];
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) runners.push(await seedRun('running'));
    const first = await seedRun('queued');
    await new Promise((r) => setTimeout(r, 5)); // 拉开 createdAt，好验「先来先到」
    const second = await seedRun('queued');

    // 【为什么要把被提拔的那个卡在模型调用里】不卡的话它一瞬间就跑完了，
    // 于是又腾出一个位子、第二个也被提拔——那是**正确行为**，但这条用例想验的是
    // 「一次让位只放一个」，得让第一个占着位子不动才看得出来。
    let release!: () => void;
    h.hold = new Promise<void>((r) => { release = r; });
    h.script = [{ text: '我跑完了' }, { text: '轮到我了' }];

    // 让位：走 transition（提拔就挂在它上面）
    await transition(runners[0].id, 'running', 'done', { answer: 'ok' });
    await new Promise((r) => setTimeout(r, 60)); // 等 kick 把它推进到模型调用那一步

    expect((await prisma.agentRun.findUnique({ where: { id: first.id } }))?.status, '排最久的先上').toBe('running');
    expect((await prisma.agentRun.findUnique({ where: { id: second.id } }))?.status, '一次只提拔一个').toBe('queued');

    release();
    await settleAgentKicks();
  });

  it('停下来等确认也算让位（它不再占用「正在跑」的名额）', async () => {
    const runners = [];
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) runners.push(await seedRun('running'));
    const queued = await seedRun('queued');

    h.script = [{ text: '轮到我了' }];
    await transition(runners[0].id, 'running', 'awaiting_confirm', { pending: '{}' });
    await settleAgentKicks();

    expect((await prisma.agentRun.findUnique({ where: { id: queued.id } }))?.status).not.toBe('queued');
  });

  // 【这条守的是「别把没腾出的位子当腾出了」】queued→cancelled 不该触发提拔：
  // 那条运行本来就没在跑，跟着提拔会让并发悄悄超过上限。
  it('取消一条排队中的不算让位，并发不许因此超上限', async () => {
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) await seedRun('running');
    const a = await seedRun('queued');
    const b = await seedRun('queued');

    await transition(a.id, 'queued', 'cancelled');
    await settleAgentKicks();

    expect((await prisma.agentRun.findUnique({ where: { id: b.id } }))?.status).toBe('queued');
    expect(await prisma.agentRun.count({ where: { workspaceId: ctx.workspaceId, status: 'running' } }))
      .toBe(MAX_CONCURRENT_RUNS);
  });

  it('位子还满着就不提拔', async () => {
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) await seedRun('running');
    await seedRun('queued');
    expect(await promoteQueued(ctx.workspaceId)).toBeNull();
  });

  // 进程被杀时不会发生任何状态迁移，挂在 transition 上的提拔那一刻不存在——
  // 定时巡检是这条链路唯一的兜底
  it('定时巡检会把没人叫的队伍往前挪', async () => {
    const queued = await seedRun('queued'); // 一个 running 都没有，纯粹是没人叫它
    h.script = [{ text: '终于轮到我' }];
    const r = await tickAgentRuns();
    await settleAgentKicks();

    expect(r.promoted).toBe(1);
    expect((await prisma.agentRun.findUnique({ where: { id: queued.id } }))?.status).toBe('done');
  });

  it('排太久没轮上的会被自动取消并告诉用户（queued 不是终态，到期清理碰不到它）', async () => {
    const old = new Date(Date.now() - 8 * 86_400_000);
    const stale = await seedRun('queued', { createdAt: old });
    const fresh = await seedRun('queued');

    const n = await cancelStaleQueued();
    expect(n).toBe(1);
    expect((await prisma.agentRun.findUnique({ where: { id: stale.id } }))?.status).toBe('cancelled');
    expect((await prisma.agentRun.findUnique({ where: { id: fresh.id } }))?.status).toBe('queued');
    // 系统替他取消的，必须说一声——否则他在等一个永远不会跑的任务
    expect(await prisma.notification.count({ where: { refId: notifyRefId(stale.id, 'cancelled', 0) } })).toBe(1);
  });
});

describe('跑完了叫我一声', () => {
  it('跑完 / 失败 / 等你确认 / 等插件 / 等额度，各发一条通知', async () => {
    for (const status of ['done', 'failed', 'awaiting_confirm', 'waiting_browser', 'waiting_quota'] as const) {
      await prisma.notification.deleteMany();
      const run = await seedRun('running');
      await transition(run.id, 'running', status, { error: '出错了', answer: '做完了' });
      const n = await prisma.notification.count({ where: { refId: notifyRefId(run.id, status, 0) } });
      expect(n, `${status} 应该发一条通知`).toBe(1);
    }
  });

  it('正常推进（开跑、排队）不吵人', async () => {
    const run = await seedRun('queued');
    await transition(run.id, 'queued', 'running');
    expect(await prisma.notification.count()).toBe(0);
  });

  it('用户自己点的终止不发通知（他当然知道）', async () => {
    const run = await seedRun('running');
    await cancelAgentRun(ctx, run.id);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('同一段里同一个状态只叫一次：重复触发是常态（回执重投、自愈顺手也踢了一脚）', async () => {
    const run = await seedRun('running');
    await transition(run.id, 'running', 'waiting_browser');
    // 手工再迁一次（模拟重复触发）
    await transition(run.id, 'waiting_browser', 'running');
    await transition(run.id, 'running', 'waiting_browser');
    expect(await prisma.notification.count({ where: { refId: notifyRefId(run.id, 'waiting_browser', 0) } })).toBe(1);
  });

  // 【这条守的是去重键里的 episode】只按 (runId, status) 去重的话，
  // 追问续跑（同一条运行第二次跑完）那次会静默——而追问的人正是最想知道结果的那个。
  it('去重键带激活段：同一条运行第二段跑完要再叫一次', async () => {
    const run = await seedRun('running');
    await transition(run.id, 'running', 'done', { answer: '第一次' });
    expect(await prisma.notification.count()).toBe(1);

    // 模拟「追问 → 再跑一遍」：激活段 +1（批 3 会真的这么做）
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'running', episode: 1 } });
    await transition(run.id, 'running', 'done', { answer: '第二次' });

    expect(await prisma.notification.count(), '第二段跑完必须再通知一次').toBe(2);
    expect(await prisma.notification.count({ where: { refId: notifyRefId(run.id, 'done', 1) } })).toBe(1);
  });

  // ── 一次执行里可以确认很多次（2026-08-30 修）──────────────────────────────
  //
  // 【这条守的是去重键里的 occurrence】原来的键只到 (runId, status, episode)，
  // 而 **episode 只在「已结束的运行被追问续跑」时才 +1**。一次执行**里面**，
  // awaiting_confirm 完全可能出现很多次：确认一个写操作 → 接着跑 → 又撞上第二个。
  //（「建一份草稿 + 排一条发布计划」就是两个写操作，再普通不过。）
  //
  // 于是第二次之后的「等你确认」全部被静默吞掉，两条通道一起死：
  // 站内红点不出，群机器人回执也没了（echoRunToChat 拿 notifyRunStatus 的返回值当去重判据）。
  // 任务停在 awaiting_confirm，**没有任何人知道它在等谁**。
  it('🔒 同一段里第二次「等你确认」也要叫一次（否则任务静默卡死）', async () => {
    const run = await seedRun('running');
    // 第一次等确认（此时 steps=0）
    await transition(run.id, 'running', 'awaiting_confirm', { pending: '{"name":"create_draft"}' });
    expect(await prisma.notification.count()).toBe(1);

    // 用户确认 → 接着跑 → 又写了两行流水 → 撞上第二个写操作
    await transition(run.id, 'awaiting_confirm', 'running', {});
    await transition(run.id, 'running', 'awaiting_confirm', { pending: '{"name":"create_publish_plan"}', steps: 2 });

    expect(
      await prisma.notification.count(),
      '第二次等确认被去重键吞掉了——任务会停在那儿而没人知道',
    ).toBe(2);
  });

  it('🔒 但同一次确认被重复触发时仍然只叫一次（重投/自愈是常态）', async () => {
    const run = await seedRun('running');
    await transition(run.id, 'running', 'awaiting_confirm', { pending: '{}' });
    // 叫醒重投：状态已经不是 running，循环早退，流水位置不变 → 同一个 refId
    await notifyRunStatus(run.id, 'awaiting_confirm');
    await notifyRunStatus(run.id, 'awaiting_confirm');
    expect(await prisma.notification.count(), '同一次确认叫了不止一遍').toBe(1);
  });

  it('等确认的通知写明是在等谁，不用第二人称（同事点不动那个按钮）', async () => {
    const run = await seedRun('running');
    await transition(run.id, 'running', 'awaiting_confirm', { pending: '{}' });
    const note = await prisma.notification.findFirst({ where: { refId: notifyRefId(run.id, 'awaiting_confirm', 0, 0) } });
    expect(note?.title).toContain('张三');
    // 必须带 runId：不带的话点过去是空白助手页，那次运行再也找不回来
    expect(note?.link).toBe(`/assistant?run=${run.id}`);
  });

  it('通知发不出去绝不能影响执行本身', async () => {
    const spy = vi.spyOn(prisma.notification, 'count').mockRejectedValue(new Error('通知系统炸了'));
    const run = await seedRun('running');
    const ok = await transition(run.id, 'running', 'done', { answer: '照样做完' });
    spy.mockRestore();

    expect(ok).toBe(true);
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } }))?.status).toBe('done');
  });
});
