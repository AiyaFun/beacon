import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { writeBotSecrets, updateChatMessage } from '@/lib/bot';
import { startProgressCard, updateProgressCard, renderProgressCard, __resetProgressThrottle } from '@/lib/bot/progress';

// 群里派出的任务进度卡（2026-09-03，学 Hermes gateway：能编辑消息的渠道就地改，不能的不刷屏）。
// 此前跑几分钟的任务中间是黑箱；现在飞书上一张卡从「排队中」改到「正在跑 · 已走 N 步」再改到终态。

const calls: { url: string; method: string; body: any }[] = [];
function stubFetch() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const reply = url.includes('tenant_access_token') ? { tenant_access_token: 'tk' }
      : url.includes('/im/v1/messages') && init?.method === 'POST' ? { code: 0, data: { message_id: 'om_card_1' } }
      : { code: 0 };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}
const REF = 'feishu:bi1:oc_1';
async function mkRun(id: string, status = 'queued', extra: Record<string, unknown> = {}) {
  return prisma.agentRun.create({ data: { id, workspaceId: 'w1', accountId: 'a1', memberId: 'm1', goal: '把三个竞对号采一遍', status, messages: '[]', botChatRef: REF, ...extra } });
}

beforeEach(async () => {
  calls.length = 0;
  __resetProgressThrottle();
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '号', platform: 'douyin', status: 'active' } });
  await prisma.botIntegration.create({ data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_app', secretsEnc: writeBotSecrets({ appSecret: 'sec' }), pushEvents: '[]' } });
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('startProgressCard', () => {
  it('派出时发一张「已排队」卡到派它的群，并把 message_id 记到运行上', async () => {
    await mkRun('r1');
    expect(await startProgressCard('r1')).toBe(true);
    const send = calls.find((c) => c.url.includes('/im/v1/messages?') && c.method === 'POST');
    expect(send?.body.receive_id).toBe('oc_1');
    expect(send?.body.msg_type).toBe('interactive');
    expect(send?.body.content).toContain('任务已排队');
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: 'r1' } })).botMessageId).toBe('om_card_1');
  });
  it('站内派的（无 botChatRef）不发', async () => {
    await mkRun('r2', 'queued', { botChatRef: null });
    expect(await startProgressCard('r2')).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('updateProgressCard', () => {
  it('就地 PATCH 同一条消息：状态 + 已走几步 + 最近一步；节流 10 秒，状态迁移强制', async () => {
    await mkRun('r3', 'running', { botMessageId: 'om_card_1' });
    await prisma.agentStep.create({ data: { runId: 'r3', seq: 1, kind: 'tool', tool: 'list_drafts', args: '{}', result: '', ok: true } });
    await prisma.agentStep.create({ data: { runId: 'r3', seq: 2, kind: 'tool', tool: 'collect_competitor', args: '{}', result: '', ok: false } });
    const t0 = 1_000_000;
    expect(await updateProgressCard('r3', { now: t0 })).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain('/im/v1/messages/om_card_1');
    expect(patch?.body.content).toContain('正在跑');
    expect(patch?.body.content).toContain('已走 2 步');
    expect(patch?.body.content).toContain('collect_competitor（失败）');
    // 节流：10 秒内再来一次不打接口
    calls.length = 0;
    expect(await updateProgressCard('r3', { now: t0 + 5000 })).toBe(false);
    expect(calls).toHaveLength(0);
    // 状态迁移：强制更新
    await prisma.agentRun.update({ where: { id: 'r3' }, data: { status: 'done', answer: '三个号都采完了' } });
    expect(await updateProgressCard('r3', { now: t0 + 5000, force: true })).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')?.body.content).toContain('跑完了');
  });
  it('没记到消息 id 的运行（别的渠道）什么都不做', async () => {
    await mkRun('r4', 'running');
    expect(await updateProgressCard('r4', { force: true })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('updateChatMessage', () => {
  it('非飞书渠道如实说不支持，不发请求', async () => {
    await prisma.botIntegration.create({ data: { id: 'bi2', workspaceId: 'w1', provider: 'wecom', label: 'W', inboundKey: 'ww', secretsEnc: writeBotSecrets({ corpId: 'c', appSecret: 's', agentId: '1' }), pushEvents: '[]' } });
    const r = await updateChatMessage('w1', 'bi2', 'x', { kind: 'card', title: 't', lines: ['l'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不支持编辑');
    expect(calls).toHaveLength(0);
  });
});

describe('renderProgressCard', () => {
  it('每个状态有自己的标题；终态带答案/错误', () => {
    const base = { id: 'r', goal: '写一篇秋季穿搭笔记', status: 'queued' };
    expect(renderProgressCard(base, { steps: 0 }).title).toContain('已排队');
    expect(renderProgressCard({ ...base, status: 'failed', error: '模型超时' }, { steps: 3 }).lines.join('\n')).toContain('模型超时');
    expect(renderProgressCard({ ...base, status: 'waiting_browser' }, { steps: 1 }).title).toContain('等浏览器插件');
    expect(renderProgressCard({ ...base, goal: 'x'.repeat(80), status: 'running' }, { steps: 1 }).title.length).toBeLessThan(60);
  });
});

describe('🔒 接线', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('记步骤的咽喉与状态迁移的咽喉都接了进度卡；两条派出路都起卡', () => {
    const run = read('lib/agent/run.ts');
    expect(run).toMatch(/m\.updateProgressCard\(runId\)\)/);            // appendStep：节流更新
    expect(run).toMatch(/m\.updateProgressCard\(runId, \{ force: true \}\)/); // afterTransition：强制
    const d = read('lib/bot/dispatch.ts');
    expect(d.match(/m\.startProgressCard\(/g)?.length).toBe(2);
  });
  it('两份 schema 与 50 号 SQL 都有 AgentRun.botMessageId', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const seg = /model AgentRun \{[\s\S]*?\n\}/.exec(read(f))?.[0] ?? '';
      expect(seg, f).toContain('botMessageId');
    }
    expect(read('prisma/postgres/50-agent-run-bot-message.sql')).toContain('"botMessageId"');
  });
});
