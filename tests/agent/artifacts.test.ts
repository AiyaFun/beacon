import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// 批 4-B：这次执行做出了什么。
//
// 【确认闸与产物清单是两道互补的闸】
//   确认闸在**动作之前**：这一步要不要做。
//   产物清单在**动作之后**：做出来的东西对不对。
// 预授权跑完的那些没有前一道，更需要后一道——用户授权的是「你可以建草稿」，
// 不是「你建的每一篇草稿我都认」。
//
// 此前「AI 改了我哪些东西」只能从步骤流水的截断文本里读：点不动、也回不去。

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

const { startAgentRun, getAgentRunView } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { artifactHref, artifactKindLabel, recordArtifacts, listArtifacts } = await import('@/lib/agent/artifacts');
const { AGENT_TOOLS } = await import('@/lib/agent/tools');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
const call = (name: string, args: unknown, id = 'c1') => ({ id, name, arguments: JSON.stringify(args) });

beforeEach(async () => {
  h.script = [];
  await prisma.agentArtifact.deleteMany();
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

describe('产物登记挂在唯一的咽喉上', () => {
  // 挂在 executeCall 上而不是各个工具里：所有工具执行都过它，
  // 于是「新加的工具忘了登记」这件事不会发生——它只要在 ToolResult 里报，就一定被记下。
  it('建草稿会被记成一条产物，且点得进去', async () => {
    h.script = [
      { toolCalls: [call('create_draft', { title: '秋季开学季', platform: 'douyin', content: '正文' })] },
      { text: '建好了' },
    ];
    const turn = await startAgentRun(ctx, '建个草稿', {
      authMode: 'preauthorized',
      preauthorizedTools: ['create_draft'],
    });
    await settleAgentKicks();

    const view = await getAgentRunView(ctx, turn.runId);
    expect(view.artifacts, '建了草稿却没记进产物清单').toHaveLength(1);
    const a = view.artifacts![0];
    expect(a.kind).toBe('draft');
    expect(a.label).toContain('秋季开学季');
    expect(a.href, '产物点不进去等于只是一行字').toMatch(/^\/studio\?draft=/);
    // 指向的是真的那一行
    const draft = await prisma.draft.findFirst();
    expect(a.refId).toBe(draft!.id);
  });

  it('没做出东西的执行不会凭空多出产物', async () => {
    h.script = [{ toolCalls: [call('list_topics', { limit: 3 })] }, { text: '查完了' }];
    const turn = await startAgentRun(ctx, '查一下选题');
    await settleAgentKicks();
    expect((await getAgentRunView(ctx, turn.runId)).artifacts).toBeUndefined();
  });

  // 【为什么不 spy prisma 来造失败】spy 到 Prisma 的方法上，mockRestore 之后
  // 那个方法就不再可用了（它是 client 代理出来的），**后面每个用例**的写入都会静默失败——
  // 表现成一个跟本用例毫无关系的诡异失败。本项目批 0 踩过一次，这里差点又踩。
  // 改成给一个必定写不进去的 runId（外键对不上），测的是同一件事。
  it('产物记不下来也不能影响执行本身（旁路增强）', async () => {
    await expect(recordArtifacts('根本不存在的运行id', [
      { kind: 'draft', refId: 'd1', label: '写不进去的产物' },
    ])).resolves.toBeUndefined();
    expect(await prisma.agentArtifact.count()).toBe(0);
  });
});

describe('每种产物都要有落点，不许指到猜的页面', () => {
  it('登记过的种类各有各的地址', () => {
    expect(artifactHref('draft', 'd1')).toBe('/studio?draft=d1');
    expect(artifactHref('publish_plan', 'p1')).toContain('/publish');
    expect(artifactHref('image', 'i1')).toBe('/images');
    expect(artifactKindLabel('draft_version')).toBe('新版本');
  });

  it('没登记的种类返回空地址（界面据此不渲染链接）', () => {
    // 编一个地址出来 = 用户点过去看到一个不相干的页面，比不给链接更糟
    expect(artifactHref('还没见过的种类', 'x')).toBe('');
  });

  // 【这条守的是「以后新加产物种类」】只要工具里报了一种新 kind，
  // 而这里没给它落点，产物清单上就是一行点不动的字——不报错，只是白记一场。
  it('工具里报出来的每种 kind 都在落点表里登记过', () => {
    const src = ['lib/agent/tools.ts', 'lib/agent/tools-produce.ts', 'lib/agent/tools-content.ts']
      .map((f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
      .join('\n');
    const kinds = [...src.matchAll(/kind:\s*'([a-z_]+)'\s*as\s*const/g)].map((m) => m[1]);
    expect(kinds.length, '一条 artifacts 都没扫到，正则大概是坏的').toBeGreaterThanOrEqual(3);
    for (const k of new Set(kinds)) {
      expect(artifactHref(k, 'x'), `产物种类 ${k} 没有落点，清单上会是一行点不动的字`).not.toBe('');
    }
  });
});

describe('新表的生命周期', () => {
  it('运行记录被删时产物记录跟着走', async () => {
    const run = await prisma.agentRun.create({
      data: { workspaceId: ctx.workspaceId, accountId: ctx.accountId, memberId: ctx.memberId, goal: 'x', status: 'done', messages: '[]' },
    });
    await recordArtifacts(run.id, [{ kind: 'draft', refId: 'd1', label: '一篇草稿' }]);
    expect(await listArtifacts(run.id)).toHaveLength(1);

    await prisma.agentRun.delete({ where: { id: run.id } });
    expect(await prisma.agentArtifact.count()).toBe(0);
  });

  it('两份 schema、生产迁移、RLS 三处都有这张表', () => {
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const block = read(f).match(/model AgentArtifact \{[\s\S]*?\n\}/)?.[0] ?? '';
      expect(block, `${f} 少了 AgentArtifact`).toBeTruthy();
      expect(block, `${f} 的 AgentArtifact 没写 onDelete: Cascade`).toMatch(/onDelete: Cascade/);
    }
    const sql = read('prisma/postgres/26-agent-note.sql');
    expect(sql, '生产迁移没建这张表').toMatch(/CREATE TABLE IF NOT EXISTS "AgentArtifact"/);
    expect(sql, '外键没写级联').toMatch(/"AgentArtifact"[\s\S]*?REFERENCES "AgentRun"\("id"\) ON DELETE CASCADE/);
    // 【建了新表必须补 RLS】不补的话这张表对所有租户敞开
    expect(read('prisma/postgres/02-rls.sql'), 'RLS 漏了这张表').toMatch(/tenant_isolation ON "AgentArtifact"/);
  });
});

describe('界面上要真的把产物摆出来', () => {
  it('执行面板有产物区，且没有落点时不渲染链接', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'app/(app)/assistant/AgentPanel.tsx'), 'utf8')
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
    expect(src, '执行面板没有产物区').toMatch(/turn\.artifacts/);
    expect(src, '没处理「这种产物没有落点」的情况').toMatch(/a\.href \?/);
  });
});

