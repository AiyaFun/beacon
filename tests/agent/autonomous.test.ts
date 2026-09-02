import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// 批 4 后半：自主智能体。
//
// 【两种智能体的分界不是「大小」而是「谁决定怎么做」】
//   流水线 —— 一串定死的步骤，跑法完全可预期
//   自主   —— 给它目标和授权范围，它自己安排怎么做
// 两种都是**纯数据**（自主的那份 = 人设 + 工具白名单 + 预算 + 缺省授权档），
// 分享出去的智能体不可能携带任意执行。
//
// 【三条硬规则，每一条都是「不拦就有洞」】
//   ① 白名单 = 父 ∩ 子智能体能用的   —— 不然是一条洗白名单的三步链路
//   ② 授权档继承但不得超过父          —— 不然「派个智能体」成了绕过自己确认闸的捷径
//   ③ 嵌套只许一层                    —— 不然配错的智能体能自己派自己，指数级烧额度

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  // 【必须记下 tools】早先这里只记 messages，于是「白名单生效了吗」只能断言
  // 系统提示词里印的名字——而真正决定模型能调什么的是**送过去的 tool schema**。
  // 那条守卫因此是假绿的：白名单在执行时完全不生效，用例照样全过。
  calls: [] as { messages: { role: string; content?: string }[]; tools: { name: string }[] }[],
}));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (
    _t: unknown, _fn: unknown,
    messages: { role: string; content?: string }[],
    opts?: { tools?: { name: string }[] },
  ) => {
    h.calls.push({ messages, tools: opts?.tools ?? [] });
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView, transition } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { toolByName } = await import('@/lib/agent/tools');
const {
  parseAgentConfig, resolveAgentTools, capAuthMode, capPreauthorized, isAutonomous,
} = await import('@/lib/agent/autonomous');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.script = []; h.calls = [];
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
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

let n = 0;
async function autonomousTemplate(config: Record<string, unknown>, persona = '负责写稿') {
  return prisma.workflowTemplate.create({
    data: {
      tenantId: ctx.tenantId, slug: `auto-${n++}-${Date.now()}`, name: '写稿智能体', emoji: '✍️',
      enabled: true, persona, mode: 'autonomous', steps: '[]',
      agentConfig: JSON.stringify(config),
    },
  });
}

/** 起一次父运行并把它停在 running 上，返回 ctx（带 runId），用来直接调 run_agent */
async function parentCtx(opts: Parameters<typeof startAgentRun>[2] = {}) {
  h.script = [{ text: '先什么都不做' }];
  const t = await startAgentRun(ctx, '父任务', opts);
  await settleAgentKicks();
  await prisma.agentRun.update({ where: { id: t.runId }, data: { status: 'running' } });
  return { ...ctx, runId: t.runId };
}

describe('配置是纯数据，坏数据不炸', () => {
  it('解析出人设、工具白名单、预算、缺省授权档', () => {
    const c = parseAgentConfig(JSON.stringify({
      systemPrompt: '你只写小红书', tools: ['create_draft'], callBudget: 20, defaultAuthMode: 'preauthorized',
    }));
    expect(c.systemPrompt).toBe('你只写小红书');
    expect(c.tools).toEqual(['create_draft']);
    expect(c.callBudget).toBe(20);
    expect(c.defaultAuthMode).toBe('preauthorized');
  });

  it('坏 JSON / 缺字段 / 乱七八糟的值都当成空配置，不抛错', () => {
    for (const raw of ['', null, undefined, '不是 json', '{"tools":"不是数组"}', '{"callBudget":-5}']) {
      const c = parseAgentConfig(raw as string);
      expect(Array.isArray(c.tools)).toBe(true);
      expect(c.callBudget).toBeUndefined();
    }
    // 没见过的授权档一律丢掉（而不是原样放行）
    expect(parseAgentConfig('{"defaultAuthMode":"随便什么"}').defaultAuthMode).toBeUndefined();
  });

  it('两种形态分得清', () => {
    expect(isAutonomous('autonomous')).toBe(true);
    expect(isAutonomous('pipeline')).toBe(false);
    expect(isAutonomous(null)).toBe(false);
  });
});

