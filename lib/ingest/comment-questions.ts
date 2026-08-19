import { z } from 'zod';
import { prisma } from '../db';
import { PLATFORMS } from '../constants';
import { parseJson } from '../json';
import { isQuestion } from '../topic/sources/questions';
import { isSensitiveTitle } from '../hot/sensitive';
import {
  MAX_COMMENTS_READ, MAX_QUESTIONS_PER_RUN, MIN_LEN, MAX_LEN,
  MIN_ASKED_TO_STORE, STALE_DAYS, PURGE_DAYS,
  MAX_COMMENT_TEXT_LEN, MAX_COMMENT_TEXTS_PER_RUN,
} from '../comment-collect-rules';
import { pruneInspiration } from './inspiration';

// ── zod schema ──
// ⚠️ 刻意不收（写进这里，让下一个人不敢加）：
//    评论者昵称 / 头像 / 用户ID / IP属地 / 评论时间 / 点赞数 / 楼层 / 回复关系 / 作品 URL
//
// 2026-08-11：`comments`（评论正文）从这份清单里**移出来**了——它现在收。移出的是正文，
// 上面那一行**评论者身份**的清单一个字没动，收正文不等于收人。正文另走 ReaderComment
// 那条链路（保留期 + 不进语料池 + 随移除申请删 + 不导出），口径见 lib/comment-collect-rules.ts。

export const commentQuestionsSchema = z.object({
  scope: z.enum(['own', 'rival']),
  platform: z.string().max(32).refine((p) => p in PLATFORMS, { message: '未知平台' }),
  // 这条作品**作者**的 handle（不是评论者的——评论者的任何标识都不收，见上方清单）。
  // 收它只有一个用途：让「被监控账号申请移除」能精确删掉**这一个**账号名下的提问。
  // 没有它，purgeRemovedAccountData 只能按 platform 删，会把同平台**所有**竞对、
  // 甚至**所有工作区**的提问一起清空（真删过的写法，见 lib/legal/removal.ts 的注释）。
  // ⚠️ 128 而不是 64：竞对通道（lib/ingest/competitor.ts）和自有作品通道
  // （lib/ingest/own-post.ts）都是 128，只有这里当初写窄了。抖音的 handle 取的是
  // `/user/<sec_uid>` 原文（extension/content/douyin.js:143），sec_uid 常见 55 字符但没有
  // 任何平台文档保证它的上限——**未知不当成安全**：放宽到 128 的代价是零，赌它不超 64 的
  // 代价是线上某天整批评论 + 提问一起 400。
  handle: z.string().trim().max(128).optional(),
  accountId: z.string().max(64).optional(),
  workId: z.string().trim().max(128).optional(),
  // ⚠️ 先截断再校验，**绝不因为标题长就把整批打回**。
  //
  // 2026-08-13 查出的错配：插件那头 `extension/content/comments.js:529` 直接抄
  // `__beaconParse().posts[0].title` 不截断，而抖音/X 的 "title" 根本不是短标题——
  // 抖音取的是 `[data-e2e="video-desc"]` 整段文案、X 取的是整条推文正文（各自截到 300）。
  // 于是一条文案 250 字的抖音作品，点「读评论提问」就是 HTTP 400「数据格式不合法」，
  // **这一次读到的全部评论正文（最多 200 条）和全部提问一条都不入库**，用户看不到任何原因。
  //
  // workTitle 只是给人看的展示字段，为它丢掉一整批数据毫无道理；而且截断在服务端做，
  // 已经装在用户机器上的旧版插件当场就好了，不用等他们升级。
  workTitle: z.preprocess(
    (v) => (typeof v === 'string' ? v.slice(0, 300) : v),
    z.string().trim().max(300).optional(),
  ),
  read: z.number().int().min(0).max(MAX_COMMENTS_READ),
  // ⚠️ 曾经是 `.min(1)`（必填至少一条）。正文接上来之后必须放开：一整页全是夸奖和吐槽、
  // 一句疑问句都没有时，questions 就是空数组——`.min(1)` 会让整批 400，
  // 连带那几十条读者原声一起丢掉，用户看到的是「数据格式不合法」。
  questions: z.array(z.object({
    text: z.string().trim().min(MIN_LEN).max(MAX_LEN),
    count: z.number().int().min(1).max(MAX_COMMENTS_READ),
    variants: z.array(z.string().trim().max(MAX_LEN)).max(3).optional(),
    kind: z.enum(['question', 'demand']).default('question'),
  })).max(MAX_QUESTIONS_PER_RUN).default([]),
  // 读者原声（正文）。只有正文与粗分类两个字段，没有任何指向评论者的东西。
  // `.max(MAX_COMMENT_TEXT_LEN + 1)`：插件截断长评论后会补一个「…」，正好多一个字符。
  comments: z.array(z.object({
    text: z.string().trim().min(1).max(MAX_COMMENT_TEXT_LEN + 1),
    // 旧版插件不传 kind，将来加新分类值也不该让整批 400——服务端 normalizeKind 兜底成 other
    kind: z.string().max(16).optional(),
  })).max(MAX_COMMENT_TEXTS_PER_RUN).default([]),
});

export type CommentQuestionsPayload = z.infer<typeof commentQuestionsSchema>;

const NOISE_PREFIX = /^[\s\d.、)）:：]*(?:回复\s*[^\s:：]+\s*[:：]?\s*|@[^\s]+\s*)?/;

function normalizeQuestion(text: string): string {
  return text.replace(NOISE_PREFIX, '').trim();
}

