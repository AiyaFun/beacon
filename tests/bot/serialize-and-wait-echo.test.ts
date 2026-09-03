import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { runSerialized } from '@/lib/bot/serialize';

// 2026-09-03 盘查两条：
//   ① 同一个群连发两句 → 两次 handleInbound 并发跑，各自读旧 turns 再 upsert，后写覆盖前写，丢一轮上下文；
//   ② 运行卡在「等插件 / 等额度」时群里不知情（此前只回 done/failed/awaiting_confirm）。

const h = vi.hoisted(() => ({ inflight: 0, maxInflight: 0 }));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    h.inflight++;
    h.maxInflight = Math.max(h.maxInflight, h.inflight);
    await new Promise((r) => setTimeout(r, 30));
    h.inflight--;
    return { text: '答', provider: 'x', model: 'x', mocked: false, promptTokens: 1, completionTokens: 1 };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));
const { handleInbound } = await import('@/lib/bot/router');
const { echoRunToChat, chatRefOf } = await import('@/lib/bot/dispatch');
const botIndex = await import('@/lib/bot/index');

const GROUP = { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1', senderId: 'ou_a', isGroup: true };

beforeEach(async () => {
  h.inflight = 0; h.maxInflight = 0;
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '号', platform: 'douyin', status: 'active' } });
  await prisma.botIntegration.create({ data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'k', pushEvents: '[]', allowCommands: '[]' } });
});

describe('runSerialized', () => {
  it('同 key 串行、异 key 并行；前一个失败不影响后一个', async () => {
    const order: string[] = [];
    const a = runSerialized('k', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); return 1; });
    const b = runSerialized('k', async () => { order.push('b'); return 2; });
    const c = runSerialized('other', async () => { order.push('c'); return 3; });
    expect(await Promise.all([a, b, c])).toEqual([1, 2, 3]);
    expect(order).toEqual(['c', 'a', 'b']);
    await expect(runSerialized('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await runSerialized('k', async () => 4)).toBe(4);
  });
});

describe('同一会话并发的两句', () => {
  it('串行处理：模型调用不重叠，四条 turns 一条不丢', async () => {
    await Promise.all([handleInbound('w1', '/问 第一句', GROUP), handleInbound('w1', '/问 第二句', GROUP)]);
    expect(h.maxInflight).toBe(1);
    const row = await prisma.botConversation.findUniqueOrThrow({ where: { integrationId_chatId: { integrationId: 'bi1', chatId: 'oc_1' } } });
    const turns = JSON.parse(row.turns) as { role: string; content: string }[];
    expect(turns.map((t) => t.content)).toEqual(['第一句', '答', '第二句', '答']);
  });
});

describe('等待态也回群', () => {
  it.each([
    ['waiting_browser', '等浏览器插件'],
    ['waiting_quota', '等额度'],
  ])('%s → 回执说清在等什么', async (status, word) => {
    const send = vi.spyOn(botIndex, 'sendToChat').mockResolvedValue({ ok: true });
    await prisma.agentRun.create({
      data: { id: `r-${status}`, workspaceId: 'w1', accountId: 'a1', memberId: 'm1', goal: '采三个号', status, messages: '[]', botChatRef: chatRefOf('feishu', 'bi1', 'oc_1') },
    });
    expect(await echoRunToChat(`r-${status}`, status)).toBe(true);
    expect(JSON.stringify(send.mock.calls[0][3])).toContain(word);
  });
  it('🔒 afterTransition 对 waiting_* 也调 echoRunToChat', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agent/run.ts'), 'utf8');
    expect(src).toMatch(/\['done', 'failed', 'awaiting_confirm', 'waiting_browser', 'waiting_quota'\]\.includes\(to\)/);
  });
});