describe('规则①：工具白名单永远是交集', () => {
  // 【为什么必须是交集】智能体是**可以从市场装别人的**。以模板为准的话，
  // 装一个智能体就能越权——它写什么工具就能用什么工具。
  it('模板要的 ∩ 用户能用的', () => {
    const c = parseAgentConfig(JSON.stringify({ tools: ['create_draft', 'write_memory', '不存在的工具'] }));
    expect(resolveAgentTools(c, ['create_draft', 'list_topics'])).toEqual(['create_draft']);
  });

  it('模板没写白名单 = 不额外收窄（但仍受用户权限约束）', () => {
    const c = parseAgentConfig('{}');
    expect(resolveAgentTools(c, ['create_draft', 'list_topics'])).toEqual(['create_draft', 'list_topics']);
  });

  // 【纵深防御要单独验】child-run 那道收窄之后，run.ts 里还有第二道。
  // 直接跑端到端是验不出第二道的——删掉它行为完全不变（第一道已经把活干了）。
  // 所以这条**绕过第一道**，直接给 startAgentRun 一份越权的白名单。
  it('建行时按白名单收窄：白名单外的工具不进这次执行', async () => {
    // 【用 owner 而不是 viewer】viewer 那种场景第一道（RBAC）就拦住了，
    // 删掉这一道行为完全不变——测不出它。要验的是「有权限、但这次不给用」，
    // 那才是白名单这一层独有的作用。
    h.calls = [];
    h.script = [{ text: '好' }];
    await startAgentRun(ctx, '做点什么', { toolAllowlist: ['list_topics'] });
    await settleAgentKicks();

    // 【断言送给模型的 tool schema，不是提示词文本】提示词里没列 ≠ 模型调不动——
    // tool schema 是每轮现算的，那才是它真正能用的东西
    const names = (h.calls[0]?.tools ?? []).map((t) => t.name);
    expect(names, '白名单没收窄：模型仍然拿得到不该有的工具').not.toContain('create_draft');
    expect(names, '白名单里的那个反而没给').toContain('list_topics');
    // 提示词也要一致（两处对不上会让模型困惑）
    const sys = (h.calls[0]?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    expect(sys).not.toContain('create_draft');
  });

  // 【白名单必须落库】执行是后台跑的、可以挂起几小时再被叫醒——
  // 那时候起初传进来的那个参数早就不在了。只在建行时用一次 = 假的收窄。
  it('白名单落了库，后台恢复时也认它', async () => {
    h.script = [{ text: '好' }];
    const t = await startAgentRun(ctx, '做点什么', { toolAllowlist: ['list_topics'] });
    await settleAgentKicks();
    const row = await prisma.agentRun.findUnique({ where: { id: t.runId }, select: { toolAllowlist: true } });
    expect(JSON.parse(row!.toolAllowlist)).toEqual(['list_topics']);
  });

  it('模型硬调白名单外的工具，执行时也拦得住（纵深防御）', async () => {
    h.script = [
      { toolCalls: [{ id: 'c1', name: 'create_draft', arguments: JSON.stringify({ title: 'X', platform: 'douyin' }) }] },
      { text: '看来不行' },
    ];
    const t = await startAgentRun(ctx, '建个草稿', {
      toolAllowlist: ['list_topics'],
      authMode: 'preauthorized',
      preauthorizedTools: ['create_draft'], // 就算授权过也不行——白名单是另一道
    });
    await settleAgentKicks();

    expect(await prisma.draft.count(), '白名单外的工具被执行了').toBe(0);
    const view = await getAgentRunView(ctx, t.runId);
    const blocked = view.steps.find((s) => s.kind === 'tool_result' && !s.ok);
    expect(blocked?.result).toMatch(/不在其中|只许用/);
  });

  it('端到端：子运行拿不到用户自己没权限的工具', async () => {
    // viewer 没有写权限
    const viewer = await prisma.member.create({ data: { tenantId: ctx.tenantId, name: '看客', role: 'viewer' } });
    const tpl = await autonomousTemplate({ tools: ['create_draft', 'list_topics'] });
    const pctx = { ...(await parentCtx()), memberId: viewer.id, role: 'viewer' };

    const r = await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    if (r.ok) {
      const child = await prisma.agentRun.findFirst({ where: { parentRunId: pctx.runId } });
      const names = (h.calls.at(-1)?.tools ?? []).map((t) => t.name);
      expect(names, 'viewer 的子运行里不该出现写工具').not.toContain('create_draft');
      expect(child).toBeTruthy();
    } else {
      // 一个工具都不剩时如实拒绝，而不是起一个什么都做不了的子运行
      expect(r.error).toMatch(/权限|派不动/);
    }
  });
});

describe('规则②：授权档继承但不得超过父', () => {
  // 【不拦的话】「派个智能体」就成了绕过自己那道确认闸的捷径：
  // 父运行是「每一步都问我」，它派一个 defaultAuthMode='unattended' 的智能体，
  // 那个子运行就什么都不问了——而用户以为自己开的是最保守的档。
  it('父严子松 → 按父的来', () => {
    expect(capAuthMode('confirm_each', 'unattended')).toBe('confirm_each');
    expect(capAuthMode('confirm_each', 'preauthorized')).toBe('confirm_each');
    expect(capAuthMode('preauthorized', 'unattended')).toBe('preauthorized');
  });

  it('父松子严 → 按子的来（子想更保守是可以的）', () => {
    expect(capAuthMode('unattended', 'confirm_each')).toBe('confirm_each');
    expect(capAuthMode('preauthorized', 'confirm_each')).toBe('confirm_each');
  });

  it('没见过的档一律按最保守算', () => {
    expect(capAuthMode('乱写的', 'unattended')).toBe('confirm_each');
    expect(capAuthMode('preauthorized', undefined)).toBe('confirm_each');
  });

  it('端到端：预授权的父派出的子运行不会突然变成无人值守', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'], defaultAuthMode: 'unattended' });
    const pctx = await parentCtx({ authMode: 'preauthorized', preauthorizedTools: ['run_agent', 'create_draft'] });

    await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    const child = await prisma.agentRun.findFirst({ where: { parentRunId: pctx.runId } });
    expect(child?.authMode, '子运行的授权档超过了父运行').not.toBe('unattended');
    expect(child?.authMode).toBe('preauthorized');
  });
});

