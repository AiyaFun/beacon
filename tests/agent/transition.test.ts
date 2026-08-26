import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// 批 0 的四条止血守卫。它们共同回答一件事：
// **一次运行永远要有一个用户看得见的结局，而且那个结局不会被后台线悄悄改写。**
//
// 四条对应四个此前真实存在的洞：
//   ① 配额超限时 loop 没有 catch → 运行永远停在 running（无终态、无错误、界面转圈到天荒地老）
//   ② 轮中点终止 → 剩下的分支照写 status，把 cancelled 盖成 done / awaiting_confirm
//   ③ 轮中点终止 → 剩下的工具照跑照写库（建草稿、烧额度）
//   ④ 等额度的运行直接 kick 是静默 no-op（三道闸都只认 running）
//
// 【为什么必须是行为断言】这几条用源码扫描都会假绿：把 catch 里的分支改成
// `if (false && ...)`，字符串还在、位置也还在，扫源码的守卫照过不误。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  /** 下一次模型调用要抛的错（模拟配额超限） */
  throwNext: null as { code?: string; scope?: string; message: string } | null,
  /** 模型调用发生时的回调：用例借它在「模型正在想」的那一刻插一脚（比如点终止） */
  onCall: null as null | (() => Promise<void>),
  calls: 0,
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    h.calls++;
    if (h.onCall) await h.onCall();
    if (h.throwNext) {
      const t = h.throwNext;
      h.throwNext = null;
      const err = new Error(t.message) as Error & { code?: string; scope?: string };
      err.code = t.code;
      err.scope = t.scope;
      throw err;
    }
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '',
      provider: 'scripted',
      model: 'scripted',
      mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));

vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView, cancelAgentRun, transition, resumeIfQuotaReset } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { AGENT_TOOLS } = await import('@/lib/agent/tools');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

function call(name: string, args: Record<string, unknown>, id = 'c1') {
  return { id, name, arguments: JSON.stringify(args) };
}

beforeEach(async () => {
  h.script = [];
  h.throwNext = null;
  h.onCall = null;
  h.calls = 0;
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.draft.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

describe('配额超限必须有可见结局', () => {
  it('日额度超限 → waiting_quota，并记下重置时刻（不是永远转圈的 running）', async () => {
    h.throwNext = { code: 'QUOTA_EXCEEDED', scope: 'daily', message: '今日 AI 调用额度已用尽（30 次/天），明日 0 点重置。' };
    const started = await startAgentRun(ctx, '干点什么');
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: started.runId } });
    expect(row?.status).toBe('waiting_quota');
    expect(row?.quotaResumeAt).toBeTruthy();
    expect(row?.quotaResumeAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row?.error).toContain('额度');
    // 租约要还回去，否则重置后没人接手得了它
    expect(row?.leaseUntil).toBeNull();

    // 界面要说清楚「你不用管它」——不然用户以为要自己做点什么
    const view = await getAgentRunView(ctx, started.runId);
    expect(view.waitingFor).toContain('自动接着跑');
  });

  it('月额度超限 → failed，不挂成僵尸等一个月', async () => {
    h.throwNext = { code: 'QUOTA_EXCEEDED', scope: 'monthly', message: '本月 AI 调用额度已用尽（300 次/月）。' };
    const started = await startAgentRun(ctx, '干点什么');
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: started.runId } });
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('本月');
    expect(row?.quotaResumeAt).toBeNull();
  });

  it('平台预算超限 → failed（那是全平台共享的池子，等 0 点只会一起再烧光一次）', async () => {
    h.throwNext = { code: 'QUOTA_EXCEEDED', scope: 'platform', message: '平台今日的模型预算已用尽，明日 0 点（北京时间）重置。' };
    const started = await startAgentRun(ctx, '干点什么');
    await settleAgentKicks();
    expect((await prisma.agentRun.findUnique({ where: { id: started.runId } }))?.status).toBe('failed');
  });

  it('模型调用炸了（非配额）→ failed 且如实带上错误，绝不留在 running', async () => {
    h.throwNext = { message: 'provider 连不上' };
    const started = await startAgentRun(ctx, '干点什么');
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: started.runId } });
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('provider');
  });
});

