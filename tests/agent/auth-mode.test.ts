import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 批 2 的安全守卫。这一批是整个重构里**唯一真正改变安全边界**的一批——
// 它把「写操作必须有人点头」这条从「永远」放宽成「除非用户提前授权过」。
//
// 所以下面每一条守的都是「放宽之后还剩下什么」：
//   · 预授权只能来自**发起人在派发时的页面动作**，模型说什么都不算
//   · 签合约那几样（定时/记忆/发布计划/新智能体）任何档下都要人点头
//   · run_agent 不能当成绕过上一条的后门
//   · 对外调用面（API/MCP）永远回到最保守的档
//
// 【为什么必须是行为守卫】这些用源码断言全都会假绿：把判定改成 `if (false && ...)`，
// 字符串还在、位置也还在，扫源码的守卫照过不误。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  calls: [] as { messages: unknown[]; tools: { name: string }[] }[],
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: unknown[], opts?: { tools?: { name: string }[] }) => {
    h.calls.push({ messages, tools: opts?.tools ?? [] });
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun, getAgentRunView } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { needsConfirm, toolByName, AGENT_TOOLS } = await import('@/lib/agent/tools');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
const call = (name: string, args: unknown, id = 'c1') => ({ id, name, arguments: JSON.stringify(args) });