describe('规则①+②合起来：白名单不许被「洗」', () => {
  // 【这是审查抓到的一条三步链路】
  // 模型起草一个宽白名单的智能体 → 用户在预授权的父运行里让它派这个智能体 →
  // 子运行按子模板重新全勾。用户从头到尾没看过那份白名单。
  it('子运行的预授权 = 父的白名单 ∩ 子能用的，绝不重新全勾', () => {
    expect(capPreauthorized(['create_draft', 'list_topics'], ['create_draft', 'write_memory']))
      .toEqual(['create_draft']);
    // 父没预授权任何东西时，子也拿不到任何预授权
    expect(capPreauthorized([], ['create_draft', 'write_memory'])).toEqual([]);
  });

  it('端到端：父只授权了 A，子智能体想要 A+B，子运行也只拿得到 A', async () => {
    const tpl = await autonomousTemplate({
      tools: ['create_draft', 'add_competitor'],
      defaultAuthMode: 'preauthorized',
    });
    const pctx = await parentCtx({ authMode: 'preauthorized', preauthorizedTools: ['run_agent', 'create_draft'] });

    await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    const child = await prisma.agentRun.findFirst({ where: { parentRunId: pctx.runId } });
    const pre = JSON.parse(child!.preauthorizedTools);
    expect(pre, '子运行拿到了父没授权过的工具').toEqual(['create_draft']);
  });
});

describe('规则③：嵌套只许一层', () => {
  // 不拦的话，一个配错的智能体可以自己派自己，几层下去就是指数级的额度消耗。
  it('子运行不许再往下派', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'] });
    const pctx = await parentCtx();
    await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    const child = await prisma.agentRun.findFirst({ where: { parentRunId: pctx.runId } });
    expect(child).toBeTruthy();

    // 站在子运行的位置再派一次
    const childCtx = { ...ctx, runId: child!.id };
    const r = await toolByName('run_agent')!.run(childCtx, { agent_id: tpl.id, goal: '再派一层' });
    expect(r.ok, '子运行又派出了一层').toBe(false);
    expect(r.error).toMatch(/一层|不能再往下派/);
    expect(await prisma.agentRun.count({ where: { parentRunId: child!.id } })).toBe(0);
  });

  it('没有执行上下文时直接拒绝（不用猜的上界去起子运行）', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'] });
    const r = await toolByName('run_agent')!.run(ctx, { agent_id: tpl.id, goal: '写一篇' }); // ctx 没有 runId
    expect(r.ok).toBe(false);
  });
});

