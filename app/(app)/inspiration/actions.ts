'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { ingestInspiration, inspirationPayloadSchema } from '@/lib/ingest/inspiration';
import { extractQuestions, questionToInspiration } from '@/lib/topic/sources/questions';

// 灵感收集箱 · 网页端操作。插件那条路走 /api/ingest/inspiration（令牌鉴权），
// 这里是登录态下的手动录入与状态管理，两条路写同一张表。

export async function actAddInspiration(input: {
  title: string;
  note?: string;
  url?: string;
  author?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  const parsed = inspirationPayloadSchema.safeParse({
    title: input.title,
    // 空串要变 undefined：zod 的 .url() 对空串会报错，而「没填链接」是完全正常的
    note: input.note?.trim() || undefined,
    url: input.url?.trim() || undefined,
    author: input.author?.trim() || undefined,
    source: 'manual',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? '格式不合法' };

  // 网页端录入归到当前账号：用户是在某个账号的上下文里记的这一笔。
  // （插件回传没有账号上下文，落 null = 工作区共享，两种都能被推荐取到。）
  const r = await ingestInspiration(s.workspaceId, parsed.data, s.accountId);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath('/inspiration');
  revalidatePath('/library');
  return { ok: true };
}

// 从粘贴的评论里挖读者提问，逐条存进收集箱。
//
// ─────────────────── 为什么是「粘贴」而不是插件自动采 ───────────────────
// 自动抓评论区（尤其是同行的）有两道各自独立的坎：
//   1) **合规**：评论是第三方写的 UGC，批量抓取入库涉及个人信息与内容权属，需要法务判断；
//   2) **工程**：各平台评论区的 DOM 结构各不相同，没有真机页面就只能猜选择器。
// 而「用户自己浏览、自己复制、一页一次、只留去身份化的问题短句」这条路两道坎都不沾：
// 没有爬虫、没有批量、没有作者身份，存下来的只是一句「这个多少钱」这样的事实性短句。
//
// scope 区分自有/同行：两者解读方式不同（见 lib/ingest/inspiration.ts 的 source 注释）。
export async function actMineQuestions(
  raw: string,
  scope: 'own' | 'rival' = 'own',
): Promise<{ ok: boolean; created?: number; found?: number; error?: string }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  const text = (raw ?? '').trim();
  if (text.length < 10) return { ok: false, error: '内容太短，请把评论区的文字整段粘进来' };
  if (text.length > 40_000) return { ok: false, error: '一次最多 4 万字，请分批粘贴' };

  const questions = extractQuestions(text);
  if (questions.length === 0) {
    return { ok: false, error: '没挖到提问句。判定刻意从严——宁可漏掉几条，也不把陈述句当成问题灌进选题池。' };
  }

  const source = scope === 'rival' ? ('rival-comment' as const) : ('comment' as const);
  let created = 0;
  for (const q of questions) {
    const { title, note } = questionToInspiration(q);
    // 逐条走同一个入库函数：上限裁剪、去重、状态都复用，不另开一套
    const r = await ingestInspiration(s.workspaceId, { title, note, source }, s.accountId);
    if (r.ok && !r.duplicate) created++;
  }
  revalidatePath('/inspiration');
  revalidatePath('/library');
  return { ok: true, created, found: questions.length };
}

// 归档：不再进候选池，但保留记录（与删除区分开——用户可能只是暂时不想看到它）
export async function actArchiveInspiration(id: string): Promise<{ ok: boolean }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  await prisma.inspirationItem.updateMany({
    where: { id, workspaceId: s.workspaceId },
    data: { state: 'archived' },
  });
  revalidatePath('/inspiration');
  revalidatePath('/library');
  return { ok: true };
}

export async function actRestoreInspiration(id: string): Promise<{ ok: boolean }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  await prisma.inspirationItem.updateMany({
    where: { id, workspaceId: s.workspaceId },
    data: { state: 'open', usedAt: null },
  });
  revalidatePath('/inspiration');
  revalidatePath('/library');
  return { ok: true };
}

export async function actDeleteInspiration(id: string): Promise<{ ok: boolean }> {
  const s = await getSession();
  requireRole(s, 'topic.manage');
  // workspaceId 同时入 where：防止拿到别的工作区的 id 就能删
  await prisma.inspirationItem.deleteMany({ where: { id, workspaceId: s.workspaceId } });
  revalidatePath('/inspiration');
  revalidatePath('/library');
  return { ok: true };
}
