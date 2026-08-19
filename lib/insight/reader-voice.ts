import { prisma } from '../db';
import { KINDS, type CommentKind } from '../ingest/reader-comments';

// 读者原声的取数与聚合——回答「粉丝主要在了解什么、关心什么」。
//
// 与 reader-questions.ts 的分工：那边是**提问**（已归并、≥2 人问过、进选题候选池），
// 这边是**正文**（逐条、只给人读和做统计）。两边的 workKey 口径必须一致，
// 否则同一条作品在 /data 上会挂着两套对不上的东西——唯一事实源是
// lib/ingest/comment-questions.ts 的 commentWorkKey()。

export type ReaderCommentRow = {
  id: string;
  text: string;
  kind: string;
  platform: string;
  workKey: string;
  workTitle: string | null;
  collectedAt: Date;
};

// ── 话题提取 ──
//
// 中文没有天然词边界，这里用 n-gram 频次而不是分词：不引入分词库（体积 + 词典维护），
// 结果也足够回答「反复被提到的是哪几个词」。三条口径：
//
// 1) 统计的是**多少条评论提到过**（document frequency），不是总出现次数。
//    一条评论里把「价格」说三遍，说明的是这个人啰嗦，不是三个人关心。
// 2) 子串被父串完全吃掉时丢子串：「多少钱」出现 5 次，「少钱」必然也出现 5 次，
//    留着只是把同一件事说两遍，还会把 TOP 榜挤满。
// 3) 至少 MIN_TOPIC_DOCS 条评论提到才算「大家在关心」——一条评论提到的是一个人的话，
//    这跟 MIN_ASKED_TO_STORE 背后是同一个判断。

const MIN_TOPIC_DOCS = 2;
const GRAM_MIN = 2;
const GRAM_MAX = 4;

// 全部字符都落在这个集合里的 gram 直接丢弃。
// 用「全部字符」而不是枚举停用词表，是因为枚举永远列不全：只要 gram 里有一个实义字
// （「什么时候」里的「时」「候」），它就还有信息量，不该被当虚词扔掉。
const STOP_CHARS = new Set(
  ('的了是我你他她它们在有和就不人都一个上也很到说要去会着没看好自这那么什呢吗吧啊把被让给对从但还'
    + '能可以真太更最之其与及为以于呀哦嗯啦嘛哈呵噢欸诶哇喔咦哟嘿啥咋咯嘞喽呗么样种些点儿地得着过来下'
	+ '啊哎唉呃额呐嗯哦噶嘎').split(''),
);

function isStopGram(g: string): boolean {
  // 两字词按「含一个虚字就丢」判。真机第一版漏了这条，话题榜上冒出「声了」——
  // 它来自「太大声了」和「盖过人声了」，是滑窗跨过词边界粘出来的，不是词。
  // 三字以上不能这么判：「什么时候」含四个虚字里的两个，却是实打实在问时间。
  if (g.length <= 2) {
    for (const ch of g) if (STOP_CHARS.has(ch)) return true;
    return false;
  }
  for (const ch of g) if (!STOP_CHARS.has(ch)) return false;
  return true;
}

// 按标点切子句后再滑窗：跨句 n-gram（「…好看。价格…」→「看价」）是纯噪声。
function clauses(text: string): string[] {
  return text
    .split(/[\s、,，。.!！?？;；:：~～…()（）"'"'\[\]【】\-—/|]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= GRAM_MIN);
}

export type ConcernTopic = {
  term: string;
  /** 有多少条评论提到它 */
  docs: number;
  /** 例句（最多 3 条），让用户能核对这个词是从哪来的——只给统计不给出处等于让人凭空信 */
  samples: string[];
};

export function extractConcerns(texts: string[], limit = 12): ConcernTopic[] {
  // gram → 提到它的评论下标集合
  const df = new Map<string, Set<number>>();
  texts.forEach((text, i) => {
    for (const c of clauses(text)) {
      for (let n = GRAM_MIN; n <= GRAM_MAX; n++) {
        for (let s = 0; s + n <= c.length; s++) {
          const g = c.slice(s, s + n);
          if (isStopGram(g)) continue;
          let set = df.get(g);
          if (!set) { set = new Set(); df.set(g, set); }
          set.add(i);
        }
      }
    }
  });

  const counted = [...df.entries()]
    .map(([term, docs]) => ({ term, docs: docs.size, idx: docs }))
    .filter((t) => t.docs >= MIN_TOPIC_DOCS)
    // 长的排前面：下面的吸收判断要从长到短做
    .sort((a, b) => b.term.length - a.term.length || b.docs - a.docs);

  const kept: typeof counted = [];
  for (const t of counted) {
    // 已保留的更长的词里，有没有一个把它完全吃掉（包含它 + 出现的评论一样多）
    const absorbed = kept.some((k) => k.term.includes(t.term) && k.docs >= t.docs);
    if (!absorbed) kept.push(t);
  }

  return kept
    .sort((a, b) => b.docs - a.docs || b.term.length - a.term.length)
    .slice(0, limit)
    .map((t) => ({
      term: t.term,
      docs: t.docs,
      samples: [...t.idx].slice(0, 3).map((i) => texts[i]),
    }));
}

// ── 分类占比 ──
// kind 是启发式粗分类（关键词命中），不是事实断言。UI 上必须说成「大致分类」，
// 不能拿它当「读者满意度 78%」这种像结论的数字用。
export type KindBreakdown = { kind: CommentKind; count: number; pct: number }[];

export function kindBreakdown(rows: { kind: string }[]): KindBreakdown {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = (KINDS as readonly string[]).includes(r.kind) ? r.kind : 'other';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = rows.length || 1;
  return KINDS
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0, pct: (counts.get(kind) ?? 0) / total }))
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count);
}

