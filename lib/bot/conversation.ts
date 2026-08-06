import { prisma } from '../db';
import { parseJson, toJson } from '../json';

// 群内对话的上下文存取（需求：群里 @机器人 可以连着聊）。
//
// 三条口径，都是为了「群聊」这个场景本身：
//   ① 上下文按 (集成, 会话) 存，不按人存 —— 群里是几个人对着同一个机器人说话，
//      A 问「那第二条呢」接的是 B 刚才那句，这才是群聊的语义。
//   ② 静默超过 TTL 视为新会话。群消息稀疏，隔天的「它」和今天的「它」不是一个东西，
//      续上只会让机器人答非所问。
//   ③ 只留最近 MAX_TURNS 条、每条截断 MAX_TURN_CHARS。上下文是给模型看的工作记忆，
//      不是聊天记录归档——真正该沉淀的结论走 lib/memory。

export type BotTurn = { role: 'user' | 'assistant'; content: string };

export const BOT_CHAT_TTL_MS = 60 * 60 * 1000; // 静默 1 小时 → 下次是新会话
export const MAX_TURNS = 8; // 最近 4 轮问答
export const MAX_TURN_CHARS = 800;

// 会话定位键。缺 integrationId/chatId（如单测直接调 handleInbound）→ 无状态模式：
// 照常回话，只是不记上下文，绝不因为存不下就报错。
export type ChatKey = { workspaceId: string; integrationId?: string; chatId?: string };

export type ConversationState = {
  /** 本群绑定的账号；null = 未绑定 */
  accountId: string | null;
  /** TTL 内的历史轮次（超时返回空数组） */
  turns: BotTurn[];
};

const EMPTY: ConversationState = { accountId: null, turns: [] };

function keyOf(k: ChatKey): { integrationId: string; chatId: string } | null {
  if (!k.integrationId || !k.chatId) return null;
  return { integrationId: k.integrationId, chatId: k.chatId };
}

export function trimTurns(turns: BotTurn[]): BotTurn[] {
  return turns
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
    .slice(-MAX_TURNS)
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) }));
}

export async function loadConversation(k: ChatKey, now = Date.now()): Promise<ConversationState> {
  const id = keyOf(k);
  if (!id) return EMPTY;
  const row = await prisma.botConversation
    .findUnique({ where: { integrationId_chatId: { integrationId: id.integrationId, chatId: id.chatId } } })
    .catch(() => null);
  if (!row) return { accountId: null, turns: [] };

  const fresh = now - row.turnsAt.getTime() < BOT_CHAT_TTL_MS;
  return {
    // 账号绑定不随 TTL 过期：那是「这个群管的是哪个号」，是配置不是上下文
    accountId: row.accountId,
    turns: fresh ? trimTurns(parseJson<BotTurn[]>(row.turns, [])) : [],
  };
}

/** 追加一轮问答。整体 try/catch：存不下上下文不许影响已经生成好的回复。 */
export async function appendTurns(k: ChatKey, add: BotTurn[], prev: BotTurn[], now = new Date()): Promise<void> {
  const id = keyOf(k);
  if (!id) return;
  const turns = trimTurns([...prev, ...add]);
  try {
    await prisma.botConversation.upsert({
      where: { integrationId_chatId: { integrationId: id.integrationId, chatId: id.chatId } },
      create: {
        workspaceId: k.workspaceId,
        integrationId: id.integrationId,
        chatId: id.chatId,
        turns: toJson(turns),
        turnsAt: now,
      },
      update: { turns: toJson(turns), turnsAt: now },
    });
  } catch {
    // 忽略：上下文是增强，不是回话的前提
  }
}

/** 绑定/解绑本群当前账号（accountId=null 解绑）。 */
export async function bindConversationAccount(k: ChatKey, accountId: string | null): Promise<boolean> {
  const id = keyOf(k);
  if (!id) return false;
  try {
    await prisma.botConversation.upsert({
      where: { integrationId_chatId: { integrationId: id.integrationId, chatId: id.chatId } },
      create: { workspaceId: k.workspaceId, integrationId: id.integrationId, chatId: id.chatId, accountId },
      update: { accountId },
    });
    return true;
  } catch {
    return false;
  }
}

/** 清空上下文（/重置）。账号绑定保留。 */
export async function resetConversation(k: ChatKey): Promise<void> {
  const id = keyOf(k);
  if (!id) return;
  await prisma.botConversation
    .updateMany({
      where: { integrationId: id.integrationId, chatId: id.chatId },
      data: { turns: '[]', turnsAt: new Date(0) },
    })
    .catch(() => {});
}