beforeEach(async () => {
  h.script = [];
  h.calls = [];
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

describe('三档的分界', () => {
  const draft = () => toolByName('create_draft')!;
  const list = () => toolByName('list_topics')!;

  it('缺省档：会改数据或花钱的都要问', () => {
    expect(needsConfirm(draft(), { authMode: 'confirm_each', preauthorizedTools: [] })).toBe(true);
    expect(needsConfirm(list(), { authMode: 'confirm_each', preauthorizedTools: [] })).toBe(false);
  });

  it('预授权：勾过的不问，**没勾的照问**', () => {
    expect(needsConfirm(draft(), { authMode: 'preauthorized', preauthorizedTools: ['create_draft'] })).toBe(false);
    expect(needsConfirm(draft(), { authMode: 'preauthorized', preauthorizedTools: ['add_competitor'] })).toBe(true);
    expect(needsConfirm(draft(), { authMode: 'preauthorized', preauthorizedTools: [] })).toBe(true);
  });

  it('无人值守：普通写操作不问', () => {
    expect(needsConfirm(draft(), { authMode: 'unattended', preauthorizedTools: [] })).toBe(false);
  });

  // 【漏传的失败方向必须是「多问一次」】而不是「悄悄执行」。
  // 将来任何一处忘了把运行传进来，代价只是用户多点一下，不是一次没人知道的写操作。
  it('说不清授权状态时按最保守的档：一律要问', () => {
    expect(needsConfirm(draft())).toBe(true);
    expect(needsConfirm(draft(), null)).toBe(true);
    expect(needsConfirm(draft(), { authMode: '不认识的档', preauthorizedTools: [] })).toBe(true);
  });
});

describe('签合约那几样：任何档下都要人点头', () => {
  // 它们的共同点是**影响不止这一次执行**：定时会在他睡着时按时花钱、
  // 记忆会改变以后每一次生成、发布计划摆着等被发出去、新智能体建出来能被反复派。
  const CONTRACT = ['create_publish_plan', 'write_memory', 'draft_schedule', 'draft_workflow'];

  it('四个签合约的工具都打了 contract 标记', () => {
    for (const name of CONTRACT) {
      expect(toolByName(name)?.contract, `${name} 没打 contract 标记`).toBe(true);
    }
  });

  it('无人值守下它们照样要确认（机制级，不看授权档）', () => {
    for (const name of CONTRACT) {
      const t = toolByName(name)!;
      expect(needsConfirm(t, { authMode: 'unattended', preauthorizedTools: [] }), `${name} 在无人值守下被放行了`).toBe(true);
    }
  });

  it('就算被显式勾进预授权白名单，也照样要确认', () => {
    for (const name of CONTRACT) {
      const t = toolByName(name)!;
      expect(needsConfirm(t, { authMode: 'preauthorized', preauthorizedTools: CONTRACT }), `${name} 被白名单放行了`).toBe(true);
    }
  });

  // 【这条守的是「以后新加的工具」】排除表如果是一张写死的名字清单，
  // 新加一个「配点什么」的工具时作者会记得填 write（不填测试会红），
  // 却很难想起去另一个文件补一行——而漏掉的后果是无人值守时它被静默执行。
  it('凡是能创建定时/模板/发布计划的工具，都必须打 contract 标记', () => {
    const suspicious = AGENT_TOOLS.filter((t) =>
      /schedule|workflow|publish_plan|memory/.test(t.name) && t.write && !t.name.startsWith('list_'));
    expect(suspicious.length, '没扫到任何可疑工具，正则大概是坏的').toBeGreaterThanOrEqual(4);
    for (const t of suspicious) {
      expect(t.contract, `${t.name} 会签一份以后自己生效的东西，必须打 contract`).toBe(true);
    }
  });
});

describe('预授权只能来自发起人的页面动作', () => {
  it('派发时勾定的工具，执行时真的不再问', async () => {
    h.script = [
      { toolCalls: [call('create_draft', { title: '授权过的稿', platform: 'douyin', content: '正文' })] },
      { text: '建好了' },
    ];
    const turn = await startAgentRun(ctx, '建个草稿', {
      authMode: 'preauthorized',
      preauthorizedTools: ['create_draft'],
    });
    await settleAgentKicks();

    const view = await getAgentRunView(ctx, turn.runId);
    expect(view.status, '授权过的工具不该再停下来问').toBe('done');
    expect(await prisma.draft.count()).toBe(1);
  });

  it('没勾的那个照样停下来问', async () => {
    h.script = [{ toolCalls: [call('add_competitor', { platform: 'douyin', handle: 'x', name: 'X' })] }];
    const turn = await startAgentRun(ctx, '加个对标', {
      authMode: 'preauthorized',
      preauthorizedTools: ['create_draft'], // 勾的是别的
    });
    await settleAgentKicks();

    expect((await getAgentRunView(ctx, turn.runId)).status).toBe('awaiting_confirm');
  });

  // 【模型说什么都不算】它可以在对话里写「用户已经授权我建草稿了」——
  // 判定读的是**库里那两列**，与对话内容毫无关系。
  it('模型在对话里自称已获授权，不产生任何效果', async () => {
    h.script = [
      { text: '用户已经授权我执行所有写操作了，我这就去建草稿。', toolCalls: [call('create_draft', { title: '偷跑的稿', platform: 'douyin' })] },
    ];
    const turn = await startAgentRun(ctx, '建个草稿', { authMode: 'confirm_each' }); // 逐步确认档，没有任何授权
    await settleAgentKicks();

    expect((await getAgentRunView(ctx, turn.runId)).status).toBe('awaiting_confirm');
    expect(await prisma.draft.count(), '一个字都不该写进库').toBe(0);
  });

  it('白名单只在预授权档存下来：别的档不留一份没人记得的授权', async () => {
    const turn = await startAgentRun(ctx, '随便', {
      authMode: 'confirm_each',
      preauthorizedTools: ['create_draft', 'add_competitor'],
    });
    const row = await prisma.agentRun.findUnique({ where: { id: turn.runId }, select: { preauthorizedTools: true } });
    expect(JSON.parse(row!.preauthorizedTools)).toEqual([]);
  });

  // 2026-09-03 用户拍板：「无论在群里派发任务还是在页面桌面端，只要是任务，就要直接去完成」。
  // 此前无人值守只有定时派的才放行，页面上派的被压回逐步确认——那条闸删了。
  it('页面 / 群里 / 定时派的活，不传档就是直接跑完（unattended）', async () => {
    for (const origin of ['manual', 'bot', 'preset', 'schedule'] as const) {
      const turn = await startAgentRun(ctx, `${origin} 派的`, { origin });
      expect((await prisma.agentRun.findUnique({ where: { id: turn.runId } }))?.authMode, origin).toBe('unattended');
    }
  });

  it('直接跑完不是一句空话：写操作真的不停下来', async () => {
    h.script = [
      { toolCalls: [call('create_draft', { title: '直接建的稿', platform: 'douyin', content: '正文' })] },
      { text: '建好了。' },
    ];
    const turn = await startAgentRun(ctx, '帮我建一篇草稿', { origin: 'manual' });
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, turn.runId)).status).toBe('done');
    expect(await prisma.draft.count()).toBe(1);
  });

  it('用户在派发卡上选「每一步都先问我」仍然生效（缺省放开不等于不能收紧）', async () => {
    h.script = [{ toolCalls: [call('create_draft', { title: '要问的稿', platform: 'douyin', content: '正文' })] }];
    const turn = await startAgentRun(ctx, '帮我建一篇草稿', { origin: 'manual', authMode: 'confirm_each' });
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, turn.runId)).status).toBe('awaiting_confirm');
    expect(await prisma.draft.count()).toBe(0);
  });

  it('直接跑完也拦不住签合约那几样（机制级闸不随缺省放开）', async () => {
    h.script = [{ toolCalls: [call('draft_schedule', { title: '每天早上跑', cron: '0 9 * * *', goal: '看数据' })] }];
    const turn = await startAgentRun(ctx, '给我配个定时', { origin: 'manual' });
    await settleAgentKicks();
    const view = await getAgentRunView(ctx, turn.runId);
    expect(view.status, '定时是会在用户睡着时花钱的合约，任何档都要停').toBe('awaiting_confirm');
  });
});