// 评论里可能夹带的个人信息。命中即**整条丢弃**（不脱敏、不截断——留一半更危险）。
//
// ⚠️ 「微信号形态」这一条曾经写作 `/[A-Za-z][\w-]{5,19}/`：6–20 位、字母开头的任意串。
// 微信号确实长这样，但**每一个英文单词也长这样**。2026-08-07 实测：
// 「请问这个 Chrome 插件怎么装」「ChatGPT 和 Claude 哪个更适合写代码」
// 「这个 PyTorch 版本要求是多少」六条科技类提问被静默丢掉五条——
// 而科技/AI 创作者正是这个产品的主力用户，等于对他们整类关闭了这个功能。
// 丢弃是无声的（没有报错、没有计数），只表现为「读了 200 条评论，一个问题都没有」。
//
// 收紧后仍然按「宁可错杀不可放过」的方向，只是把判据从「像个单词」改成「像个账号」：
//   ① 形态：6–20 位字母开头，且**含数字或 _ -**（真实微信号绝大多数如此，英文单词不会）；
//   ② 提示词：出现「微信 / vx / QQ …」后面跟一串拉丁字符——纯字母的微信号靠这条兜住。
const PERSONAL_PATTERNS = [
  /1[3-9]\d{9}/,            // 手机号
  /\S+@\S+\.\S+/,           // 邮箱
  /\d{17}[\dXx]/,            // 身份证
  // 微信号形态：字母开头 6–20 位，且串里至少有一个数字/下划线/连字符
  /(?:^|[^0-9A-Za-z_-])(?=[0-9A-Za-z_-]*[0-9_-])[A-Za-z][0-9A-Za-z_-]{5,19}(?![0-9A-Za-z_-])/,
  // 提示词 + 拉丁串：接住「我的微信是 zhangsan」这种纯字母的账号
  /(?:微信|威信|薇信|v信|vx|wx|扣扣|QQ)[^0-9A-Za-z]{0,4}[0-9A-Za-z_-]{5,20}/i,
  /IP属地[:：]/,
  /来自\S{2,4}$/,
];

export function looksPersonal(text: string): boolean {
  return PERSONAL_PATTERNS.some((re) => re.test(text));
}

/**
 * 这一批评论挂在哪条作品下。**提问（askedBreak 的 key）与正文（ReaderComment.workKey）
 * 必须用同一个值**，否则 /data 的作品行上「读者提问」和「读者原声」会各挂各的，
 * 同一条作品对不上号。所以这里是唯一事实源，两条链路都调它。
 *
 * `sha:` 与 'unknown' 这两种取不到作品 ID 时的兜底 key 对不上任何 platformItemId——
 * 下游做逐作品归属时一律跳过（见 lib/insight/reader-questions.ts 的两条口径）。
 */
export function commentWorkKey(payload: Pick<CommentQuestionsPayload, 'workId' | 'workTitle'>): string {
  if (payload.workId) return payload.workId;
  return payload.workTitle ? `sha:${simpleHash(payload.workTitle)}` : 'unknown';
}

export type IngestCommentResult =
  | { ok: true; created: number; updated: number; total: number }
  | { ok: false; error: string };

export async function ingestCommentQuestions(
  workspaceId: string,
  payload: CommentQuestionsPayload,
): Promise<IngestCommentResult> {
  const source = payload.scope === 'own' ? 'comment' : 'rival-comment';
  const workKey = commentWorkKey(payload);
  const author = payload.handle || null;

  let created = 0;
  let updated = 0;

  for (const q of payload.questions) {
    const text = normalizeQuestion(q.text);
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue;
    // 孤立的单条评论不入库。这是隐私政策第 6 条 ⑥ 对商店与用户的**明文承诺**，
    // 也是「存第三方 UGC」这件事能站住脚的那个论证：留下的是读者共同的疑问，
    // 不是某个人说过的话。见 lib/comment-collect-rules.ts 的长注释。
    // ⚠️ 闸必须在**服务端**这一道：插件是用户本地的旧版本，随时可能没有这条过滤。
    if (q.count < MIN_ASKED_TO_STORE) continue;
    if (looksPersonal(text)) continue;
    if (!isQuestion(text)) continue;
    if (isSensitiveTitle(text)) continue;

    // 归并键带上 author（作品作者 handle）：同一句「这个怎么收费」在 A 号和 B 号的评论区下
    // 是**两个**信号，混成一行不但读者画像会串，B 号申请移除时也没法只删 B 那份。
    const existing = await prisma.inspirationItem.findFirst({
      where: { workspaceId, source, title: text, author },
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
          author,
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

/**
 * 提问的保留期流转：满 STALE_DAYS 转归档、满 PURGE_DAYS 物理删除。
 *
 * workspaceId 可省：**省略即全库**。写入路径按工作区调（顺手清自己那份），
 * 而 purge_retention 定时任务要扫的恰恰是「已经没人再写入」的那些工作区——
 * 到期删除是对提问作者的承诺，不能只在工作区主人还在用的时候才兑现。
 */
export async function pruneStaleQuestions(workspaceId?: string): Promise<{ archived: number; deleted: number }> {
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_DAYS * 86_400_000);
  const purgeCutoff = new Date(now - PURGE_DAYS * 86_400_000);
  const scope = workspaceId ? { workspaceId } : {};

  const [archiveResult, deleteResult] = await Promise.all([
    prisma.inspirationItem.updateMany({
      where: {
        ...scope,
        source: { in: ['comment', 'rival-comment'] },
        state: 'open',
        lastAskedAt: { lt: staleCutoff },
      },
      data: { state: 'archived' },
    }),
    prisma.inspirationItem.deleteMany({
      where: {
        ...scope,
        source: { in: ['comment', 'rival-comment'] },
        state: 'archived',
        lastAskedAt: { lt: purgeCutoff },
      },
    }),
  ]);

  return { archived: archiveResult.count, deleted: deleteResult.count };
}
