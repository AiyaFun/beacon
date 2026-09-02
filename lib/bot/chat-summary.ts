// 会话画像的**纯类型与纯函数**（2026-09-02）。客户端组件（渠道卡、群聊抽屉）也要用，
// 所以这里不能 import prisma——读库的在 lib/bot/overview.ts，写库的在 lib/bot/conversation.ts。

export type SenderStat = { id: string; name?: string; n: number; at: string };
export type ChatType = 'group' | 'p2p' | 'unknown';

export type BotChatRow = {
  chatId: string;
  chatType: ChatType;
  chatName: string | null;
  msgCount: number;
  lastMessageAt: string | null;
  /** 本群绑定的创作者账号名（/账号 切的那个）；null = 未绑定 */
  accountName: string | null;
  senders: SenderStat[];
};

/** 一个渠道（同 provider 的多个机器人）汇总：去重用户数 / 群数 / 私聊数。全是真数。 */
export function summarizeChats(chats: BotChatRow[]): { users: number; groups: number; p2p: number } {
  const users = new Set<string>();
  let groups = 0;
  let p2p = 0;
  for (const c of chats) {
    for (const s of c.senders) users.add(s.id);
    if (c.chatType === 'group') groups++;
    else if (c.chatType === 'p2p') p2p++;
  }
  return { users: users.size, groups, p2p };
}
