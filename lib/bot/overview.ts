import { prisma } from '../db';
import { parseSenders } from './conversation';
import type { BotChatRow, ChatType } from './chat-summary';

export { summarizeChats, type BotChatRow, type SenderStat, type ChatType } from './chat-summary';

// 渠道页的「会话画像」读取（2026-09-02）：每个机器人在哪些群、和哪些人聊过。
// 两张页面（/notifications、/settings/keys）共用，别各自再写一遍查询。


/** 每个机器人最多带多少个会话到页面——真有几百个群的租户，列表里看最近活跃的就够 */
export const MAX_CHATS_PER_BOT = 200;

export async function loadBotChats(workspaceId: string): Promise<Map<string, BotChatRow[]>> {
  const rows = await prisma.botConversation.findMany({
    where: { workspaceId },
    orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    select: {
      integrationId: true, chatId: true, chatType: true, chatName: true, msgCount: true, lastMessageAt: true, accountId: true, senders: true,
    },
  });
  const accountIds = [...new Set(rows.map((r) => r.accountId).filter((x): x is string => !!x))];
  const accounts = accountIds.length
    ? await prisma.creatorAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true } })
    : [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));

  const out = new Map<string, BotChatRow[]>();
  for (const r of rows) {
    const list = out.get(r.integrationId) ?? [];
    if (list.length >= MAX_CHATS_PER_BOT) continue;
    list.push({
      chatId: r.chatId,
      chatType: (r.chatType as ChatType) || 'unknown',
      chatName: r.chatName,
      msgCount: r.msgCount,
      lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
      accountName: r.accountId ? accountName.get(r.accountId) ?? null : null,
      senders: parseSenders(r.senders),
    });
    out.set(r.integrationId, list);
  }
  return out;
}
