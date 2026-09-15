import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// AI 自写工具（Hermes 式自扩展的烽火台形态）。钉的是四道边界，每道都是「破了不会报错、只会静默越权」：
//   ① 沙箱：没有 process / require / fetch；只能调 uses 里声明的内置工具；次数封顶；死循环会被超时打断；
//   ② 落库：uses 必须是此刻能用的内置工具；write/costly 由 uses 推出，不由模型自报；起草只落 draft；
//   ③ 形态：SaaS 上 author_tool 在册但恒回「不提供」，enabled 的工具也不会进运行清单；
//   ④ 🔒 写了要接：整机版里人启用之后，剧本模型按名字调它，执行器真的跑到沙箱、结果回到时间线。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  toolDefs: [] as string[],
}));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, _m: unknown, opts?: { tools?: { name: string }[] }) => {
    h.toolDefs = (opts?.tools ?? []).map((t) => t.name);
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return { text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false, ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}) };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { compileAiTool, runAiTool, AI_TOOL_MAX_SUBCALLS } = await import('@/lib/agent/ai-tools/sandbox');
const { validateDraft, flagsFromUses, createAiToolDraft, setAiToolStatus, aiToolsForRun, normalizeParams } = await import('@/lib/agent/ai-tools/store');
const { toolByName } = await import('@/lib/agent/tools');
const { startAgentRun } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
const call = (name: string, args: Record<string, unknown>) => ({ id: `c_${name}`, name, arguments: JSON.stringify(args) });

const GOOD_CODE = `async function main(args, sdk) {
  const r = await sdk.tools.call('list_drafts', { limit: 3 });
  sdk.log('拿到', r.ok);
  return { summary: '草稿 ' + (r.data ? r.data.length : 0) + ' 篇，前缀 ' + args.prefix, data: r.data };
}`;

beforeEach(async () => {
  h.script = []; h.toolDefs = [];
  process.env.BEACON_EDITION = 'appliance';
  await prisma.agentToolDef.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' } });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});
afterEach(() => { delete process.env.BEACON_EDITION; });

const row = (code: string, uses: string[] = ['list_drafts']) => ({ id: 'x', name: 't', label: '测试', description: 'd', params: '{}', uses: JSON.stringify(uses), code });
const subcall = async (name: string, args: Record<string, unknown>) => toolByName(name)!.run(ctx, args);

describe('① 沙箱', () => {
  it('正常跑：能调声明过的内置工具，日志回来', async () => {
    const r = await runAiTool(row(GOOD_CODE), ctx, { prefix: 'p' }, subcall);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('前缀 p');
    expect(r.logs[0]).toContain('拿到');
  });

  it('没声明的工具调不了', async () => {
    const r = await runAiTool(row(`async function main(a, sdk){ return await sdk.tools.call('list_topics', {}); }`), ctx, {}, subcall);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有声明');
  });

  it('沙箱里没有 process / require / fetch', async () => {
    const r = await runAiTool(row(`async function main(){ return { summary: String(typeof process) + ' ' + String(typeof require) + ' ' + String(typeof fetch) }; }`), ctx, {}, subcall);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('undefined undefined undefined');
  });

  it('编译检查拦下 require / process / eval，以及没有 main 的代码', () => {
    expect(compileAiTool(`async function main(){ const fs = require('fs'); }`).ok).toBe(false);
    expect(compileAiTool(`async function main(){ return process.env; }`).ok).toBe(false);
    expect(compileAiTool(`async function main(){ return eval('1'); }`).ok).toBe(false);
    expect(compileAiTool(`function notMain(){}`).ok).toBe(false);
    expect(compileAiTool(`async function main(){ return 'ok' `).ok).toBe(false);
    expect(compileAiTool(GOOD_CODE).ok).toBe(true);
  });

  it('次数封顶', async () => {
    const code = `async function main(a, sdk){ for (let i=0;i<${AI_TOOL_MAX_SUBCALLS + 1};i++) await sdk.tools.call('list_drafts', {}); return 'x'; }`;
    const r = await runAiTool(row(code), ctx, {}, subcall);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('最多');
  });

  it('同步死循环被超时打断（不会把进程挂死）', { timeout: 15_000 }, async () => {
    const t0 = Date.now();
    const r = await runAiTool(row(`async function main(){ while(true){} }`), ctx, {}, subcall, { timeoutMs: 800 });
    expect(r.ok).toBe(false);
    expect(Date.now() - t0, '要在超时附近就回来，而不是等到测试超时').toBeLessThan(5_000);
  });
});

describe('② 落库口径', () => {
  it('uses 必须是此刻能用的内置工具；名字不能撞内置', () => {
    expect(validateDraft({ name: 'my_tool', label: 'x', description: 'd', uses: ['no_such_tool'], code: GOOD_CODE }, ['list_drafts'])).toContain('不是你此刻能用');
    expect(validateDraft({ name: 'list_drafts', label: 'x', description: 'd', uses: ['list_drafts'], code: GOOD_CODE }, ['list_drafts'])).toContain('内置工具的名字');
    expect(validateDraft({ name: 'My-Tool', label: 'x', description: 'd', uses: ['list_drafts'], code: GOOD_CODE }, ['list_drafts'])).toContain('snake_case');
    expect(validateDraft({ name: 'my_tool', label: 'x', description: 'd', uses: ['list_drafts'], code: GOOD_CODE }, ['list_drafts'])).toBeNull();
  });

  it('params 三种形状都收：标准 schema / 只给 properties 那层（MiniMax 真机）/ JSON 字符串；认不出才报错', () => {
    expect(normalizeParams({ type: 'object', properties: { a: { type: 'string' } } })).toEqual({ ok: true, schema: { type: 'object', properties: { a: { type: 'string' } } } });
    expect(normalizeParams({ limit: { type: 'number', description: 'n' } })).toEqual({ ok: true, schema: { type: 'object', properties: { limit: { type: 'number', description: 'n' } } } });
    expect(normalizeParams('{"type":"object","properties":{}}').ok).toBe(true);
    expect(normalizeParams(undefined)).toEqual({ ok: true, schema: { type: 'object', properties: {} } });
    expect(normalizeParams({ limit: 5 }).ok).toBe(false);
    expect(normalizeParams('not json').ok).toBe(false);
  });

  it('write/costly 由 uses 推出，不由模型自报', () => {
    expect(flagsFromUses(['list_drafts'])).toEqual({ write: false, costly: false, contract: false });
    expect(flagsFromUses(['list_drafts', 'create_draft']).write).toBe(true);
    expect(flagsFromUses(['clip_url']).costly).toBe(true);
  });

  it('起草只落 draft，且 write 标记跟着 uses 走', async () => {
    const r = await createAiToolDraft(ctx, { name: 'draft_and_list', label: '建稿并列出', description: 'd', uses: ['create_draft', 'list_drafts'], code: GOOD_CODE });
    expect(r.ok).toBe(true);
    const saved = await prisma.agentToolDef.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } });
    expect(saved.status).toBe('draft');
    expect(saved.write).toBe(true);
    // 草稿不进运行清单
    expect((await aiToolsForRun(ctx)).map((t) => t.name)).toEqual([]);
  });
});