describe('对外调用面永远回到最保守的档', () => {
  // 【为什么这条是安全性质】对外调用面（/api/v1/runs、MCP）那头坐着的常常是**另一个模型**。
  // 模型 A 起草、模型 B 代签，「写操作必须有人点头」就等于没有。
  // 而「接口不收这个参数」是一句随时会被下一次改动破坏的保证——
  // 将来任何人给 startAgentRun 接上「模板自带的缺省授权档」，API 面就跟着静默升权。
  // 所以判定放在 startAgentRun 里，一个所有调用方都绕不过去的地方。
  // 【用 preauthorized 而不是 unattended 来验这道闸】
  // 一开始这条写的是 unattended，mutation 一跑才发现是**假绿**：
  // 那个值恰好被另一道闸（「无人值守只能由定时/预设配」）兜住了，
  // 把 api 这道闸整个删掉，用例照样绿。preauthorized 不会被那道闸拦，
  // 它才真的在验「api 那一行」。
  it('origin=api 的运行强制 confirm_each、白名单强制清空', async () => {
    const turn = await startAgentRun(ctx, '外部调用', {
      origin: 'api',
      authMode: 'preauthorized',                    // 就算调用方硬传
      preauthorizedTools: ['create_draft', 'write_memory'],
    });
    const row = await prisma.agentRun.findUnique({ where: { id: turn.runId } });
    expect(row?.authMode).toBe('confirm_each');
    expect(JSON.parse(row!.preauthorizedTools)).toEqual([]);
  });

  it('api 传无人值守同样落回最保守档（两道闸各挡一次，删掉任何一道都还有另一道）', async () => {
    const turn = await startAgentRun(ctx, '外部调用', { origin: 'api', authMode: 'unattended' });
    expect((await prisma.agentRun.findUnique({ where: { id: turn.runId } }))?.authMode).toBe('confirm_each');
  });

  it('外部调用真的会被逐步确认拦住（不是只有那一列写对了）', async () => {
    h.script = [{ toolCalls: [call('create_draft', { title: '外部想建的稿', platform: 'douyin' })] }];
    const turn = await startAgentRun(ctx, '帮我建个草稿', {
      origin: 'api',
      authMode: 'preauthorized',
      preauthorizedTools: ['create_draft'],
    });
    await settleAgentKicks();

    expect((await getAgentRunView(ctx, turn.runId)).status).toBe('awaiting_confirm');
    expect(await prisma.draft.count(), '外部调用不该能直接写库').toBe(0);
  });

  it('对外调用面的路由没有把授权档暴露出去', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/v1/runs/route.ts'), 'utf8');
    expect(src, '对外接口不许收授权档参数').not.toMatch(/authMode|preauthorizedTools/);
    const mcp = fs.readFileSync(path.join(process.cwd(), 'mcp-server.ts'), 'utf8');
    expect(mcp, 'MCP 不许收授权档参数').not.toMatch(/authMode|preauthorizedTools/);
  });
});