describe('等额度的运行怎么被叫醒', () => {
  it('到点了才翻回 running；没到点不动它', async () => {
    h.throwNext = { code: 'QUOTA_EXCEEDED', scope: 'daily', message: '今日额度用尽' };
    const started = await startAgentRun(ctx, '干点什么');
    await settleAgentKicks();
    expect((await prisma.agentRun.findUnique({ where: { id: started.runId } }))?.status).toBe('waiting_quota');

    // 还没到重置时刻：不许翻
    const future = new Date(Date.now() + 60 * 60_000);
    expect(await resumeIfQuotaReset(started.runId, future)).toBe(false);
    expect((await prisma.agentRun.findUnique({ where: { id: started.runId } }))?.status).toBe('waiting_quota');

    // 到点了：翻回 running 并接着跑（这次剧本给个答案让它收尾）
    h.script = [{ text: '接着跑完了' }];
    expect(await resumeIfQuotaReset(started.runId, new Date(Date.now() - 1000))).toBe(true);
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: started.runId } });
    expect(row?.status).toBe('done');
    expect(row?.answer).toContain('接着跑完了');
    expect(row?.quotaResumeAt).toBeNull();
  });

  // 【这条守的是「翻状态」这个动作本身】此前的写法是「到点直接 kick 一脚」，
  // 而 kick 链路上三道闸（claimLease / loop 开头 / contextForRun）全都只认 running，
  // 对一个 waiting_quota 的运行踢一脚是**静默无效**的——恰好复刻要修的那个悬死。
  it('只 kick 不翻状态是叫不醒的：等额度的运行必须先回到 running', async () => {
    h.throwNext = { code: 'QUOTA_EXCEEDED', scope: 'daily', message: '今日额度用尽' };
    const started = await startAgentRun(ctx, '干点什么');
    await settleAgentKicks();

    const { kickAgentRun } = await import('@/lib/agent/kick');
    h.script = [{ text: '不该跑到这里' }];
    const before = h.calls;
    kickAgentRun(started.runId); // 不翻状态，直接踢
    await settleAgentKicks();

    expect(h.calls).toBe(before); // 一次模型都没调到
    expect((await prisma.agentRun.findUnique({ where: { id: started.runId } }))?.status).toBe('waiting_quota');
  });

  it('waiting_quota 算「还活着」：终止得了它，权限重建也认它', async () => {
    h.throwNext = { code: 'QUOTA_EXCEEDED', scope: 'daily', message: '今日额度用尽' };
    const started = await startAgentRun(ctx, '干点什么');
    await settleAgentKicks();

    const turn = await cancelAgentRun(ctx, started.runId);
    expect(turn.status).toBe('cancelled');
    expect((await prisma.agentRun.findUnique({ where: { id: started.runId } }))?.quotaResumeAt).toBeNull();
  });
});

describe('取消不许被后台线复活', () => {
  // 【为什么在 onCall 里现查而不是用外面那个 runId 变量】
  // startAgentRun 里的 kick 是异步的：它可能在 `runId = started.runId` **赋值之前**
  // 就已经调到模型了，于是那一下取消根本没触发，用例间歇性变红。
  // 而一个偶尔红的守卫最坏的地方是——人会开始忽略它。
  async function cancelWhateverIsRunning() {
    const running = await prisma.agentRun.findFirst({ where: { status: 'running' } });
    if (running) await cancelAgentRun(ctx, running.id);
  }

  it('模型正在想的时候点终止 → 结局保持 cancelled，不会变成 done', async () => {
    h.onCall = cancelWhateverIsRunning; // 「模型思考中」用户点了终止
    h.script = [{ text: '我做完了' }]; // 模型回来想把它写成 done

    const started = await startAgentRun(ctx, '干点什么');
    const runId = started.runId;
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(row?.status).toBe('cancelled');
    expect(row?.answer).toBeNull(); // 连带答案也不该写进去
  });

  it('模型正在想的时候点终止 → 也不会变成「等你确认」', async () => {
    h.onCall = cancelWhateverIsRunning;
    // 模型回来要建草稿（写操作，正常会停成 awaiting_confirm）
    h.script = [{ toolCalls: [call('create_draft', { title: 'T', body: 'B' })] }];

    const started = await startAgentRun(ctx, '建个草稿');
    const runId = started.runId;
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: runId } });
    expect(row?.status).toBe('cancelled');
    expect(row?.pending).toBeNull();
  });

  it('一轮里连着几个工具，中途点终止 → 后面的工具不许再执行', async () => {
    let runId = '';
    let executed = 0;

    // 【为什么直接换掉工具的 run 而不是 spy prisma】
    // spy 到 Prisma 的方法上，mockRestore 之后那个方法就不再可用了（它是 client 代理出来的），
    // 于是**后面每一个用例**的记流水都会抛错——而抛错的运行会停在 running，
    // 表现成一个跟本用例毫无关系的诡异失败。工具对象是普通对象，换回来干干净净。
    const tool = AGENT_TOOLS.find((t) => t.name === 'list_topics')!;
    const origRun = tool.run;
    tool.run = async (c, a) => {
      executed++;
      if (executed === 1) await cancelAgentRun(ctx, runId); // 第一个工具跑的时候用户点了终止
      return origRun(c, a);
    };

    try {
      // 同一轮里连着三次调用。第一次跑完就取消，后两次必须不再跑。
      h.script = [{
        toolCalls: [
          call('list_topics', { limit: 1 }, 'a1'),
          call('list_topics', { limit: 2 }, 'a2'),
          call('list_topics', { limit: 3 }, 'a3'),
        ],
      }];
      const started = await startAgentRun(ctx, '查三样');
      runId = started.runId;
      await settleAgentKicks();
    } finally {
      tool.run = origRun;
    }

    expect(executed).toBe(1); // 只跑了第一个
    expect((await prisma.agentRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
  });
});

