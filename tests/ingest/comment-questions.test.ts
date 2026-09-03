import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  commentQuestionsSchema,
  looksPersonal,
  ingestCommentQuestions,
  type CommentQuestionsPayload,
} from '@/lib/ingest/comment-questions';

async function ws(): Promise<string> {
  const t = await prisma.tenant.create({ data: { name: 't' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
  return w.id;
}

function payload(over: Partial<CommentQuestionsPayload> = {}): CommentQuestionsPayload {
  return {
    scope: 'own',
    platform: 'douyin',
    read: 50,
    questions: [{ text: '这个工具怎么收费呢', count: 3, kind: 'question' }],
    comments: [],
    danmaku: [],
    ...over,
  };
}

beforeEach(async () => {
  await prisma.inspirationItem.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('commentQuestionsSchema 校验', () => {
  it('合法 payload 通过', () => {
    expect(commentQuestionsSchema.safeParse(payload()).success).toBe(true);
  });

  it('scope 只接受 own/rival', () => {
    expect(commentQuestionsSchema.safeParse(payload({ scope: 'other' as 'own' })).success).toBe(false);
  });

  it('未知平台打回', () => {
    expect(commentQuestionsSchema.safeParse(payload({ platform: 'myspace' })).success).toBe(false);
  });

  // ⚠️ 这条曾经断言「questions 为空 → 整批拒收」（schema 上是 `.min(1)`）。
  // 2026-08-11 评论正文接进同一个 payload 后必须放开：一整页全是夸奖和吐槽、
  // 一句疑问句都没有时 questions 就是空数组，`.min(1)` 会让整批 400，
  // 连带那几十条读者原声一起丢掉，用户看到的还是句看不懂的「数据格式不合法」。
  it('questions 可以为空（那一页可能一句疑问句都没有，但正文还得收）', () => {
    expect(commentQuestionsSchema.safeParse(payload({ questions: [] })).success).toBe(true);
    expect(commentQuestionsSchema.safeParse(
      payload({ questions: [], comments: [{ text: '这个配色太好看了' }] }),
    ).success).toBe(true);
  });

  it('两条链路都空也合法——服务端照常收下，只是一条都不入库', async () => {
    const parsed = commentQuestionsSchema.safeParse(payload({ questions: [], comments: [] }));
    expect(parsed.success).toBe(true);
    const wid = await ws();
    const r = await ingestCommentQuestions(wid, payload({ questions: [], comments: [] }));
    expect(r).toMatchObject({ ok: true, created: 0, updated: 0 });
  });

  it('text 长度守限', () => {
    expect(commentQuestionsSchema.safeParse(payload({
      questions: [{ text: 'ab', count: 1, kind: 'question' }],
    })).success).toBe(false);
  });
});

describe('looksPersonal PII 过滤', () => {
  it('手机号', () => expect(looksPersonal('加我13912345678聊')).toBe(true));
  it('邮箱', () => expect(looksPersonal('发到test@qq.com')).toBe(true));
  it('身份证', () => expect(looksPersonal('填12345678901234567X')).toBe(true));
  it('IP属地标记', () => expect(looksPersonal('IP属地：广东')).toBe(true));
  it('正常提问不误报', () => expect(looksPersonal('这个工具怎么收费呢')).toBe(false));
});

describe('ingestCommentQuestions 入库', () => {
  it('首次入库创建新记录', async () => {
    const wid = await ws();
    const r = await ingestCommentQuestions(wid, payload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
    expect(r.updated).toBe(0);

    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId: wid } });
    expect(row!.source).toBe('comment');
    expect(row!.askedCount).toBe(3);
    expect(row!.askedWorks).toBe(1);
  });

  it('rival scope 写入 rival-comment source', async () => {
    const wid = await ws();
    await ingestCommentQuestions(wid, payload({ scope: 'rival' }));
    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId: wid } });
    expect(row!.source).toBe('rival-comment');
  });

  it('同题二次入库走 max 合并（同一批评论快照，不是增量事件）', async () => {
    const wid = await ws();
    await ingestCommentQuestions(wid, payload({ questions: [{ text: '这个工具怎么收费呢', count: 3, kind: 'question' }] }));
    await ingestCommentQuestions(wid, payload({ questions: [{ text: '这个工具怎么收费呢', count: 5, kind: 'question' }] }));

    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId: wid } });
    expect(row!.askedCount).toBe(5);
    expect(await prisma.inspirationItem.count({ where: { workspaceId: wid } })).toBe(1);
  });

  it('不同作品下同题 → askedWorks 增加', async () => {
    const wid = await ws();
    await ingestCommentQuestions(wid, payload({ workId: 'v1', questions: [{ text: '这个工具怎么收费呢', count: 2, kind: 'question' }] }));
    await ingestCommentQuestions(wid, payload({ workId: 'v2', questions: [{ text: '这个工具怎么收费呢', count: 3, kind: 'question' }] }));

    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId: wid } });
    expect(row!.askedWorks).toBe(2);
    expect(row!.askedCount).toBe(5);
  });

  it('PII 被静默过滤', async () => {
    const wid = await ws();
    const r = await ingestCommentQuestions(wid, payload({
      questions: [{ text: '加我微信13912345678', count: 1, kind: 'question' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(0);
  });

  it('纯陈述句被服务端 isQuestion 二次校验过滤', async () => {
    const wid = await ws();
    const r = await ingestCommentQuestions(wid, payload({
      questions: [{ text: '讲得真好已经三连支持了', count: 1, kind: 'question' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(0);
  });
});

describe('评论 source 不出现在推荐示例里', () => {
  it('comment 和 rival-comment 不在推荐管线的 exemplar 列表中', async () => {
    const { COMMENT_SOURCES } = await import('@/lib/topic/sources/inspiration');
    expect(COMMENT_SOURCES.has('comment')).toBe(true);
    expect(COMMENT_SOURCES.has('rival-comment')).toBe(true);
    expect(COMMENT_SOURCES.has('plugin')).toBe(false);
  });
});

describe('服务端与插件常量一致', () => {
  it('MAX_COMMENTS / MIN_LEN / MAX_LEN 与 comment-collect-rules 相同', async () => {
    const fs = await import('fs');
    const rules = await import('@/lib/comment-collect-rules');
    const src = fs.readFileSync('extension/content/comments.js', 'utf-8');
    expect(src).toContain(`MAX_COMMENTS = ${rules.MAX_COMMENTS_READ}`);
    expect(src).toContain(`MIN_LEN = ${rules.MIN_LEN}`);
    expect(src).toContain(`MAX_LEN = ${rules.MAX_LEN}`);
    // 回传条数上限也要一致：插件比服务端的 zod 上限大，**整批**会被 400 打回而不是截断，
    // 用户看到的是「数据格式不合法」——一次正常采集被展示成故障。
    expect(src).toContain(`MAX_QUESTIONS = ${rules.MAX_QUESTIONS_PER_RUN}`);
  });

  it('评论正文的两个上限也是手抄的，同样要钉住', async () => {
    const fs = await import('fs');
    const rules = await import('@/lib/comment-collect-rules');
    const src = fs.readFileSync('extension/content/comments.js', 'utf-8');
    expect(src).toContain(`MAX_COMMENT_TEXT_LEN = ${rules.MAX_COMMENT_TEXT_LEN}`);
    expect(src).toContain(`MAX_COMMENT_TEXTS = ${rules.MAX_COMMENT_TEXTS_PER_RUN}`);
  });

  it('单条正文长度上限与政策里写的字数一致（政策说 300 字，代码就不能是 500）', async () => {
    const fs = await import('fs');
    const rules = await import('@/lib/comment-collect-rules');
    expect(fs.readFileSync('extension/store/privacy.md', 'utf-8'))
      .toContain(`5–${rules.MAX_COMMENT_TEXT_LEN} 字`);
  });
});

// ── 「只有被两人以上问过的才留存」这句承诺，代码必须真的做到 ──
//
// extension/store/privacy.md 第 6 条 ⑥ 的原话（这段文字已随插件提交给应用商店）：
//   「只有被两人以上问过的问题短句才会留存，孤立的单条评论不落库
//     ——留下的是『读者共同的疑问』，不是某个人说过的话。」
//
// 2026-08-07 体检发现：插件的 groupQuestions 与服务端的 ingestCommentQuestions **都没有这道闸**，
// 一个人随口问的一句话会原样存进 InspirationItem.title。这不是显示偏差——
// 它同时打掉两样东西：政策文本变成不实陈述；而「留下的是读者共同的疑问、
// 不是某个人的言论」正是「存第三方 UGC」这件事能站住脚的那个论证，闸没了论证也就没了。
//
// 形状与 lib/legal/removal.ts 头注释里那次完全一样：对外承诺了一个代码兑现不了的东西。
describe('隐私承诺 · 孤立的单条评论不落库', () => {
  it('🔒 count=1 的提问一条都不入库（哪怕它是个正经问题）', async () => {
    const wid = await ws();
    const r = await ingestCommentQuestions(wid, payload({
      questions: [{ text: '这个工具怎么收费呢', count: 1, kind: 'question' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(0);
    expect(await prisma.inspirationItem.count({ where: { workspaceId: wid } })).toBe(0);
  });

  it('count=2 起才入库（阈值本身也钉住，别悄悄降到 1）', async () => {
    const wid = await ws();
    const r = await ingestCommentQuestions(wid, payload({
      questions: [{ text: '这个工具怎么收费呢', count: 2, kind: 'question' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
  });

  it('🔒 同一批里单人问的丢掉、多人问的留下（不是整批拒绝）', async () => {
    const wid = await ws();
    const r = await ingestCommentQuestions(wid, payload({
      questions: [
        { text: '这个工具怎么收费呢', count: 3, kind: 'question' },
        { text: '博主用的什么设备呢', count: 1, kind: 'question' },
      ],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(1);
    const rows = await prisma.inspirationItem.findMany({ where: { workspaceId: wid }, select: { title: true } });
    expect(rows.map((x) => x.title)).toEqual(['这个工具怎么收费呢']);
  });

  it('🔒 插件侧也不许把单人提问发出来（传了再丢，那句承诺在网络这一段就不成立了）', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('extension/content/comments.js', 'utf-8');
    expect(src).toContain('.filter((q) => q.count >= 2)');
  });

  it('🔒 政策原文与代码阈值对得上（改代码不改政策，或反过来，都要红）', async () => {
    const fs = await import('fs');
    const { MIN_ASKED_TO_STORE } = await import('@/lib/comment-collect-rules');
    expect(MIN_ASKED_TO_STORE).toBe(2);
    // 这句承诺出现在**两份**面向外部的文本里：商店提交的隐私政策、站内隐私权页。
    // 两份都要有——只改其中一份等于对另一批读者仍在说旧话。
    const policy = fs.readFileSync('extension/store/privacy.md', 'utf-8');
    expect(policy).toContain('两人以上');
    // ⚠️ 这句原文曾是「孤立的单条评论**不落库**」。2026-08-11 评论正文开始留存后，
    // 那句话就成了假的——单条评论确实会落 ReaderComment 库，只是不进选题参考。
    // 政策原文已改成「不进」，这里跟着改：守卫的作用正是逼人发现旧措辞已经不成立，
    // 而不是把一句不再为真的承诺一直钉在商店页上。
    expect(policy).toContain('孤立的单条评论不进');
    expect(fs.readFileSync('scripts/privacy-page.ts', 'utf-8')).toContain('被两人以上问过');
  });

  it('🔒 「随提问一起回传作品/作者标识」这件事两份文本都写明了（少说 = 少披露）', async () => {
    const fs = await import('fs');
    // 服务端确实在收 handle（lib/ingest/comment-questions.ts 的 schema），
    // 那么两份对外文本就都必须说出来。站内页早已写了，商店那份 2026-08-07 才补上。
    expect(fs.readFileSync('lib/ingest/comment-questions.ts', 'utf-8')).toContain('handle: z.string()');
    expect(fs.readFileSync('extension/store/privacy.md', 'utf-8')).toContain('作品作者');
    expect(fs.readFileSync('scripts/privacy-page.ts', 'utf-8')).toContain('作品作者的公开账号标识');
  });
});