describe('派出去之后：挂起、叫醒、人设', () => {
  it('派自主智能体交回的是 run: 令牌（不是 workflow:）', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'] });
    const pctx = await parentCtx();
    const r = await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    expect(r.ok).toBe(true);
    expect(r.waitFor, '自主智能体应该挂在子运行上，而不是工作流上').toMatch(/^run:/);
  });

  /** 把父运行挂到某个令牌上（真实链路里由执行器的 park 做） */
  async function parkParent(runId: string, token: string) {
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: 'waiting_browser', waitingOn: token,
        pending: JSON.stringify({ id: 'c1', name: 'run_agent', arguments: '{}' }),
        messages: JSON.stringify([{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'run_agent', arguments: '{}' }] }]),
      },
    });
  }

  it('子运行到终态时主动叫醒挂着的父运行', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'] });
    const pctx = await parentCtx();
    const r = await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    const childId = r.waitFor!.slice('run:'.length);
    await parkParent(pctx.runId, r.waitFor!);
    // 把子运行拉回 running 再让它到终态——测的是「终态那一刻会不会叫醒父运行」
    await prisma.agentRun.update({ where: { id: childId }, data: { status: 'running' } });

    h.script = [{ text: '父运行接着说' }];
    await transition(childId, 'running', 'done', { answer: '子任务写完了' });
    await settleAgentKicks();

    const parent = await prisma.agentRun.findUnique({ where: { id: pctx.runId } });
    expect(parent?.status, '子运行跑完了却没叫醒父运行').toBe('done');
    const step = await prisma.agentStep.findFirst({ where: { runId: pctx.runId, kind: 'tool_result' } });
    expect(step?.result).toContain('子任务写完了');
  });

  // 【子运行常常比 park 跑得还快】startChildRun 一返回它就在跑了，而父运行要等
  // 这个工具调用返回之后才挂上去。叫醒扑空是常态，全靠读路径自愈补一刀。
  it('子运行跑完早于父运行挂起（竞态），自愈也能救回来', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'] });
    const pctx = await parentCtx();
    const r = await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks(); // 子运行这时已经跑完了，那次叫醒扑了空

    await parkParent(pctx.runId, r.waitFor!); // 现在才挂上去
    h.script = [{ text: '父运行接着说' }];
    await getAgentRunView(ctx, pctx.runId);   // 用户打开页面
    await settleAgentKicks();

    expect((await prisma.agentRun.findUnique({ where: { id: pctx.runId } }))?.status).toBe('done');
  });

  it('智能体的人设是**补充**不是替换（那几条硬规矩不能随人设一起丢）', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'], systemPrompt: '你只写小红书风格' });
    const pctx = await parentCtx();
    h.calls = [];
    await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    const sys = (h.calls[0]?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    expect(sys, '智能体的人设没拼进去').toContain('你只写小红书风格');
    // 通用助手那几条硬规矩还在
    expect(sys, '人设把通用规矩顶掉了').toContain('不许凭印象编');
  });

  it('子运行记下了自己是谁派的、跑的是哪个智能体', async () => {
    const tpl = await autonomousTemplate({ tools: ['create_draft'] });
    const pctx = await parentCtx();
    await toolByName('run_agent')!.run(pctx, { agent_id: tpl.id, goal: '写一篇' });
    await settleAgentKicks();

    const child = await prisma.agentRun.findFirst({ where: { parentRunId: pctx.runId } });
    expect(child?.parentRunId).toBe(pctx.runId);
    expect(child?.agentTemplateId).toBe(tpl.id);
  });
});

describe('两种形态在界面与模型那边都说得清', () => {
  it('智能体那一档的说明讲了两种形态，且不再说「不会思考」', async () => {
    const { AGENT_ROLES } = await import('@/lib/agent/roles');
    const agent = AGENT_ROLES.agent;
    expect(agent.oneLine, '没讲清有两种形态').toMatch(/流水线|自主/);
    expect(agent.decidedBy, '还在说「步骤是写死的」——自主型不是这样').not.toMatch(/写死/);
    // 与助手的分界改讲成「什么时候用它」
    expect(agent.when).toMatch(/反复|定时/);
  });

  it('list_agents 不许把自主型印成「共 0 步」', () => {
    // 模型看到 0 步会以为这是个空模板而不去派它，用户则会以为自己配坏了
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/agent/tools.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const seg = src.match(/needsFirst: t\.requires[\s\S]{0,600}?\}\)\);/)?.[0] ?? '';
    expect(seg, '没扫到 list_agents 的载荷，正则大概坏了').toContain('needsFirst');
    expect(seg, 'list_agents 没按形态分开').toMatch(/isAutonomous/);
  });
});

