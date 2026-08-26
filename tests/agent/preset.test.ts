import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// 批 5：一键任务与定时派发。
//
// 【为什么值得单独存一张卡】派活现在要打一段字、选一个智能体、勾一次授权范围，
// 而绝大多数人反复要的就是那么三五件事。每次重打不只是麻烦——
// **授权范围每次都要重勾，勾错了没人拦得住**。
//
// 它同时是定时的载体：到点了派一条预设任务 = 无人值守的 AI 任务。
// 而那条路上有一个必须重做的东西：**连败自停闸**——它原来靠同步返回值记账，
// 而异步派发那一刻拿不到结局。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
}));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { transition, getAgentRunView } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { dispatchPreset, reportScheduleOutcome } = await import('@/lib/agent/preset');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.script = [];
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.scheduledAgent.deleteMany();
  await prisma.taskPreset.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  await prisma.notification.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

async function makePreset(p: Partial<{
  title: string; goal: string; agentTemplateId: string | null; authMode: string; preauthorizedTools: string[]; enabled: boolean;
}> = {}) {
  return prisma.taskPreset.create({
    data: {
      tenantId: ctx.tenantId, workspaceId: ctx.workspaceId,
      title: p.title ?? '看数据给建议',
      goal: p.goal ?? '看看我最近的作品数据',
      agentTemplateId: p.agentTemplateId ?? null,
      authMode: p.authMode ?? 'confirm_each',
      preauthorizedTools: JSON.stringify(p.preauthorizedTools ?? []),
      enabled: p.enabled ?? true,
    },
  });
}

describe('派一条一键任务', () => {
  it('把卡上定好的目标与授权原样带进这次执行', async () => {
    const p = await makePreset({ authMode: 'preauthorized', preauthorizedTools: ['create_draft'] });
    h.script = [{ text: '看完了' }];
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'preset' });
    await settleAgentKicks();

    expect(r.ok).toBe(true);
    const row = await prisma.agentRun.findUnique({ where: { id: (r as { turn: { runId: string } }).turn.runId } });
    expect(row?.goal).toBe('看看我最近的作品数据');
    expect(row?.authMode).toBe('preauthorized');
    expect(JSON.parse(row!.preauthorizedTools)).toEqual(['create_draft']);
    expect(row?.origin).toBe('preset');
  });

  it('这次临时改一改目标，不动到那张卡本身', async () => {
    const p = await makePreset();
    h.script = [{ text: '好' }];
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'preset', goalOverride: '这次只看小红书' });
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: (r as { turn: { runId: string } }).turn.runId } });
    expect(row?.goal).toBe('这次只看小红书');
    expect((await prisma.taskPreset.findUnique({ where: { id: p.id } }))?.goal).toBe('看看我最近的作品数据');
  });

  it('停用的卡派不动；别的工作区的卡看不见', async () => {
    const off = await makePreset({ enabled: false });
    expect(await dispatchPreset(ctx, { presetId: off.id, origin: 'preset' })).toMatchObject({ ok: false });

    const otherWs = await prisma.workspace.create({ data: { tenantId: ctx.tenantId, name: 'W2' } });
    const p = await makePreset();
    const r = await dispatchPreset({ ...ctx, workspaceId: otherWs.id }, { presetId: p.id, origin: 'preset' });
    expect(r).toMatchObject({ ok: false });
  });

  // 【为什么不悄悄退回通用助手】用户配这张卡时选的就是那个智能体，
  // 换一个来跑不是他要的——而且他不会知道换过。
  it('卡上指的智能体没了 → 如实报错，不悄悄换一个来跑', async () => {
    const p = await makePreset({ agentTemplateId: '已经不存在的模板id' });
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'preset' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/不在了|不存在/);
    expect(await prisma.agentRun.count(), '不该退回通用助手偷偷跑一次').toBe(0);
  });

  it('指了自主智能体：人设、白名单、预算都按它的配置来', async () => {
    const tpl = await prisma.workflowTemplate.create({
      data: {
        tenantId: ctx.tenantId, slug: 'p-auto', name: '看数据的', emoji: '📊', enabled: true,
        mode: 'autonomous', steps: '[]',
        agentConfig: JSON.stringify({ systemPrompt: '你只看数据不写稿', tools: ['list_topics'], callBudget: 5 }),
      },
    });
    const p = await makePreset({ agentTemplateId: tpl.id });
    h.script = [{ text: '看完了' }];
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'preset' });
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: (r as { turn: { runId: string } }).turn.runId } });
    expect(row?.agentTemplateId).toBe(tpl.id);
    expect(row?.callBudget).toBe(5);
    expect(row?.messages).toContain('你只看数据不写稿');
    // 白名单收窄真的生效了
    expect(row?.messages).toContain('list_topics');
    expect(row?.messages, '白名单外的工具不该出现在这次执行里').not.toContain('create_draft(');
  });

  // 页面上点一下的时候人就在跟前，没有理由不问他。
  // 真要无人值守，去给这张卡挂一条定时（那边按 origin='schedule' 放行）。
  it('页面上派的一键任务不许用无人值守', async () => {
    const p = await makePreset({ authMode: 'unattended' });
    h.script = [{ text: '好' }];
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'preset' });
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: (r as { turn: { runId: string } }).turn.runId } });
    expect(row?.authMode).toBe('confirm_each');
  });

  it('同一张卡挂定时派出去时，无人值守才生效', async () => {
    const p = await makePreset({ authMode: 'unattended' });
    h.script = [{ text: '好' }];
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'schedule' });
    await settleAgentKicks();

    const row = await prisma.agentRun.findUnique({ where: { id: (r as { turn: { runId: string } }).turn.runId } });
    expect(row?.authMode).toBe('unattended');
  });
});