export const KIND_LABEL: Record<CommentKind, string> = {
  question: '在问',
  demand: '想要',
  praise: '认可',
  complaint: '不满',
  other: '其它',
};

// ── 取数 ──

/**
 * 自有作品的读者原声，按 `platform:workKey` 分组挂回作品行。
 *
 * ⚠️ 两道过滤跟 /data 页其余部分一样容易造成「采了但看不见」：
 *   · accountId：null（工作区共享，插件没带账号上下文时）也要取，否则刚采的全不显示；
 *   · scope='own'：竞对作品的评论挂到自有作品行上，就是把别人的读者当成你的。
 * 这两条踩过的坑见 [[beacon-invisible-after-ingest]] / [[beacon-ingest-account-attribution]]。
 */
export async function readerCommentsByWork(
  workspaceId: string,
  accountId: string,
): Promise<Map<string, ReaderCommentRow[]>> {
  const rows = await prisma.readerComment.findMany({
    where: { workspaceId, scope: 'own', OR: [{ accountId }, { accountId: null }] },
    orderBy: { collectedAt: 'desc' },
    select: {
      id: true, text: true, kind: true, platform: true,
      workKey: true, workTitle: true, collectedAt: true,
    },
  });
  const byWork = new Map<string, ReaderCommentRow[]>();
  for (const r of rows) {
    // 与 reader-questions.ts 同一口径：取不到作品 ID 的兜底 key 对不上任何 platformItemId，
    // 硬挂到某条作品上就是张冠李戴。这些评论仍然进「读者原声」总览，只是不做逐作品归属。
    if (r.workKey === 'unknown' || r.workKey.startsWith('sha:')) continue;
    const key = `${r.platform}:${r.workKey}`;
    const list = byWork.get(key);
    if (list) list.push(r);
    else byWork.set(key, [r]);
  }
  return byWork;
}

export type ReaderVoice = {
  total: number;
  kinds: KindBreakdown;
  concerns: ConcernTopic[];
  recent: ReaderCommentRow[];
};

/** 一个工作区（可限定账号/竞对作者）的读者原声总览。 */
export async function readerVoice(
  workspaceId: string,
  opts: { scope: 'own' | 'rival'; accountId?: string; author?: string; platform?: string; take?: number },
): Promise<ReaderVoice> {
  const rows = await prisma.readerComment.findMany({
    where: {
      workspaceId,
      scope: opts.scope,
      ...(opts.platform ? { platform: opts.platform } : {}),
      ...(opts.author ? { author: opts.author } : {}),
      ...(opts.scope === 'own' && opts.accountId
        ? { OR: [{ accountId: opts.accountId }, { accountId: null }] }
        : {}),
    },
    orderBy: { collectedAt: 'desc' },
    // 统计口径写在这里：只看最近 N 条。全量统计会让半年前的话题一直压着这周的
    take: opts.take ?? 500,
    select: {
      id: true, text: true, kind: true, platform: true,
      workKey: true, workTitle: true, collectedAt: true,
    },
  });

  return {
    total: rows.length,
    kinds: kindBreakdown(rows),
    concerns: extractConcerns(rows.map((r) => r.text)),
    recent: rows,
  };
}