describe('状态迁移收口', () => {
  it('transition 是乐观锁：当前状态不是 from 就不写，并如实返回 false', async () => {
    const started = await startAgentRun(ctx, '随便');
    await settleAgentKicks();
    // 此刻已经是终态（剧本空 → 直接回答 → done）
    const row = await prisma.agentRun.findUnique({ where: { id: started.runId } });
    expect(row?.status).toBe('done');

    // 拿一个错的 from 去改：必须落空
    expect(await transition(started.runId, 'running', 'failed', { error: '不该写进去' })).toBe(false);
    const after = await prisma.agentRun.findUnique({ where: { id: started.runId } });
    expect(after?.status).toBe('done');
    expect(after?.error).toBeNull();
  });

  // 【源码守卫，配合上面的行为守卫一起看】行为守卫挡的是今天已知的几条路径，
  // 这条挡的是「明天有人新写一个分支时顺手 update status」——那种写法一次也不会报错，
  // 只会在某个并发窗口里悄悄把用户的终止盖掉。
  // 【文案↔代码的双向守卫】真机上抓到的：等额度那种挂起，界面照抄了给「等浏览器插件」
  // 写的那句尾巴「跑完会在通知里告诉你」——而 AI 执行**根本没有通知**（那是下一批的事）。
  // 用户于是关掉页面，去等一条永远不会来的通知。这正是本项目 08-13 审计过的复发形状。
  //
  // 守卫写成双向的：等真给 AI 执行接上通知之后（lib/agent 里出现 notify 调用），
  // 这条自己就放宽了，而且会当场提醒「现在可以把那句话加回去了」。
  it('没给 AI 执行接通知之前，界面不许承诺「跑完通知你」', () => {
    const agentDir = path.join(process.cwd(), 'lib/agent');
    const agentSrc = fs.readdirSync(agentDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(agentDir, f), 'utf8'))
      .join('\n');
    const hasNotify = /(^|[^.\w])notify\s*\(/m.test(agentSrc.replace(/^\s*\/\/.*$/gm, ''));

    // 先剥掉注释再扫：注释里解释这条规矩时也会写到那句话，扫原文会把讲解当成违规
    const panel = fs
      .readFileSync(path.join(process.cwd(), 'app/(app)/assistant/AgentPanel.tsx'), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const promises = panel.includes('通知里告诉你');

    if (hasNotify) {
      // 通知接上了：这条守卫完成使命，改成提醒把文案补回来
      expect(promises, 'lib/agent 已经会发通知了，AgentPanel 可以（也应该）把「跑完通知你」说回来').toBe(true);
      return;
    }
    // 还没接通知：那句话只能留给「等浏览器插件」（BrowserTask 自己有站内通知），
    // 且必须与 waiting_browser 写在同一个三元里，不许无条件印给所有挂起状态
    if (promises) {
      const line = panel.split('\n').find((l) => l.includes('通知里告诉你')) ?? '';
      expect(line, '「跑完通知你」只能出现在 waiting_browser 分支里').toContain('waiting_browser');
    }
  });

  // 【这条是 mutation 验证逼出来的】改完代码以为就有保障了，一跑 mutation 才发现
  // 「把配额原文当红字摆出来」根本没有任何用例会红——典型的假绿。
  it('等额度不是失败：配额原文不许在执行面板上当红字报错摆出来', () => {
    const panel = fs
      .readFileSync(path.join(process.cwd(), 'app/(app)/assistant/AgentPanel.tsx'), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const errLine = panel.split('\n').find((l) => /turn\.error\s*&&/.test(l)) ?? '';
    expect(errLine, 'error 的渲染条件里要排掉 waiting_quota：它存的是配额长文案，而这次运行并没有失败').toContain(
      "waiting_quota",
    );
  });

  it('lib/agent 下不许绕过 transition 直接写 status', () => {
    const dir = path.join(process.cwd(), 'lib/agent');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/prisma\.agentRun\.update(Many)?\s*\(([\s\S]{0,500}?)\}\s*\)/g)) {
        // 只看 data 那一段：where 里的 status 是**读条件**（乐观锁靠的就是它），不是写
        const data = m[2].match(/data\s*:\s*\{([\s\S]*)$/)?.[1] ?? '';
        if (!/\bstatus\s*:/.test(data)) continue;
        // transition 自己就是那个唯一的实现，它当然要写 status
        if (f === 'run.ts' && /status\s*:\s*to\b/.test(data)) continue;
        offenders.push(`${f}: ${m[0].slice(0, 90).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
