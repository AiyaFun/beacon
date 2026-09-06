import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// 智能体台账（2026-09-05，学 Grok Bot「工作状态放文件不放记忆」）。
// 守三件事：① 按「工作区 × bot」隔离，别的 bot 看不见；② 已见清单真的能去重；
// ③ 运行里工具拿到的是**正在跑的那个 bot** 的格子（不是 'assistant'），系统提示注了台账。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  calls: [] as { messages: { role: string; content: string }[] }[],
}));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: { role: string; content: string }[]) => {
    h.calls.push({ messages });
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return { text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false, ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}) };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { ledgerSet, ledgerGet, ledgerList, markSeen, renderLedgerBlock, LEDGER_KV_MAX, SEEN_BATCH_MAX, ASSISTANT_SLUG } = await import('@/lib/agent/ledger');
const { toolByName } = await import('@/lib/agent/tools');
const { startAgentRun } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');
const { ensureBuiltinTemplates } = await import('@/lib/workflow/market');

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let ws = ''; let ws2 = '';
let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
beforeEach(async () => {
  h.script = []; h.calls = [];
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.tenant.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  const w2 = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W2' } });
  ws = w.id; ws2 = w2.id;
  const account = await prisma.creatorAccount.create({ data: { workspaceId: ws, name: '我的号', platform: 'x', personaCard: '{}' } });
  const member = await prisma.member.create({ data: { tenantId: t.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: t.id, workspaceId: ws, accountId: account.id, memberId: member.id, role: 'owner' };
});

describe('键值台账', () => {
  it('写、读、列；写空即删', async () => {
    expect((await ledgerSet(ws, 'bot-scout', '盯单', '@a @b')).ok).toBe(true);
    expect(await ledgerGet(ws, 'bot-scout', '盯单')).toBe('@a @b');
    expect((await ledgerList(ws, 'bot-scout')).map((e) => e.key)).toEqual(['盯单']);
    const r = await ledgerSet(ws, 'bot-scout', '盯单', '   ');
    expect(r.ok && r.deleted).toBe(true);
    expect(await ledgerGet(ws, 'bot-scout', '盯单')).toBeNull();
  });

  it('🔒 按「工作区 × bot」隔离：情报员写的，复盘官和别的工作区都看不见', async () => {
    await ledgerSet(ws, 'bot-scout', '盯单', 'x');
    expect(await ledgerGet(ws, 'bot-analyst', '盯单')).toBeNull();
    expect(await ledgerGet(ws2, 'bot-scout', '盯单')).toBeNull();
    expect(await ledgerGet(ws, ASSISTANT_SLUG, '盯单')).toBeNull();
  });

  it('封顶：满了新键拒绝并说明，旧键仍能改', async () => {
    for (let i = 0; i < LEDGER_KV_MAX; i++) expect((await ledgerSet(ws, 'b', `k${i}`, 'v')).ok).toBe(true);
    const r = await ledgerSet(ws, 'b', '再来一条', 'v');
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain(String(LEDGER_KV_MAX));
    expect((await ledgerSet(ws, 'b', 'k0', '改了')).ok).toBe(true);
  });
});

describe('已见清单', () => {
  it('第一次全是新的，第二次全是见过的；跨 bot 不共享', async () => {
    const a = await markSeen(ws, 'bot-scout', ['https://x.com/p/1', 'https://x.com/p/2', 'https://x.com/p/1']);
    expect(a.fresh).toEqual(['https://x.com/p/1', 'https://x.com/p/2']);
    expect(a.seen).toEqual([]);
    const b = await markSeen(ws, 'bot-scout', ['https://x.com/p/2', 'https://x.com/p/3']);
    expect(b.fresh).toEqual(['https://x.com/p/3']);
    expect(b.seen).toEqual(['https://x.com/p/2']);
    const c = await markSeen(ws, 'bot-topic', ['https://x.com/p/1']);
    expect(c.fresh, '选题官不该继承情报员的已见清单').toEqual(['https://x.com/p/1']);
  });

  it('一次最多 SEEN_BATCH_MAX 条；空的不写', async () => {
    const ids = Array.from({ length: SEEN_BATCH_MAX + 50 }, (_, i) => `id-${i}`);
    const r = await markSeen(ws, 'b', ids);
    expect(r.fresh.length + r.seen.length).toBe(SEEN_BATCH_MAX);
    expect(await markSeen(ws, 'b', ['', '  '])).toEqual({ fresh: [], seen: [] });
  });

  it('90 天前的过期：老条目再出现算新的', async () => {
    await markSeen(ws, 'b', ['old']);
    await prisma.agentLedger.updateMany({ where: { workspaceId: ws, botSlug: 'b', key: 'old' }, data: { updatedAt: new Date(Date.now() - 91 * 86_400_000) } });
    const r = await markSeen(ws, 'b', ['new']); // 任何一次写入都会顺手清过期
    expect(r.fresh).toEqual(['new']);
    expect((await markSeen(ws, 'b', ['old'])).fresh).toEqual(['old']);
  });
});

describe('注进系统提示的那一段', () => {
  it('空台账不注；有东西时带键值摘要与已见条数', async () => {
    expect(await renderLedgerBlock(ws, 'b')).toBe('');
    await ledgerSet(ws, 'b', '盯单', '@a');
    await markSeen(ws, 'b', ['u1', 'u2']);
    const block = await renderLedgerBlock(ws, 'b');
    expect(block).toContain('【你的台账】');
    expect(block).toContain('盯单：@a');
    expect(block).toContain('2 条');
  });
});

describe('工具与运行接线', () => {
  it('工具按 ctx.botSlug 落格子；没有 botSlug 落 assistant', async () => {
    const w = toolByName('ledger_write')!; const r = toolByName('ledger_read')!; const m = toolByName('mark_seen')!;
    expect(w.write).toBe(true); expect(r.write).toBe(false);
    expect(w.contract, '台账不是合约，逐条确认会让去重被关掉').toBeFalsy();
    await w.run({ ...ctx, botSlug: 'bot-scout' }, { key: '盯单', value: '@a' });
    await w.run(ctx, { key: '盯单', value: '通用助手的' });
    expect(await ledgerGet(ws, 'bot-scout', '盯单')).toBe('@a');
    expect(await ledgerGet(ws, ASSISTANT_SLUG, '盯单')).toBe('通用助手的');
    const seen = await m.run({ ...ctx, botSlug: 'bot-scout' }, { ids: ['u1'] });
    expect((seen.data as { fresh: string[] }).fresh).toEqual(['u1']);
    const readBack = await r.run({ ...ctx, botSlug: 'bot-scout' }, {});
    expect(readBack.summary).toContain('1 条');
  });

  it('🔒 真跑一次职能 bot：工具写进的是这个 bot 的格子，系统提示里注了它的台账', async () => {
    await ensureBuiltinTemplates();
    const scout = await prisma.workflowTemplate.findFirstOrThrow({ where: { slug: 'bot-scout' } });
    await ledgerSet(ws, 'bot-scout', '盯单', '@rival');
    h.script = [
      { toolCalls: [{ id: 'c1', name: 'ledger_write', arguments: JSON.stringify({ key: '上次采到', value: '9-5' }) }] },
      { text: '记好了' },
    ];
    await startAgentRun(ctx, '采一下', { agentTemplateId: scout.id, authMode: 'unattended', toolAllowlist: ['ledger_write', 'ledger_read', 'mark_seen'] });
    await settleAgentKicks();
    const sys = h.calls[0].messages[0].content;
    expect(sys).toContain('【你的台账】');
    expect(sys).toContain('盯单：@rival');
    expect(await ledgerGet(ws, 'bot-scout', '上次采到'), '工具没按正在跑的 bot 落格子').toBe('9-5');
    expect(await ledgerGet(ws, ASSISTANT_SLUG, '上次采到')).toBeNull();
  });

  it('🔒 源码：contextForRun 带出模板 slug；startAgentRun 拼 bot 块；SQL 与 RLS 名单都有 AgentLedger', () => {
    const run = strip(read('lib/agent/run.ts'));
    expect(run).toMatch(/select: \{ id: true, status: true, workspaceId: true, accountId: true, memberId: true, agentTemplateId: true \}/);
    expect(run).toMatch(/botSlug: tpl\.slug/);
    expect(run).toMatch(/\+ botBlocks,/);
    expect(fs.existsSync(path.join(process.cwd(), 'prisma/postgres/52-agent-ledger.sql'))).toBe(true);
    expect(read('prisma/postgres/02-rls.sql')).toMatch(/'AgentLedger'\]/);
    for (const p of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) expect(read(p)).toContain('model AgentLedger');
  });
});