describe('③ 形态闸', () => {
  it('SaaS：author_tool 在册但恒回不提供；enabled 的工具也不进清单', async () => {
    await createAiToolDraft(ctx, { name: 'x_tool', label: 'x', description: 'd', uses: ['list_drafts'], code: GOOD_CODE });
    const id = (await prisma.agentToolDef.findFirstOrThrow()).id;
    await setAiToolStatus(ctx.workspaceId, id, 'enabled');
    process.env.BEACON_EDITION = 'saas';
    const r = await toolByName('author_tool')!.run({ ...ctx }, { name: 'y_tool', label: 'y', description: 'd', uses: ['list_drafts'], code: GOOD_CODE });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不提供');
    expect(await aiToolsForRun(ctx)).toEqual([]);
    expect(await setAiToolStatus(ctx.workspaceId, id, 'enabled'), 'SaaS 上不许启用').toBe(false);
  });
});

describe('④ 🔒 启用之后执行器真的会跑它', () => {
  it('人启用 → 工具进清单 → 模型按名字调 → 沙箱跑完结果回到时间线', async () => {
    const d = await createAiToolDraft(ctx, { name: 'count_drafts', label: '数草稿', description: '数一下草稿', params: { type: 'object', properties: { prefix: { type: 'string' } } }, uses: ['list_drafts'], code: GOOD_CODE });
    expect(d.ok).toBe(true);
    await setAiToolStatus(ctx.workspaceId, (d as { id: string }).id, 'enabled');

    h.script = [
      { toolCalls: [call('count_drafts', { prefix: 'Q' })] },
      { text: '数完了' },
    ];
    const t = await startAgentRun(ctx, '数一下草稿', { authMode: 'unattended' });
    await settleAgentKicks();
    expect(h.toolDefs, '启用的自写工具要出现在送给模型的 tool schema 里').toContain('count_drafts');
    const steps = await prisma.agentStep.findMany({ where: { runId: t.runId }, orderBy: { seq: 'asc' } });
    const res = steps.find((s) => s.kind === 'tool_result' && s.tool === 'count_drafts');
    expect(res, '沙箱结果要回到时间线').toBeTruthy();
    expect(res!.ok).toBe(true);
    expect(res!.result).toContain('前缀 Q');
    const saved = await prisma.agentToolDef.findFirstOrThrow({ where: { name: 'count_drafts' } });
    expect(saved.usedCount).toBe(1);
  });

  it('模型自己起草：author_tool 落一条 draft，summary 让用户去启用', async () => {
    h.script = [
      { toolCalls: [call('author_tool', { name: 'my_combo', label: '组合', description: 'd', uses: ['list_drafts'], code: GOOD_CODE })] },
      { text: '已起草，去技能中心启用' },
    ];
    const t = await startAgentRun(ctx, '给自己做个工具', { authMode: 'unattended' });
    await settleAgentKicks();
    const saved = await prisma.agentToolDef.findFirst({ where: { name: 'my_combo' } });
    expect(saved?.status).toBe('draft');
    expect(saved?.authoredByRunId).toBe(t.runId);
    const res = await prisma.agentStep.findFirst({ where: { runId: t.runId, kind: 'tool_result', tool: 'author_tool' } });
    expect(res?.result).toContain('启用');
  });
});

describe('🔒 生命周期接线（写了要接）', () => {
  it('生产建表 SQL 在、RLS 名单有它、两份 schema 都有 model、导出带 aiTools', async () => {
    const fs = await import('node:fs');
    const read = (p: string) => fs.readFileSync(p, 'utf8');
    expect(fs.existsSync('prisma/postgres/54-agent-tool-def.sql')).toBe(true);
    expect(read('prisma/postgres/02-rls.sql')).toMatch(/'AgentToolDef'/);
    for (const p of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) expect(read(p)).toContain('model AgentToolDef');
    expect(read('lib/account/export.ts')).toContain('aiTools: agentToolDefs.map');
    // 执行器真的把自写工具并进了清单与按名查找，而不是只在页面上列出来
    const run = read('lib/agent/run.ts');
    expect(run).toContain('...(await aiToolsForRun(ctx))');
    expect(run).toMatch(/const tool = await resolveTool\(ctx, call\.name\);/);
  });
});
