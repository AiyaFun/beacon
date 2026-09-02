import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { at, orderedBefore } from '../helpers/anchor';

// 会话画像（2026-09-02）：渠道卡「用户 / 群聊」真数 + 「在哪些群、和谁聊过」抽屉。
// 行为用真库验：touch 的计数/发言人/群名口径，以及 handleInbound 这条单一咽喉真的 touch 了。

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({ text: '（桩）', provider: 'x', model: 'x', mocked: false, promptTokens: 1, completionTokens: 1 }),
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const ROOT = process.cwd();
const { handleInbound } = await import('@/lib/bot/router');
const { touchConversation, parseSenders, MAX_SENDERS } = await import('@/lib/bot/conversation');
const { loadBotChats, summarizeChats } = await import('@/lib/bot/overview');

const KEY = { workspaceId: 'w1', integrationId: 'bi1', chatId: 'cid-group' };

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' } });
  await prisma.botIntegration.create({ data: { id: 'bi1', workspaceId: 'w1', provider: 'dingtalk', label: '钉钉', inboundKey: 'dd1', secretsEnc: '' } });
});

async function row(chatId = 'cid-group') {
  return prisma.botConversation.findUnique({ where: { integrationId_chatId: { integrationId: 'bi1', chatId } } });
}

describe('touchConversation · 口径', () => {
  it('首条建行：类型/群名/计数/发言人；同一人再发计数 +1、名字更新；换人发多一位', async () => {
    await touchConversation(KEY, { chatType: 'group', chatName: '选题作战群', senderId: 'u1', senderName: '张三' });
    let r = await row();
    expect(r).toMatchObject({ chatType: 'group', chatName: '选题作战群', msgCount: 1 });
    expect(parseSenders(r!.senders)).toEqual([expect.objectContaining({ id: 'u1', name: '张三', n: 1 })]);
    // 画像行不是对话轮：turnsAt 留在纪元起点，TTL 才不会把「刚来过一条命令」当成对话续上
    expect(r!.turnsAt.getTime()).toBe(0);

    await touchConversation(KEY, { chatType: 'group', senderId: 'u1', senderName: '张三丰' });
    await touchConversation(KEY, { chatType: 'group', senderId: 'u2' });
    r = await row();
    expect(r!.msgCount).toBe(3);
    const senders = parseSenders(r!.senders);
    expect(senders.find((s) => s.id === 'u1')).toMatchObject({ n: 2, name: '张三丰' });
    expect(senders.find((s) => s.id === 'u2')).toMatchObject({ n: 1 });
    // 群名拿不到时保留旧值（飞书事件里没有群名，同步补的那份不能被空值冲掉）
    expect(r!.chatName).toBe('选题作战群');
  });

  it('私聊没有群名：对话名用发言人名，列表里才不是一串 id', async () => {
    await touchConversation({ ...KEY, chatId: 'p2p-1' }, { chatType: 'p2p', senderId: 'u9', senderName: '李四' });
    expect((await row('p2p-1'))!.chatName).toBe('李四');
  });

  it('🔒 发言人封顶 200：淘汰最久没说话的，不是最新的', async () => {
    for (let i = 0; i < MAX_SENDERS + 1; i++) {
      await touchConversation(KEY, { chatType: 'group', senderId: `s${i}` }, new Date(1_000_000 + i * 1000));
    }
    const senders = parseSenders((await row())!.senders);
    expect(senders.length).toBe(MAX_SENDERS);
    expect(senders.some((s) => s.id === 's0'), '最早的那位该被淘汰').toBe(false);
    expect(senders.some((s) => s.id === `s${MAX_SENDERS}`), '最新的那位必须在').toBe(true);
  });

  it('集成不存在（外键挂）也不抛——画像是增强，不是回话的前提', async () => {
    await expect(touchConversation({ ...KEY, integrationId: 'nope' }, { chatType: 'group', senderId: 'u1' })).resolves.toBeUndefined();
  });
});