describe('run_agent 不能当成绕过 contract 闸的后门', () => {
  // 【这是审查抓到的一条真后门】智能体模板的步骤里有 publish（建发布计划）
  // 与 notify（往群里推消息）两种，而**模板执行不经过逐步确认闸**——
  // 它是一次工具调用里从头跑到尾的。于是「无人值守下不许签合约」这条规矩，
  // 只要模型改派一个含 publish 步的模板就绕过去了。
  async function makeTemplate(steps: unknown[], slug: string) {
    return prisma.workflowTemplate.create({
      data: {
        tenantId: ctx.tenantId, slug, name: `模板-${slug}`, emoji: '🤖',
        steps: JSON.stringify(steps), persona: '', requires: '',
      },
    });
  }

  it('无人值守下派一个含「建发布计划」步的模板，照样停下来问', async () => {
    const tpl = await makeTemplate([{ kind: 'draft', platform: 'douyin' }, { kind: 'publish', platforms: ['douyin'] }], 'has-publish');
    h.script = [{ toolCalls: [call('run_agent', { agent_id: tpl.id })] }];

    const turn = await startAgentRun(ctx, '跑那个智能体', { origin: 'schedule', authMode: 'unattended' });
    await settleAgentKicks();

    expect((await getAgentRunView(ctx, turn.runId)).status, 'run_agent 成了绕过 contract 闸的后门').toBe('awaiting_confirm');
  });

  it('含「往群里推消息」步的模板同样拦下', async () => {
    const tpl = await makeTemplate([{ kind: 'analyze', target: 'performance' }, { kind: 'notify', title: 'x' }], 'has-notify');
    h.script = [{ toolCalls: [call('run_agent', { agent_id: tpl.id })] }];

    const turn = await startAgentRun(ctx, '跑那个智能体', { origin: 'schedule', authMode: 'unattended' });
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, turn.runId)).status).toBe('awaiting_confirm');
  });

  it('不含那两种步骤的模板可以直接跑（这道闸只拦该拦的）', async () => {
    const tpl = await makeTemplate([{ kind: 'draft', platform: 'douyin' }], 'plain');
    h.script = [{ toolCalls: [call('run_agent', { agent_id: tpl.id })] }, { text: '跑完了' }];

    const turn = await startAgentRun(ctx, '跑那个智能体', { origin: 'schedule', authMode: 'unattended' });
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, turn.runId)).status).not.toBe('awaiting_confirm');
  });

  it('说不清是哪个模板（没给 id / 查不到）时按最保守的来', async () => {
    h.script = [{ toolCalls: [call('run_agent', {})] }];
    const turn = await startAgentRun(ctx, '跑个智能体', { origin: 'schedule', authMode: 'unattended' });
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, turn.runId)).status).toBe('awaiting_confirm');
  });
});