describe('写工具要报出自己做了什么', () => {
  // 报不报是工具自己的事（只有它知道刚写了哪一行），但**该报的必须报**——
  // 不报的话产物清单永远是空的，而这件事不会有任何报错。
  it('建草稿、跑技能、建发布计划、出图都报了产物', () => {
    const src = ['lib/agent/tools.ts', 'lib/agent/tools-produce.ts']
      .map((f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8'))
      .join('\n');
    for (const [tool, kind] of [
      ['create_draft', 'draft'],
      ['run_skill', 'draft_version'],
      ['create_publish_plan', 'publish_plan'],
      ['generate_image', 'image'],
    ] as const) {
      expect(src, `${tool} 没报产物（清单上永远看不到它做的东西）`).toMatch(new RegExp(`kind: '${kind}' as const`));
    }
  });

  it('发布计划的标签要说清「还没发出去」', () => {
    // 产物清单是用户扫一眼就走的地方，只写「发布计划」会被读成「已经发了」——
    // 而「建计划≠发出去」是这个产品的一条老红线
    // 【先剥注释】不剥的话，**解释这条规矩的注释**（就写在 label 上面一行）会被算进匹配段，
    // 于是把 label 改坏了守卫照样绿——「被自己的注释骗」那类假绿，mutation 当场抓到。
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/agent/tools-produce.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const m = src.match(/kind: 'publish_plan' as const[\s\S]{0,300}?label:[\s\S]{0,200}?,/)?.[0] ?? '';
    expect(m, '没扫到发布计划那条产物，正则大概是坏的').toContain('publish_plan');
    expect(m, '发布计划的产物标签没说清还没发出去').toMatch(/还没发|没有发出去|未发布/);
  });
});
