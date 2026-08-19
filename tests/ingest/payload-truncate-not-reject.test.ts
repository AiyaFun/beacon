import { describe, it, expect } from 'vitest';
import { commentQuestionsSchema } from '@/lib/ingest/comment-questions';

// 「超长字段该截断，不该把整批打回」——2026-08-13 体检查出两处违反这条的地方。
//
// 这个仓库已经为同一件事栽过一次：comment-questions 的 `questions` 曾是 `.min(1)`，
// 一整页没有疑问句就让整批 400，连带几十条读者原声一起丢，用户只看到「数据格式不合法」。
// 那次的教训写在 schema 的注释里，但同一份 schema 里的 `workTitle: .max(200)` 又踩了回去。
//
// 【为什么截断必须做在服务端】插件装在用户机器上，改完要等他们升级（商店版还要过审）。
// 服务端截断是**当天对所有存量安装生效**的那一半。插件那一侧也截，是为了少发无用流量，
// 不是为了兜住这个错。
//
// ⚠️ 这不是「什么都别校验」：身份类、枚举类、会写进库当唯一键的字段仍然该严格打回。
//    只有**展示用的长文本**才适用截断——它的正确性对这批数据的价值没有影响。

const base = {
  scope: 'rival' as const,
  platform: 'douyin',
  read: 20,
  questions: [],
};

describe('展示用长文本必须截断而不是打回整批', () => {
  it('🔒 workTitle 超长 → 截到 300 通过，而不是 400 掉整批评论', () => {
    // 抖音的 "title" 其实是整段文案（[data-e2e="video-desc"]，各解析器截到 300），
    // 250 字是很常见的形态——此前 .max(200) 会让这一批 200 条评论正文一条都进不去。
    const r = commentQuestionsSchema.safeParse({ ...base, workTitle: '文'.repeat(250) });
    expect(r.success).toBe(true);
    expect(r.success && r.data.workTitle).toHaveLength(250);
  });

  it('🔒 workTitle 长到离谱也只是被截，不影响这批数据入库', () => {
    const r = commentQuestionsSchema.safeParse({ ...base, workTitle: '文'.repeat(5000) });
    expect(r.success).toBe(true);
    expect(r.success && (r.data.workTitle || '').length).toBe(300);
  });

  it('workTitle 不传照常通过（它本来就是可选的）', () => {
    expect(commentQuestionsSchema.safeParse(base).success).toBe(true);
  });

  // handle 是移除申请精确删数据的依据，三条通道必须同宽。
  // 抖音的 handle 取 /user/<sec_uid> 原文，sec_uid 没有文档保证的上限——
  // 「未知不当成安全」：放宽的代价是零，赌它不超 64 的代价是线上整批丢数。
  it('🔒 handle 至少支持到 128（与竞对/自有作品两条通道同宽）', () => {
    expect(commentQuestionsSchema.safeParse({ ...base, handle: 'a'.repeat(128) }).success).toBe(true);
  });

  // 反面：该严的仍然要严，截断不是「什么都放行」的借口
  it('平台名不认识仍然打回（枚举类不适用截断）', () => {
    expect(commentQuestionsSchema.safeParse({ ...base, platform: 'nosuchsite' }).success).toBe(false);
  });

  it('scope 不是 own/rival 仍然打回', () => {
    expect(commentQuestionsSchema.safeParse({ ...base, scope: 'x' }).success).toBe(false);
  });
});
