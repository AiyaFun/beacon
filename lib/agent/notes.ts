import { prisma } from '../db';
import type { ChatMessage } from '../llm/types';

// ── 跑着跑着又说一句话 ────────────────────────────────────────────────────────
//
// 在此之前，一次执行是**一句话定终身**：派出去之后用户再想补一句「顺便看看小红书那边」，
// 只能等它跑完、再重新派一次——而重新派的那次不知道前面查过什么，从零开始。
//
// 【三个消费点，缺一个就会丢话】
//   ① 每轮开头（持租约时）—— 正常情况下的消费点
//   ② 转「等你确认」之前 —— 确认卡上的附言要跟着这次决定一起送进去
//   ③ 到终态之前       —— 最后一轮之后到达的那句话，不在这里排干就永远没人读
// 只做①的话，用户在「就快跑完了」那一刻打的字会石沉大海：不报错、界面上也看不出来。

const MAX_NOTE_CHARS = 1000;

/** 记一句用户中途说的话。纯 insert，与后台循环无锁竞争。 */
export async function appendNote(runId: string, text: string): Promise<void> {
  const t = text.trim().slice(0, MAX_NOTE_CHARS);
  if (!t) return;
  await prisma.agentRunNote.create({ data: { runId, text: t } });
}

/**
 * 把还没送达的那些排干，返回要插进对话的消息。
 *
 * **先标记再返回**：标记失败就当没读到（用户那句话还在，下一轮再来）；
 * 反过来先返回后标记的话，中间崩一次就会把同一句话送两遍。
 */
export async function drainNotes(runId: string): Promise<ChatMessage[]> {
  const pending = await prisma.agentRunNote.findMany({
    where: { runId, consumedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, text: true },
  });
  if (pending.length === 0) return [];

  const now = new Date();
  const claimed = await prisma.agentRunNote.updateMany({
    where: { id: { in: pending.map((n) => n.id) }, consumedAt: null },
    data: { consumedAt: now },
  });
  if (claimed.count === 0) return []; // 别人抢先消费了

  return pending.map((n) => ({
    role: 'user' as const,
    // 标明是「中途补充的」：不说的话，模型会把它当成对上一条工具结果的回应，
    // 容易理解成「用户在纠正我刚才那一步」，而其实他只是想起来还有件事
    content: `【用户补充】${n.text}`,
  }));
}

/** 还有几句没送达。界面上要标出来——用户以为说了就生效了。 */
export async function pendingNoteCount(runId: string): Promise<number> {
  return prisma.agentRunNote.count({ where: { runId, consumedAt: null } });
}