describe('派发卡：按后果分组，而不是摆 14 行工具名', () => {
  // 通用助手下会改数据或花钱的工具有十几个。逐行摆出来让人勾，结果只有两极：
  // 多数人直接点「授权并开跑」（清单沦为橡皮图章），少数人被吓住全不勾
  // （等于还是逐条确认，还多一步）。两种都让这层设计形同虚设。
  it('分组按后果算，新加的工具自动落到正确的组', async () => {
    const { groupOf, AUTH_GROUPS } = await import('@/lib/agent/auth-groups');
    // 签合约的一律进 commit 组（缺省不勾）
    expect(groupOf({ name: 'write_memory', contract: true })).toBe('commit');
    expect(groupOf({ name: 'draft_schedule', contract: true, costly: false })).toBe('commit');
    // 花钱的进 spend
    expect(groupOf({ name: 'generate_topics', costly: true })).toBe('spend');
    // 剩下的改内容
    expect(groupOf({ name: 'create_draft' })).toBe('content');
    // 「签合约」那组缺省不勾——它们影响不止这一次执行
    expect(AUTH_GROUPS.find((g) => g.key === 'commit')?.defaultOn).toBe(false);
  });

  // 【这条守的是「以后新加工具时会不会归错组」】分组是按标记现算的，
  // 不是一张要人维护的名字表——所以真正要钉的是「注册表里每个工具都能算出组」。
  it('注册表里每个会改数据/花钱的工具都归得了组，且 contract 的都在 commit 组', async () => {
    const { groupOf } = await import('@/lib/agent/auth-groups');
    const risky = AGENT_TOOLS.filter((t) => t.write || t.costly);
    expect(risky.length).toBeGreaterThan(8);
    for (const t of risky) {
      const g = groupOf(t);
      expect(['content', 'spend', 'commit'], `${t.name} 归不了组`).toContain(g);
      if (t.contract) expect(g, `${t.name} 打了 contract 却没进 commit 组`).toBe('commit');
    }
  });

  it('勾组 → 展开成具体工具名，签合约那组即使勾了也仍然会被逐个问', async () => {
    const { toolsForGroups } = await import('@/lib/agent/auth-groups');
    const tools = AGENT_TOOLS.filter((t) => t.write || t.costly);
    const names = toolsForGroups(tools, ['content', 'spend', 'commit']);
    expect(names).toContain('create_draft');
    expect(names).toContain('write_memory'); // 名字在白名单里
    // ——但机制级的闸仍然拦住它（这才是 contract 标记的意义）
    expect(needsConfirm(toolByName('write_memory')!, { authMode: 'preauthorized', preauthorizedTools: names })).toBe(true);
  });

  it('🔒 派活只有一处入口，且那一处必须挂授权卡', async () => {
    // 【守的性质变强了，不是变松】原来是「两个壳各挂一张授权卡」。
    // 2026-08-26 查出首页那个框与「新任务」是**行为分歧**：两处标题都写「今天要做什么」，
    // 但首页回车直接 actStartAgent（立刻花配额），新任务页回车是先答话、答完才问你要不要做。
    // 于是首页改成把这句话交给 /assistant 预填（?goal=，只预填不自动跑）。
    // 现在只剩一个真正开跑的地方，授权卡就钉在那儿——
    // **再出现第二个绕过授权卡的派活入口，这条会红**。
    const fs = await import('node:fs');
    const path = await import('node:path');
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
    const panel = read('app/(app)/assistant/AgentPanel.tsx');
    expect(panel, '唯一的派活入口没挂授权卡').toMatch(/<DispatchAuth/);
    expect(panel, '授权没带给 server action，勾了等于没勾').toMatch(/actStartAgent\(goal, auth\)/);
    // 首页那个框不许自己开跑——它一开跑就绕过了授权卡
    expect(read('components/TaskDeckHome.tsx'), '首页又自己派活了，授权卡被绕过')
      .not.toMatch(/actStartAgent\(/);
    // 而它必须真的把话交出去，不能变成一个打了字没反应的框
    expect(read('components/TaskDeckHome.tsx'), '首页的框没把话交给助手页')
      .toMatch(/\/assistant\?goal=/);
  });

  it('contract 标记要一路带到界面，否则派发卡会把签合约的归错组', async () => {
    const { availableTools } = await import('@/lib/agent/run');
    const tools = availableTools('owner');
    const mem = tools.find((t) => t.name === 'write_memory');
    // 【类型上它是可选的，漏传不会报错】所以只能靠这条守：
    // 漏了的话那几样会落进缺省勾上的组，用户以为勾的是「改我的内容」，
    // 卡上却把「配定时」也算了进去
    expect(mem?.contract, 'availableTools 没把 contract 带出来').toBe(true);
  });
});
