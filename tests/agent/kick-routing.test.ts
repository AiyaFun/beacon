import { describe, it, expect, beforeEach, vi } from 'vitest';

// 「踢一脚」的分流：生产走队列给 worker，本机/整机版在自己进程里脱离请求继续跑。
//
// 【为什么值得单独钉一条】这是整个异步化**最容易被悄悄改回去**的一处。
// 顺手写成 `await getQueue().enqueue(...)` 看起来更统一、也能跑通全部用例——
// 但进程内队列的 enqueue 是同步 await 的（lib/jobs/queue.ts 的 InProcessQueue），
// 那一行等于把执行原地跑完：整机版和开发态又回到「关掉页面就掐断」，
// 而且**没有任何用例会红**，因为最终状态完全一样。所以这里断言的是「怎么跑的」。

const h = vi.hoisted(() => ({
  kind: 'inprocess' as 'inprocess' | 'bullmq',
  enqueued: [] as { name: string; payload: unknown }[],
  looped: [] as string[],
  loopBlocker: null as Promise<void> | null,
}));

vi.mock('@/lib/jobs/queue', () => ({
  getQueue: () => ({
    kind: h.kind,
    enqueue: async (name: string, payload: unknown) => {
      h.enqueued.push({ name, payload });
    },
  }),
}));

vi.mock('@/lib/agent/run', () => ({
  runAgentLoop: async (runId: string) => {
    h.looped.push(runId);
    if (h.loopBlocker) await h.loopBlocker;
  },
}));

const { kickAgentRun, settleAgentKicks } = await import('@/lib/agent/kick');

beforeEach(() => {
  h.enqueued = [];
  h.looped = [];
  h.loopBlocker = null;
});

describe('生产（bullmq）：投递给独立 worker', () => {
  it('入队一条 run_agent_loop，且**不在本进程里跑**', async () => {
    h.kind = 'bullmq';
    kickAgentRun('run-1');
    await settleAgentKicks();

    expect(h.enqueued).toEqual([{ name: 'run_agent_loop', payload: { runId: 'run-1' } }]);
    expect(h.looped, 'web 进程不该自己跑起来——那是 worker 的活').toEqual([]);
  });
});

describe('进程内（整机版 / 开发态 / 测试）：脱离请求继续跑', () => {
  it('直接跑循环，**绝不走队列的 enqueue**（那是同步的，等于没改）', async () => {
    h.kind = 'inprocess';
    kickAgentRun('run-2');
    await settleAgentKicks();

    expect(h.looped).toEqual(['run-2']);
    expect(h.enqueued, '进程内队列的 enqueue 是同步 await 的，走它等于原地跑完').toEqual([]);
  });

  it('踢完立刻返回，等它跑完是 settleAgentKicks 的事', async () => {
    h.kind = 'inprocess';
    let release = () => {};
    h.loopBlocker = new Promise<void>((r) => { release = r; });

    kickAgentRun('run-4');
    // 调用方这一刻就拿回了控制权：循环还堵在 blocker 上，而这里一行 await 都没有。
    // 【别改成「立刻断言 looped 有值」】踢一脚里有一次动态 import，那是真正的异步边界，
    // 断言微任务轮数是在测 Node 的调度而不是测这段代码
    expect(h.looped, '踢的那一刻循环还没来得及开始，这正是它没有阻塞调用方的证据').toEqual([]);

    // 必须在 settle 之前放行，否则 settle 会一直等这个永远不完成的任务
    setTimeout(release, 0);
    await settleAgentKicks();
    expect(h.looped, 'settleAgentKicks 才是那个等它跑完的人').toEqual(['run-4']);
  });

  it('循环炸了不会变成没人接的 unhandledRejection', async () => {
    h.kind = 'inprocess';
    // 延迟拒绝：立刻构造一个已拒绝的 Promise 会在挂上处理器之前先触发一次 unhandledRejection，
    // 那是这条用例自己制造的噪音，不是被测代码的问题
    h.loopBlocker = new Promise<void>((_, rej) => setTimeout(() => rej(new Error('模拟：循环里炸了')), 0));

    // 不抛给调用方（它是「踢一脚」，不是「跑一次」）
    expect(() => kickAgentRun('run-5')).not.toThrow();
    await expect(settleAgentKicks()).resolves.toBeUndefined();
  });
});

describe('踢空 id 是无操作', () => {
  it('不入队也不开跑', async () => {
    h.kind = 'bullmq';
    kickAgentRun('');
    await settleAgentKicks();
    expect(h.enqueued).toEqual([]);
    expect(h.looped).toEqual([]);
  });
});