describe('handleInbound · 单一咽喉真的 touch 了', () => {
  it('钉钉群里一条 /热点：画像行有群名、类型、发言人；overview 汇总出 1 群 1 用户', async () => {
    const reply = await handleInbound('w1', '/热点', {
      provider: 'dingtalk', integrationId: 'bi1', chatId: 'cid-group', senderId: 'staff-1', senderName: '王五', isGroup: true, chatName: '运营群',
    });
    expect(reply).toMatch(/热榜/);
    const r = await row();
    expect(r).toMatchObject({ chatType: 'group', chatName: '运营群', msgCount: 1 });
    expect(parseSenders(r!.senders)[0]).toMatchObject({ id: 'staff-1', name: '王五' });

    const chats = (await loadBotChats('w1')).get('bi1') ?? [];
    expect(chats.length).toBe(1);
    expect(chats[0]).toMatchObject({ chatName: '运营群', chatType: 'group', msgCount: 1, accountName: null });
    expect(summarizeChats(chats)).toEqual({ users: 1, groups: 1, p2p: 0 });
  });

  it('绑了账号的群，overview 带出账号名', async () => {
    await handleInbound('w1', '/账号 测试号', { provider: 'dingtalk', integrationId: 'bi1', chatId: 'cid-group', senderId: 'staff-1', isGroup: true });
    const chats = (await loadBotChats('w1')).get('bi1') ?? [];
    expect(chats[0]?.accountName).toBe('测试号');
  });
});

describe('会话画像 · 接线口径（源码级）', () => {
  it('🔒 router 在读会话状态之前 touch（所有渠道单一咽喉，别在各 route 各记各的）', () => {
    const src = readFileSync(join(ROOT, 'lib/bot/router.ts'), 'utf8');
    const fn = src.slice(at(src, 'export async function handleInbound'), src.length);
    orderedBefore(fn, 'touchConversation(key', 'loadConversation(key)');
    expect(fn).toContain('chatName: ctx.chatName');
  });

  it('🔒 钉钉回调的 conversationTitle 进了 chatName', () => {
    const src = readFileSync(join(ROOT, 'app/api/bot/dingtalk/events/[key]/route.ts'), 'utf8');
    at(src, 'payload?.conversationTitle');
    expect(src).toMatch(/chatName,?\s*\n?\s*\}\)/);
  });

  it('🔒 飞书列群带名字，同步 action 按群 upsert 且只写不删', () => {
    const f = readFileSync(join(ROOT, 'lib/bot/feishu.ts'), 'utf8');
    const fn = f.slice(at(f, 'export async function feishuListBotChats'), at(f, 'export async function feishuBotOpenId'));
    expect(fn).toContain('name: String(c.name');
    const act = readFileSync(join(ROOT, 'app/(app)/settings/bot-actions.ts'), 'utf8');
    const sync = act.slice(at(act, 'export async function actSyncBotChats'), at(act, '// ── 微信（官方 iLink'));
    expect(sync).toContain("chatType: 'group'");
    expect(sync).toContain('botConversation.upsert');
    expect(sync).not.toContain('deleteMany');
  });

  it('🔒 两份 schema 与生产 SQL 都有五列', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const seg = /model BotConversation \{[\s\S]*?\n\}/.exec(readFileSync(join(ROOT, f), 'utf8'))?.[0] ?? '';
      for (const col of ['chatType', 'chatName', 'msgCount', 'lastMessageAt', 'senders']) expect(seg, `${f} 少了 ${col}`).toContain(col);
    }
    const sql = readFileSync(join(ROOT, 'prisma/postgres/47-bot-conversation-profile.sql'), 'utf8');
    for (const col of ['chatType', 'chatName', 'msgCount', 'lastMessageAt', 'senders']) expect(sql).toContain(`"${col}"`);
  });

  it('🔒 客户端组件只从 chat-summary 拿类型与汇总，不碰 overview（那里 import 了 prisma）', () => {
    for (const f of ['app/(app)/settings/BotIntegrationCard.tsx', 'app/(app)/settings/BotChatsDialog.tsx']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, `${f} 把 lib/bot/overview 拖进了客户端包`).not.toMatch(/from '@\/lib\/bot\/overview'/);
    }
  });
});
