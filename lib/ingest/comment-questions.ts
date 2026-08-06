import { z } from 'zod';
import { prisma } from '../db';
import { PLATFORMS } from '../constants';
import { parseJson } from '../json';
import { isQuestion } from '../topic/sources/questions';
import { isSensitiveTitle } from '../hot/sensitive';
import {
  MAX_COMMENTS_READ, MAX_QUESTIONS_PER_RUN, MIN_LEN, MAX_LEN,
  STALE_DAYS, PURGE_DAYS,
} from '../comment-collect-rules';
import { pruneInspiration } from './inspiration';

// ── zod schema ──
// ⚠️ 刻意不收（写进这里，让下一个人不敢加）：
//    评论者昵称 / 头像 / 用户ID / IP属地 / 评论时间 / 点赞数 / 楼层 / 回复关系 / 评论原文 / 作品 URL

export const commentQuestionsSchema = z.object({
  scope: z.enum(['own', 'rival']),
  platform: z.string().max(32).refine((p) => p in PLATFORMS, { message: '未知平台' }),
  accountId: z.string().max(64).optional(),
  workId: z.string().trim().max(128).optional(),
  workTitle: z.string().trim().max(200).optional(),
  read: z.number().int().min(0).max(MAX_COMMENTS_READ),
  questions: z.array(z.object({
    text: z.string().trim().min(MIN_LEN).max(MAX_LEN),
    count: z.number().int().min(1).max(MAX_COMMENTS_READ),
    variants: z.array(z.string().trim().max(MAX_LEN)).max(3).optional(),
    kind: z.enum(['question', 'demand']).default('question'),
  })).min(1).max(MAX_QUESTIONS_PER_RUN),
});

export type CommentQuestionsPayload = z.infer<typeof commentQuestionsSchema>;

const NOISE_PREFIX = /^[\s\d.、)）:：]*(?:回复\s*[^\s:：]+\s*[:：]?\s*|@[^\s]+\s*)?/;

function normalizeQuestion(text: string): string {
  return text.replace(NOISE_PREFIX, '').trim();
}

const PERSONAL_PATTERNS = [
  /1[3-9]\d{9}/,            // 手机号
  /\S+@\S+\.\S+/,           // 邮箱
  /\d{17}[\dXx]/,            // 身份证
  /[A-Za-z][\w-]{5,19}/,     // 微信号形态
  /IP属地[:：]/,
  /来自\S{2,4}$/,
];

export function looksPersonal(text: string): boolean {
  return PERSONAL_PATTERNS.some((re) => re.test(text));
}

export type IngestCommentResult =
  | { ok: true; created: number; updated: number; total: number }
  | { ok: false; error: string };

export async function ingestCommentQuestions(
  workspaceId: string,
  payload: CommentQuestionsPayload,
): Promise<IngestCommentResult> {
  const source = payload.scope === 'own' ? 'comment' : 'rival-comment';
  const workKey = payload.workId || (payload.workTitle ? `sha:${simpleHash(payload.workTitle)}` : 'unknown');

  let created = 0;
  let updated = 0;

  for (const q of payload.questions) {
    const text = normalizeQuestion(q.text);
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue;
    if (looksPersonal(text)) continue;
    if (!isQuestion(text)) continue;
    if (isSensitiveTitle(text)) continue;

    const existing = await prisma.inspirationItem.findFirst({
      where: { workspaceId, source, title: text },
      select: { id: true, askedBreak: true },
    });

    if (existing) {
      const oldBreak: Record<string, number> = parseJson(existing.askedBreak, {});
      // 合并语义是 max 不是 +=：每次采集是同一批评论的快照，不是增量事件流
      oldBreak[workKey] = Math.max(oldBreak[workKey] ?? 0, q.count);
      const askedCount = Object.values(oldBreak).reduce((s, n) => s + n, 0);
      const askedWorks = Object.keys(oldBreak).length;

      await prisma.inspirationItem.update({
        where: { id: existing.id },
        data: {
          askedBreak: JSON.stringify(oldBreak),
          askedCount,
          askedWorks,
          lastAskedAt: new Date(),
          note: buildNote(q),
          state: 'open',
        },
      });
      updated++;
    } else {
      const breakMap: Record<string, number> = { [workKey]: q.count };
      await prisma.inspirationItem.create({
        data: {
          workspaceId,
          accountId: payload.accountId ?? null,
          title: text,
          note: buildNote(q),
          platform: payload.platform,
          source,
          askedBreak: JSON.stringify(breakMap),
          askedCount: q.count,
          askedWorks: 1,
          lastAskedAt: new Date(),
        },
      });
      created++;
    }
  }

  await pruneInspiration(workspaceId);
  await pruneStaleQuestions(workspaceId);

  const total = await prisma.inspirationItem.count({
    where: { workspaceId, state: 'open', source: { in: ['comment', 'rival-comment'] } },
  });

  return { ok: true, created, updated, total };
}

function buildNote(q: { count: number; variants?: string[]; kind: string }): string {
  const asked = q.count > 1 ? `被问到 ${q.count} 次` : (q.kind === 'demand' ? '读者诉求' : '读者提问');
  const variants = q.variants?.length ? `；其它问法：${q.variants.join(' / ')}` : '';
  return `${asked}${variants}`;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

async function pruneStaleQuestions(workspaceId: string): Promise<{ archived: number; deleted: number }> {
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_DAYS * 86_400_000);
  const purgeCutoff = new Date(now - PURGE_DAYS * 86_400_000);

  const [archiveResult, deleteResult] = await Promise.all([
    prisma.inspirationItem.updateMany({
      where: {
        workspaceId,
        source: { in: ['comment', 'rival-comment'] },
        state: 'open',
        lastAskedAt: { lt: staleCutoff },
      },
      data: { state: 'archived' },
    }),
    prisma.inspirationItem.deleteMany({
      where: {
        workspaceId,
        source: { in: ['comment', 'rival-comment'] },
        state: 'archived',
        lastAskedAt: { lt: purgeCutoff },
      },
    }),
  ]);

  return { archived: archiveResult.count, deleted: deleteResult.count };
}
