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
  /** 本会话选中的智能体（WorkflowTemplate.id）；null = 用渠道默认 */
  agentTemplateId: string | null;
  /** TTL 内的历史轮次（超时返回空数组） */
  turns: BotTurn[];
};

const EMPTY: ConversationState = { accountId: null, agentTemplateId: null, turns: [] };

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
  if (!row) return { accountId: null, agentTemplateId: null, turns: [] };

  const fresh = now - row.turnsAt.getTime() < BOT_CHAT_TTL_MS;
  return {
    // 账号绑定不随 TTL 过期：那是「这个群管的是哪个号」，是配置不是上下文
    accountId: row.accountId,
    // 智能体选择同理：切过就一直是它，直到再切或「/智能体 默认」
    agentTemplateId: row.agentTemplateId,
    turns: fresh ? trimTurns(parseJson<BotTurn[]>(row.turns, [])) : [],
  };
}

// ── 会话画像（2026-09-02）：每条入站消息 touch 一次 ──
//
// 渠道卡要回答「多少用户、多少群、具体是哪些群」——这张表以前只在对话轮追加或绑账号时才写，
// 一个只发 /热点 的群根本没有行，「群会话」数一直偏低。现在 router.handleInbound 是所有渠道的单一咽喉，
// 在那里 touch 一次：会话类型、群名（拿得到的渠道才有）、发言人集合、消息计数、最近时间。

import type { SenderStat, ChatType } from './chat-summary';
export type { SenderStat, ChatType };
/** 一个会话最多记多少位发言人——大群里几百人只是路过，记最近活跃的就够 */
export const MAX_SENDERS = 200;

export function parseSenders(raw: string | null | undefined): SenderStat[] {
  return parseJson<SenderStat[]>(raw ?? '[]', []).filter((x) => x && typeof x.id === 'string');
}

export async function touchConversation(
  k: ChatKey,
  info: { chatType: ChatType; chatName?: string; senderId?: string; senderName?: string },
  now = new Date(),
): Promise<void> {
  const id = keyOf(k);
  if (!id) return;
  const chatName = (info.chatName ?? '').trim().slice(0, 80) || undefined;
  const senderName = (info.senderName ?? '').trim().slice(0, 40) || undefined;
  try {
    const row = await prisma.botConversation.findUnique({
      where: { integrationId_chatId: { integrationId: id.integrationId, chatId: id.chatId } },
      select: { chatType: true, chatName: true, senders: true },
    });
    let senders: SenderStat[] = row ? parseSenders(row.senders) : [];
    if (info.senderId) {
      const hit = senders.find((x) => x.id === info.senderId);
      if (hit) {
        hit.n += 1;
        hit.at = now.toISOString();
        if (senderName) hit.name = senderName;
      } else {
        senders.push({ id: info.senderId, ...(senderName ? { name: senderName } : {}), n: 1, at: now.toISOString() });
      }
      if (senders.length > MAX_SENDERS) {
        senders = senders.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, MAX_SENDERS);
      }
    }
    // 类型：unknown 可以被任何明确值覆盖；明确值之间以最新为准（钉钉同一 chatId 不会变类型，这只是防御）
    const chatType: ChatType = info.chatType === 'unknown' ? ((row?.chatType as ChatType) ?? 'unknown') : info.chatType;
    // 群名：拿得到才更新，拿不到保留旧值（飞书消息事件里没有群名，靠同步补的那份不能被空值冲掉）
    const data = {
      chatType,
      ...(chatName ? { chatName } : {}),
      // 私聊没有群名：用发言人名当对话名，列表里才不是一串 open_id
      ...(!chatName && !row?.chatName && info.chatType === 'p2p' && senderName ? { chatName: senderName } : {}),
      senders: toJson(senders),
      msgCount: { increment: 1 },
      lastMessageAt: now,
    };
    if (row) {
      await prisma.botConversation.update({
        where: { integrationId_chatId: { integrationId: id.integrationId, chatId: id.chatId } },
        data,
      });
    } else {
      await prisma.botConversation.create({
        data: {
          workspaceId: k.workspaceId,
          integrationId: id.integrationId,
          chatId: id.chatId,
          chatType,
          chatName: chatName ?? (info.chatType === 'p2p' ? senderName : undefined),
          senders: toJson(senders),
          msgCount: 1,
          lastMessageAt: now,
          // 画像行不是对话轮：turnsAt 留在纪元起点，TTL 判断才不会把「刚来过一条命令」当成对话续上
          turnsAt: new Date(0),
        },
      });
    }
  } catch {
    // 画像是增强，不是回话的前提——存不下不许影响回复
  }
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

/** 选定/清除本会话当前智能体（agentTemplateId=null 回到渠道默认）。 */
export async function bindConversationAgent(k: ChatKey, agentTemplateId: string | null): Promise<boolean> {
  const id = keyOf(k);
  if (!id) return false;
  try {
    await prisma.botConversation.upsert({
      where: { integrationId_chatId: { integrationId: id.integrationId, chatId: id.chatId } },
      create: { workspaceId: k.workspaceId, integrationId: id.integrationId, chatId: id.chatId, agentTemplateId },
      update: { agentTemplateId },
    });
    return true;
  } catch {
    return false;
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