describe('连败自停闸：异步派发也要记得住成败', () => {
  // 【这条是这一批最容易漏的】闸原来靠 `await runWorkflow` 的同步返回值记账，
  // 而派一条 AI 执行是异步的——派发那一刻它还没跑。照抄旧写法的话 failStreak 永远不累加，
  // **一条配坏的定时会每天准点烧配额且永不自动停用**（那正是这道闸存在的理由）。
  async function makeSchedule(failStreak = 0) {
    return prisma.scheduledAgent.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, createdBy: ctx.memberId,
        targetKind: 'task', taskPresetId: null, templateId: null,
        atHour: 9, atMinute: 0, weekdays: '[]', enabled: true, failStreak,
      },
    });
  }

  /**
   * 造一条「定时派出来的、正在跑」的运行。
   *
   * 【为什么不走 dispatchPreset + settleAgentKicks】那样它会一路跑到 done，
   * 回写在我手工 transition **之前**就发生了（还把连败清零了）——
   * 要验的是「到终态时回写对不对」，得让运行停在我手上。
   */
  async function runningRun(scheduleId: string) {
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId,
        goal: '定时派的', status: 'running', messages: '[]', origin: 'schedule',
        scheduledAgentId: scheduleId,
      },
    });
    return run.id;
  }

  it('跑成了 → 连败清零、记 done', async () => {
    const sa = await makeSchedule(2);
    const runId = await runningRun(sa.id);
    await transition(runId, 'running', 'done', { answer: '看完了' });

    const after = await prisma.scheduledAgent.findUnique({ where: { id: sa.id } });
    expect(after?.lastStatus).toBe('done');
    expect(after?.failStreak, '跑成了要把连败清零').toBe(0);
  });

  it('端到端：定时派一条一键任务，运行上记着是哪条定时派的', async () => {
    const sa = await makeSchedule(0);
    const p = await makePreset();
    h.script = [{ text: '跑完了' }];
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'schedule', scheduledAgentId: sa.id });
    await settleAgentKicks();

    const runId = (r as { turn: { runId: string } }).turn.runId;
    expect(await prisma.agentRun.findUnique({ where: { id: runId }, select: { scheduledAgentId: true } }))
      .toMatchObject({ scheduledAgentId: sa.id });
    // 跑完之后回写也真的发生了
    expect((await prisma.scheduledAgent.findUnique({ where: { id: sa.id } }))?.lastStatus).toBe('done');
  });

  it('跑失败 → 连败 +1', async () => {
    const sa = await makeSchedule(0);
    const runId = await runningRun(sa.id);
    await transition(runId, 'running', 'failed', { error: '模型连不上' });

    const after = await prisma.scheduledAgent.findUnique({ where: { id: sa.id } });
    expect(after?.failStreak).toBe(1);
    expect(after?.lastStatus).toBe('failed');
    expect(after?.lastError).toContain('模型连不上');
  });

  it('连败到上限 → 自动停用并告警', async () => {
    const { AUTO_PAUSE_FAILS } = await import('@/lib/workflow/schedule');
    const sa = await makeSchedule(AUTO_PAUSE_FAILS - 1);
    const runId = await runningRun(sa.id);
    await transition(runId, 'running', 'failed', { error: '又挂了' });

    const after = await prisma.scheduledAgent.findUnique({ where: { id: sa.id } });
    expect(after?.enabled, '连败到上限了却没自动停用——这条定时会每天接着烧配额').toBe(false);
    // 停用要说一声：不说的话用户以为它还在跑
    expect(await prisma.notification.count({ where: { refId: sa.id } })).toBeGreaterThanOrEqual(1);
  });

  // 【额度用完不算「坏」】与流水线那边同一个口径：配额超限是「今天没轮到」，
  // 不是「这条计划配错了」。累加会把一条好计划在三个额度紧张的日子后停掉。
  it('额度用完不累加连败', async () => {
    const sa = await makeSchedule(1);
    const runId = await runningRun(sa.id);
    await transition(runId, 'running', 'failed', { error: '今日 AI 调用额度已用尽（30 次/天）' });

    const after = await prisma.scheduledAgent.findUnique({ where: { id: sa.id } });
    expect(after?.failStreak, '额度不足被当成「这条计划坏了」').toBe(0);
    expect(after?.lastStatus).toBe('skipped');
  });

  it('不是定时派的运行，回写时安静跳过', async () => {
    const p = await makePreset();
    h.script = [{ text: '好' }];
    const r = await dispatchPreset(ctx, { presetId: p.id, origin: 'preset' });
    await settleAgentKicks();
    await expect(reportScheduleOutcome((r as { turn: { runId: string } }).turn.runId)).resolves.toBeUndefined();
  });
});

