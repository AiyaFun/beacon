import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { commentQuestionsSchema } from '@/lib/ingest/comment-questions';
import { ingestReaderComments } from '@/lib/ingest/reader-comments';
import { MAX_DANMAKU_PER_RUN } from '@/lib/comment-collect-rules';

// B 站弹幕正文进读者原声（2026-09-03）。学自 OpenBiliClaw 唯一一件不碰红线的事：
// 弹幕文件公开、无凭据、无签名，与字幕轨同档；只取文字，发送者 hash/时间/颜色一个都不取。

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

beforeEach(async () => {
  await prisma.readerComment.deleteMany();
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
});

describe('服务端', () => {
  it('schema 收 danmaku（只有 text），上限与规则常量同数，缺省空数组', () => {
    const base = { scope: 'rival', platform: 'bilibili', read: 3, questions: [], comments: [] };
    expect(commentQuestionsSchema.parse(base).danmaku).toEqual([]);
    const ok = commentQuestionsSchema.parse({ ...base, danmaku: [{ text: '这个转场是怎么做的' }] });
    expect(ok.danmaku).toHaveLength(1);
    const tooMany = { ...base, danmaku: Array.from({ length: MAX_DANMAKU_PER_RUN + 1 }, (_, i) => ({ text: `弹幕 ${i} 很长的一句话` })) };
    expect(commentQuestionsSchema.safeParse(tooMany).success).toBe(false);
    // 发送者/时间等字段根本不在 schema 里（zod 默认剥掉未知键）
    const stripped = commentQuestionsSchema.parse({ ...base, danmaku: [{ text: '这个转场是怎么做的', p: '1.2,1,25,16777215,hash' }] });
    expect(stripped.danmaku[0]).toEqual({ text: '这个转场是怎么做的' });
  });

  it('入库标 source=danmaku；同一条作品下与评论撞句只留一行；短句与个人信息照旧丢', async () => {
    const meta = { scope: 'rival' as const, platform: 'bilibili', author: '123', accountId: null, workKey: 'BV1x', workTitle: '标题' };
    await ingestReaderComments('w1', meta, [{ text: '这个转场是怎么做的' }]);
    const r = await ingestReaderComments('w1', meta, [{ text: '这个转场是怎么做的' }, { text: '太强了这个剪辑节奏' }, { text: '哈哈' }, { text: '加我微信 abc_12345' }], { source: 'danmaku' });
    expect(r.stored).toBe(2);
    expect(r.skipped).toBe(2);
    const rows = await prisma.readerComment.findMany({ where: { workspaceId: 'w1' }, orderBy: { text: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.source === 'danmaku')).toBe(true);
  });

  it('🔒 两份 schema 与 49 号 SQL 都有 source 列；读者原声查询把 source 选出来、组件标「弹幕」', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      const seg = /model ReaderComment \{[\s\S]*?\n\}/.exec(read(f))?.[0] ?? '';
      expect(seg, f).toMatch(/source\s+String\s+@default\("comment"\)/);
    }
    expect(read('prisma/postgres/49-reader-comment-source.sql')).toContain('"source"');
    expect(read('lib/insight/reader-voice.ts').match(/source: true/g)?.length).toBe(2);
    expect(read('components/ReaderVoice.tsx')).toMatch(/c\.source === 'danmaku'/);
    expect(read('app/api/ingest/questions/route.ts')).toMatch(/p\.danmaku, \{ source: 'danmaku' \}/);
  });
});

describe('插件', () => {
  const sw = read('extension/sw.js');
  it('弹幕由 SW 用 func 注入的自包含函数取，只在 bilibili 作品页；comments.js 本身不动（它是同步 IIFE）', () => {
    expect(sw).toMatch(/if \(result\.platform === 'bilibili'\)/);
    expect(sw).toMatch(/executeScript\(\{ target: \{ tabId \}, func: collectBiliDanmaku \}\)/);
    expect(read('extension/content/comments.js')).not.toContain('comment.bilibili.com');
  });
  it('只取 <d> 的文字：正则只捕获文本节点，p 属性（发送者 hash/时间/颜色）连变量都没有', () => {
    const fn = sw.slice(sw.indexOf('async function collectBiliDanmaku'), sw.indexOf('chrome.contextMenus.onClicked'));
    expect(fn).toContain('comment.bilibili.com/${cid}.xml');
    expect(fn).toMatch(/<d\\s\[\^>\]\*>\(\[\^<\]\*\)<\\\/d>/);
    expect(fn).not.toMatch(/p="|getAttribute|hash|midHash/);
    // 不带登录态
    expect(fn).toContain("credentials: 'omit'");
    // 只挑不刷屏：折叠重复、过纯梗、按长度排、封顶 100
    expect(fn).toMatch(/MAX = 100/);
    expect(fn).toMatch(/\.slice\(0, MAX\)/);
  });
  it('回传 body 带 danmaku；只有弹幕没有评论也不早退', () => {
    expect(sw).toMatch(/danmaku: result\.danmaku,/);
    expect(sw).toMatch(/if \(!hasQuestions && !hasComments && !hasDanmaku\)/);
  });
  it('🔒 披露三处都写了弹幕：隐私政策页、商店隐私说明、用户说明', () => {
    expect(read('app/(public)/legal/privacy/page.tsx')).toMatch(/B 站弹幕/);
    expect(read('extension/store/privacy.md')).toMatch(/B 站弹幕/);
    expect(read('docs/用户使用说明-插件与机器人.md')).toMatch(/弹幕/);
  });
});
