import crypto from 'node:crypto';
import { prisma } from '../db';
import { isSensitiveTitle } from '../hot/sensitive';
import {
  MIN_LEN, MAX_COMMENT_TEXT_LEN,
  COMMENT_TEXT_PURGE_DAYS, MAX_READER_COMMENTS_PER_WORKSPACE,
} from '../comment-collect-rules';
import { looksPersonal } from './comment-questions';

// 读者原声入库——评论正文那条链路。
//
// 与同目录的 comment-questions.ts 是**两条链路**，代码上也刻意分开（理由见
// lib/comment-collect-rules.ts 与 prisma/schema.prisma 的 ReaderComment 注释）：
// 提问会进选题候选池、喂进 AI，所以有 ≥2 人问过的门槛；正文只给用户自己读和做统计，
// 所以能逐条留存，但换来保留期、不进语料池、随移除申请删、不导出四条护栏。
//
// ⚠️ 这里的每一道闸都必须在**服务端**再跑一遍，哪怕插件已经跑过：
// 用户装的是本地的旧版本插件，随时可能没有其中任何一条（同 MIN_ASKED_TO_STORE 那道闸的教训）。

export const KINDS = ['question', 'demand', 'praise', 'complaint', 'other'] as const;
export type CommentKind = (typeof KINDS)[number];

// zod 校验在 comment-questions.ts 的 commentQuestionsSchema 里（同一个 payload 一份 schema）。
// 这里只声明类型，避免 comment-questions ↔ reader-comments 互相 import 成环
//（PERSONAL_PATTERNS 必须留在 comment-questions.ts：tests/ingest/comment-classifier-sync.test.ts
// 是按**文件路径读源码文本**比对插件那份手抄副本的，挪走它测试直接找不到）。
export type ReaderCommentInput = { text: string; kind?: string }[];

function normalizeKind(kind: string | undefined): CommentKind {
  return (KINDS as readonly string[]).includes(kind ?? '') ? (kind as CommentKind) : 'other';
}

// 去重键。归一化掉空白与常见标点再哈希：同一条评论在不同次采集里可能带不同的尾随空格，
// 不归一就会被当成两条，用户看到同一句话重复出现。
export function commentTextHash(text: string): string {
  const cleaned = text.replace(/[\s、,，。.!！?？~～…]+/g, '').toLowerCase();
  return crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 32);
}

export type ReaderCommentMeta = {
  scope: 'own' | 'rival';
  platform: string;
  author: string | null;
  accountId: string | null;
  workKey: string;
  workTitle: string | null;
};

export async function ingestReaderComments(
  workspaceId: string,
  meta: ReaderCommentMeta,
  comments: ReaderCommentInput,
): Promise<{ stored: number; skipped: number }> {
  let stored = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const c of comments) {
    const text = c.text.trim();
    // 长度：下限同提问（太短的「哈哈」「+1」没有信息量，还容易是表情残渣）；
    // 上限比提问宽得多——长评论往往正是信息量最大的那几条。
    if (text.length < MIN_LEN || text.length > MAX_COMMENT_TEXT_LEN + 1) { skipped++; continue; }
    // PII 命中整条丢弃，不脱敏不截断（同 comment-questions.ts 的理由：留一半更危险）
    if (looksPersonal(text)) { skipped++; continue; }
    // 敏感词：命中的评论不落库。用户看不到它，也就不会把它当素材用。
    if (isSensitiveTitle(text)) { skipped++; continue; }

    const textHash = commentTextHash(text);
    // 同一批里重复：唯一索引也会挡，但先挡一道能少发一堆必然冲突的写
    if (seen.has(textHash)) { skipped++; continue; }
    seen.add(textHash);

    // 重复采集是**覆盖不是累加**（同 askedBreak 的 max 语义）：同一条作品下同一句话只留一行。
    // collectedAt 跟着刷新——它同时是保留期的锚点，「上周采过、这周还在」应该重新计时。
    await prisma.readerComment.upsert({
      where: {
        workspaceId_platform_workKey_textHash: {
          workspaceId, platform: meta.platform, workKey: meta.workKey, textHash,
        },
      },
      create: {
        workspaceId,
        accountId: meta.accountId,
        platform: meta.platform,
        scope: meta.scope,
        author: meta.author,
        workKey: meta.workKey,
        workTitle: meta.workTitle,
        text,
        kind: normalizeKind(c.kind),
        textHash,
      },
      update: {
        kind: normalizeKind(c.kind),
        collectedAt: new Date(),
        // 作品标题可能这次才采到（上次是 null）；账号归属同理，别把已知的覆盖成 null
        ...(meta.workTitle ? { workTitle: meta.workTitle } : {}),
        ...(meta.accountId ? { accountId: meta.accountId } : {}),
      },
    });
    stored++;
  }

  await purgeExpiredComments(workspaceId);
  await enforceWorkspaceCap(workspaceId);

  return { stored, skipped };
}

// 保留期：到期**物理删除**，不是归档。
// 提问短句是需求信号，归档留着还有意义；别人说过的话到期就该消失——
// 这是隐私政策里写死的那句话，不是可调参数。
export async function purgeExpiredComments(workspaceId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - COMMENT_TEXT_PURGE_DAYS * 86_400_000);
  const r = await prisma.readerComment.deleteMany({
    where: { collectedAt: { lt: cutoff }, ...(workspaceId ? { workspaceId } : {}) },
  });
  return r.count;
}

// 工作区配额：超出上限时删最旧的。
// 没有它，一个把每条作品都采一遍的重度用户能把这张表撑到几十万行——
// 而「读者原声」是给人读的，越旧越没人看，留着只是在延长第三方 UGC 的留存面。
async function enforceWorkspaceCap(workspaceId: string): Promise<number> {
  const total = await prisma.readerComment.count({ where: { workspaceId } });
  if (total <= MAX_READER_COMMENTS_PER_WORKSPACE) return 0;
  const excess = total - MAX_READER_COMMENTS_PER_WORKSPACE;
  const oldest = await prisma.readerComment.findMany({
    where: { workspaceId },
    orderBy: { collectedAt: 'asc' },
    take: excess,
    select: { id: true },
  });
  if (oldest.length === 0) return 0;
  const r = await prisma.readerComment.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
  return r.count;
}