describe('上下文折叠：长任务不能让它忘掉自己做过什么', () => {
  // 【原来是直接从中间成对删】那意味着模型会忘掉自己做过什么：
  // 一次长任务跑到后半程，前面查过的数据、建过的草稿全没了，
  // 它可能把同一件事再做一遍——而且是**真的再做一遍，花第二次钱**。
  //
  // 自主智能体正是长任务的来源，所以这一层要跟它一起上。
  // 2026-09-02 起折叠之前多了一步「先剪旧的大工具结果」：大头几乎总是工具结果，
  // 剪掉它们、留下调用记录，模型照样知道自己做过什么，还不用整段丢掉再重查。
  it('大头在工具结果里：只剪结果、不折叠，每一次调用都还在', async () => {
    const { __testing } = await import('@/lib/agent/run');
    const big = 'x'.repeat(30_000);
    const msgs: { role: string; content?: string; toolCalls?: { id: string; name: string; arguments: string }[]; toolCallId?: string }[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '原始目标' },
    ];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: i % 2 ? 'create_draft' : 'list_topics', arguments: '{}' }] });
      msgs.push({ role: 'tool', toolCallId: `c${i}`, content: `{"ok":true,"data":"${big}"}` });
    }
    msgs.push({ role: 'assistant', content: '最后一句' });

    const out = JSON.parse(__testing.capMessages(msgs as never)) as typeof msgs;
    const text = JSON.stringify(out);
    expect(text.length, '剪完还是超长').toBeLessThanOrEqual(200_000);
    expect(text).not.toContain('已折叠');
    // 十次调用一次没少：模型看得见自己建过草稿、查过选题
    expect(out.filter((m) => m.role === 'assistant' && m.toolCalls?.length).length).toBe(10);
    expect(text).toContain('create_draft');
    // 剪掉的结果明确告诉它别重做
    expect(text).toMatch(/不要重做|已经做过/);
    expect(out[0].content).toBe('系统提示');
    expect(text).toContain('最后一句');
  });

  it('大头在助手正文里（剪工具结果剪不下来）：才把中段折叠成一句「做过什么」', async () => {
    const { __testing } = await import('@/lib/agent/run');
    const big = 'x'.repeat(30_000);
    const msgs: { role: string; content?: string; toolCalls?: { id: string; name: string; arguments: string }[]; toolCallId?: string }[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '原始目标' },
    ];
    // 助手每轮都写一大段（比如把正文贴进了对话），工具结果本身很小
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'assistant', content: big, toolCalls: [{ id: `c${i}`, name: i % 2 ? 'create_draft' : 'list_topics', arguments: '{}' }] });
      msgs.push({ role: 'tool', toolCallId: `c${i}`, content: '{"ok":true}' });
    }
    msgs.push({ role: 'assistant', content: '最后一句' });

    const out = JSON.parse(__testing.capMessages(msgs as never));
    const text = JSON.stringify(out);

    expect(text.length, '折叠之后还是超长').toBeLessThanOrEqual(200_000);
    expect(text, '折叠摘要没出现').toContain('已折叠');
    // 关键：它要知道自己做过什么，而不是一片空白
    expect(text, '折叠之后模型不知道自己建过草稿——它会再建一遍').toContain('建草稿');
    expect(text, '折叠之后模型不知道自己查过选题').toContain('查选题');
    // 且要明确告诉它别重做
    expect(text).toMatch(/不要重做|已经做过/);
    // 系统提示与最后一句都还在
    expect(out[0].content).toBe('系统提示');
    expect(text).toContain('最后一句');
  });

  it('没超长就原样不动（别为了折叠而折叠）', async () => {
    const { __testing } = await import('@/lib/agent/run');
    // 【条数要够多】只放三条的话，「条数不足」那道条件会先兜住，
    // 于是把长度判断整个删掉用例照样绿（mutation 抓到的假绿）。
    // 这里放 20 条短消息：条数远超折叠门槛，但总长度只有几百字节。
    const msgs: { role: string; content: string }[] = [{ role: 'system', content: '系统提示' }];
    for (let i = 0; i < 19; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 句` });

    const out = JSON.parse(__testing.capMessages(msgs as never));
    expect(out, '没超长却被折叠了').toHaveLength(20);
    expect(JSON.stringify(out)).not.toContain('已折叠');
  });
});

describe('折叠不许拆散「工具调用与它的回复」', () => {
  // 【为什么这是最糟的一类】一条 assistant(toolCalls) 与随后那几条 tool 回复是一个整体，
  // 线格式上 1:1 对应。按条数硬切会留下**孤儿 tool 消息**，多数端点直接 400——
  // 而折叠结果是**落库**的，于是之后每一轮、每一次追问都把同一份非法对话再送一遍，
  // 那次运行从此永久失败。
  //
  // 排查时用 rounds ∈ {12,15,18,20,24,30} × 每轮 3 个工具调用复现，必现两条孤儿。
  // 【每条工具结果要够大】用 2000 字时 24 个组合里只有 3 个真的超过 200K 上限，
  // 其余压根没折叠——于是「折叠切错了」的 mutation 照样绿（mutation 验证当场抓到）。
  // 8000 字让每一种 rounds×perRound 都真的走进折叠。
  // 【大头放在助手正文而不是工具结果里】2026-09-02 起折叠之前会先剪旧的大工具结果，
  // 放在工具结果里的话剪完就够了、根本走不到折叠——下面那条「每种切点形状都折叠过」
  // 就成了空气。助手正文不剪，所以折叠必然发生。
  function buildLongConversation(rounds: number, callsPerRound: number) {
    const big = 'x'.repeat(8_000);
    const msgs: Array<Record<string, unknown>> = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '原始目标' },
    ];
    for (let r = 0; r < rounds; r++) {
      const calls = Array.from({ length: callsPerRound }, (_, c) => ({
        id: `r${r}c${c}`, name: 'list_topics', arguments: '{}',
      }));
      msgs.push({ role: 'assistant', content: big.repeat(callsPerRound), toolCalls: calls });
      for (const c of calls) msgs.push({ role: 'tool', toolCallId: c.id, content: '{"ok":true}' });
    }
    msgs.push({ role: 'assistant', content: '最后一句' });
    return msgs;
  }

  /** 每条 tool 回复都得找得到它的 assistant（同一条消息里声明过这个 toolCallId） */
  function orphanToolReplies(msgs: Array<Record<string, unknown>>): string[] {
    const declared = new Set<string>();
    const orphans: string[] = [];
    for (const m of msgs) {
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        for (const c of m.toolCalls as Array<{ id: string }>) declared.add(c.id);
      }
      if (m.role === 'tool' && !declared.has(m.toolCallId as string)) orphans.push(m.toolCallId as string);
    }
    return orphans;
  }

  it('各种轮数与每轮调用数下，折叠后都不留孤儿 tool 回复', async () => {
    const { __testing } = await import('@/lib/agent/run');
    /** 每种「每轮几个工具」都要至少真折叠过一次——切点落在哪种消息上，取决于这个数 */
    const foldedPerShape = new Map<number, number>();
    for (const rounds of [12, 15, 18, 20, 24, 30]) {
      for (const perRound of [1, 2, 3, 5]) {
        const msgs = buildLongConversation(rounds, perRound);
        const out = JSON.parse(__testing.capMessages(msgs as never));
        if (JSON.stringify(out).includes('已折叠')) {
          foldedPerShape.set(perRound, (foldedPerShape.get(perRound) ?? 0) + 1);
        }
        expect(
          orphanToolReplies(out),
          `rounds=${rounds} perRound=${perRound} 折叠后留下了孤儿 tool 回复——这次运行会永久 400`,
        ).toEqual([]);
      }
    }
    // 【不验这一条就是在验空气】折叠没发生的话，上面那些断言全部是恒真的。
    // 轮数少的那几组本来就到不了上限，所以不要求 24 个全折叠，
    // 但**每种切点形状**都必须真的走进过折叠。
    for (const perRound of [1, 2, 3, 5]) {
      expect(foldedPerShape.get(perRound) ?? 0, `每轮 ${perRound} 个工具的场景一次都没真折叠——那一类切点没被验到`)
        .toBeGreaterThan(0);
    }
  });

  // 折叠完还是太长（最近几轮里有超大工具结果）时会走第二步的删除循环，
  // 那一步同样不许拆散配对
  it('折叠后仍超长时，第二步删除也不留孤儿', async () => {
    const { __testing } = await import('@/lib/agent/run');
    const huge = 'y'.repeat(60_000);
    const msgs: Array<Record<string, unknown>> = [{ role: 'system', content: '系统提示' }];
    // 最近这几轮每条都极大：折叠掉中段之后仍然超限，必然走进第二步
    for (let r = 0; r < 8; r++) {
      const calls = [{ id: `h${r}a`, name: 'list_topics', arguments: '{}' }, { id: `h${r}b`, name: 'list_drafts', arguments: '{}' }];
      msgs.push({ role: 'assistant', content: '', toolCalls: calls });
      for (const c of calls) msgs.push({ role: 'tool', toolCallId: c.id, content: `{"ok":true,"d":"${huge}"}` });
    }
    const out = JSON.parse(__testing.capMessages(msgs as never));
    expect(orphanToolReplies(out), '第二步删除拆散了配对').toEqual([]);
    expect(out[0].content, '系统提示被删掉了').toBe('系统提示');
  });

  it('这条守卫真的抓得到孤儿（不然它永远是空数组）', () => {
    // 手工造一条孤儿，确认检测函数不是恒返回空
    const bad = [
      { role: 'system', content: 's' },
      { role: 'tool', toolCallId: '没人声明过的id', content: '{}' },
    ];
    expect(orphanToolReplies(bad)).toEqual(['没人声明过的id']);
  });

  it('折叠之后仍然是合法 JSON、系统提示与最后一句都在', async () => {
    const { __testing } = await import('@/lib/agent/run');
    const out = JSON.parse(__testing.capMessages(buildLongConversation(20, 3) as never));
    expect(out[0].content).toBe('系统提示');
    expect(JSON.stringify(out)).toContain('最后一句');
  });
});

describe('折叠也不许留下没有回复的 tool_call', () => {
  // 与孤儿 tool 回复是**对称**的另一半：一条 assistant(toolCalls) 留在保留区、
  // 而它的回复不在（或者根本还没来——挂起时对话里就留着这么一条悬空调用），
  // 同样是非法对话，多数端点直接 400。
  //
  // 【这条是 mutation 逼出来的】safeCut 里原本还有一个「退到 assistant 本身再退一格」的分支，
  // 删掉它测试照样绿——查下去才发现它不只是死代码：那一格会把**没有回复的** assistant
  // 从折叠区推进保留区，反而制造悬空调用。
  function danglingCalls(msgs: Array<Record<string, unknown>>): string[] {
    const replied = new Set<string>();
    for (const m of msgs) if (m.role === 'tool') replied.add(m.toolCallId as string);
    const out: string[] = [];
    for (const m of msgs) {
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        for (const c of m.toolCalls as Array<{ id: string }>) if (!replied.has(c.id)) out.push(c.id);
      }
    }
    return out;
  }

  it('挂起时那条悬空调用，折叠之后不许被留在保留区', async () => {
    const { __testing } = await import('@/lib/agent/run');
    const big = 'z'.repeat(8_000);
    const msgs: Array<Record<string, unknown>> = [{ role: 'system', content: '系统提示' }];
    for (let r = 0; r < 30; r++) {
      const calls = [{ id: `d${r}`, name: 'list_topics', arguments: '{}' }];
      msgs.push({ role: 'assistant', content: '', toolCalls: calls });
      msgs.push({ role: 'tool', toolCallId: `d${r}`, content: `{"ok":true,"d":"${big}"}` });
    }
    // 最后一条：派了活还没回来（park 时对话里就是这个样子）
    msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: 'pending-1', name: 'dispatch_browser_task', arguments: '{}' }] });

    const out = JSON.parse(__testing.capMessages(msgs as never));
    const dangling = danglingCalls(out);
    // 【最后那条本来就是悬空的，它必须留着】——叫醒时要靠它把结果对回去。
    // 要防的是「折叠把**别的**调用也变成悬空」。
    expect(dangling, '折叠把本来有回复的调用变成了悬空').toEqual(['pending-1']);
  });

  it('这条守卫真的抓得到悬空（不然它永远是空数组）', () => {
    const bad = [{ role: 'assistant', toolCalls: [{ id: '没人回过的' }] }];
    expect(danglingCalls(bad)).toEqual(['没人回过的']);
  });
});