describe('定时能指两种东西', () => {
  // 【行为验，不是扫字符串】早先这条只断言源码里出现过 `targetKind === 'task'`，
  // 而那个字符串在同一文件的 nameOf 里也有一份——把真正的分派整个删掉照样绿。
  it('到点了：task 型定时派的是 AI 执行，不是工作流', async () => {
    const { tickScheduledAgents } = await import('@/lib/workflow/schedule');
    const p = await makePreset();
    // 造一条「现在就该跑」的定时（tick 用北京时间的时分判窗口）
    const { beijingParts } = await import('@/lib/beijing');
    const now = new Date();
    const bp = beijingParts(now);
    await prisma.scheduledAgent.create({
      data: {
        workspaceId: ctx.workspaceId, accountId: ctx.accountId, createdBy: ctx.memberId,
        targetKind: 'task', taskPresetId: p.id, templateId: null,
        atHour: bp.hour, atMinute: Math.floor(bp.minute / 10) * 10,
        weekdays: '[]', enabled: true,
      },
    });

    h.script = [{ text: '跑完了' }];
    await tickScheduledAgents(now, 10);
    await settleAgentKicks();

    expect(await prisma.agentRun.count(), '定时没派出 AI 执行').toBeGreaterThanOrEqual(1);
    expect(await prisma.workflowRun.count(), 'task 型定时不该去跑工作流').toBe(0);
    const run = await prisma.agentRun.findFirst();
    expect(run?.origin).toBe('schedule');
    expect(run?.goal).toBe('看看我最近的作品数据');
  });

  it('派发那一刻不记成功——它才刚开始跑', () => {
    // 记 done 的话，一条每次都跑失败的定时会永远显示「上次跑成功了」
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/workflow/schedule.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const taskBranch = src.slice(src.indexOf("r.targetKind === 'task'"), src.indexOf('if (!r.templateId)'));
    expect(taskBranch, '没扫到 task 分支，正则大概坏了').toContain('dispatchPreset');
    expect(taskBranch, '派发那一刻就记成功了——它还没跑完').not.toMatch(/lastStatus: 'done'/);
  });

  it('卡片保存时不许存无人值守（那只对挂了定时的有意义）', () => {
    // 【为什么在保存那一层也拦】startAgentRun 里那道闸已经会把它打回 confirm_each，
    // 但卡上存着一个「无人值守」而实际从不生效，用户会以为自己配好了。
    // 要无人值守就去挂定时——那条路会如实按 origin='schedule' 放行。
    const src = fs.readFileSync(path.join(process.cwd(), 'app/(app)/workflows/preset-actions.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, '保存时没把授权档收成两种').toMatch(/=== 'preauthorized' \? 'preauthorized' : 'confirm_each'/);
  });

  it('两种指向都要有名字，被删了要如实说', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/workflow/schedule-format.ts'), 'utf8');
    expect(src).toMatch(/scheduleTargetLabel/);
    // 三处显示（设置页、跑动记录、喂给模型的 list_schedules）共用一份，
    // 各写各的迟早对不上
    for (const f of ['app/(app)/workflows/page.tsx', 'lib/agent/tools.ts']) {
      expect(fs.readFileSync(path.join(process.cwd(), f), 'utf8'), `${f} 没用统一的那份`)
        .toMatch(/scheduleTargetLabel/);
    }
  });
});

describe('新表的生命周期', () => {
  it('工作区删了，卡跟着走', async () => {
    const ws = await prisma.workspace.create({ data: { tenantId: ctx.tenantId, name: 'WX' } });
    await prisma.taskPreset.create({
      data: { tenantId: ctx.tenantId, workspaceId: ws.id, title: 'x', goal: 'y' },
    });
    await prisma.workspace.delete({ where: { id: ws.id } });
    expect(await prisma.taskPreset.count({ where: { workspaceId: ws.id } })).toBe(0);
  });

  it('两份 schema、生产迁移、RLS 三处都有', () => {
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(read(f), `${f} 少了 TaskPreset`).toMatch(/model TaskPreset/);
    }
    const sql = read('prisma/postgres/28-task-preset.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "TaskPreset"/);
    // 定时那三处改动也要在
    expect(sql, '定时没加 targetKind').toMatch(/ADD COLUMN IF NOT EXISTS "targetKind"/);
    expect(sql, 'templateId 没改可空——targetKind=task 那种建不了行').toMatch(/ALTER COLUMN "templateId" DROP NOT NULL/);
    expect(sql, '没加 scheduledAgentId——连败闸会永远不累加').toMatch(/ADD COLUMN IF NOT EXISTS "scheduledAgentId"/);
    // 【建了新表必须补 RLS】这张表是 tests/rls-coverage 抓出来的
    expect(read('prisma/postgres/02-rls.sql'), 'RLS 漏了 TaskPreset').toMatch(/'TaskPreset'/);
  });
});
