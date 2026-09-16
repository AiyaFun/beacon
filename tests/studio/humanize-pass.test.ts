import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 自动去 AI 味（2026-09-16，用户：「初稿那个，要看起来不是 ai 写的」）。
// 提示词只降概率，出口清洗才是保证：每个起稿出口落库前跑一遍人味体检，测出问题才多调一次模型改，
// 改得不好（添了事实 / 更多套话 / 分数更低 / 长度失控 / Mock）就用原稿。

const llm = { calls: 0, reply: { text: '', mocked: false } as { text: string; mocked: boolean } };
vi.mock('@/lib/llm/gateway', async (orig) => {
  const actual = await orig<typeof import('@/lib/llm/gateway')>();
  return {
    ...actual,
    llmComplete: async () => {
      llm.calls += 1;
      return { text: llm.reply.text, provider: 'test', model: 'm', mocked: llm.reply.mocked, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
});

const { judgeDraft, humanizePass, buildHumanizePassMessages, HUMANIZE_TARGET_SCORE } = await import('@/lib/studio/humanize-pass');
const { platformFormatBlock } = await import('@/lib/studio/platform-format');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 一段典型 AI 腔：套话 + 句句等长 + 对仗 + 模板收尾
const AI_TEXT = [
  '在这个信息爆炸的时代，午休影院悄然兴起，成为打工人的新选择。',
  '众所周知，传统影院主要面向晚间的观影人群，而午休影院则瞄准了白领上班族。',
  '不可否认，它不仅提供了休息的空间，而且创造了全新的消费场景。',
  '它不是简单的影院，而是城市生活的一种全新解法。',
  '毋庸置疑，这种模式值得更多商家学习借鉴，也值得每一位读者认真思考。',
  '你怎么看？欢迎在评论区留言，和大家一起交流你的看法。',
].join('\n');

// 像人写的一版：没有套话、长短句、有一句单独成段
const HUMAN_TEXT = [
  '午休影院这事，我一开始以为是噱头。',
  '去了才知道不是。',
  '中午饭点，写字楼底下那家店坐了大半，来的全是附近上班的，没人看片，都在睡。',
  '传统影院晚上才热闹，白天的厅空着也是空着，租出去给人睡，账反而更好算。',
  '所以它卖的不是电影，是一张能躺平的床。',
  '你们中午一般去哪？',
].join('\n');

beforeEach(() => { llm.calls = 0; llm.reply = { text: '', mocked: false }; });

describe('判定', () => {
  it('典型 AI 腔：命中套话 + 节奏问题 → 要改；理由列得出来', () => {
    const v = judgeDraft(AI_TEXT, 'xiaohongshu');
    expect(v.needed).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/套话/);
    expect(v.report.hits.length).toBeGreaterThan(2);
  });

  it('太短的文本算不出分、也没套话 → 不改、不调模型', async () => {
    const r = await humanizePass('t', '就这一句。', 'douyin');
    expect(r.changed).toBe(false);
    expect(llm.calls).toBe(0);
  });

  it('像人写的那版：没套话，即使分数不满分也不该被判成「要改」到反复重写', () => {
    const v = judgeDraft(HUMAN_TEXT, 'xiaohongshu');
    expect(v.report.hits).toHaveLength(0);
    if (v.report.sufficient) expect(v.report.score).toBeGreaterThanOrEqual(HUMANIZE_TARGET_SCORE - 20);
  });
});

describe('改稿', () => {
  it('提示词：点名每一处套话、带平台格式、信息不许加不许少、只改被点名的', () => {
    const v = judgeDraft(AI_TEXT, 'xiaohongshu');
    const msgs = buildHumanizePassMessages({ text: AI_TEXT, platform: 'xiaohongshu', report: v.report, formatBlock: platformFormatBlock('xiaohongshu'), voiceBlock: '【原句样本】我写东西就这样' });
    const sys = String(msgs[0].content);
    expect(sys).toContain('一个不许少、一个不许加');
    expect(sys).toContain('【被点名的套话');
    expect(sys).toContain('众所周知');
    expect(sys).toContain('【目标平台的格式（小红书');
    expect(sys).toContain('原句样本');
    expect(sys).toMatch(/不许搬/);
    expect(String(msgs[1].content)).toBe(AI_TEXT);
  });

  it('改得更像人 → 采用改后的，note 报人味分变化', async () => {
    llm.reply = { text: HUMAN_TEXT, mocked: false };
    const r = await humanizePass('t', AI_TEXT, 'xiaohongshu');
    expect(llm.calls).toBe(1);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(HUMAN_TEXT);
    expect(r.note).toMatch(/已自动去 AI 味/);
    expect(r.before).not.toBeNull();
  });

  it('🔒 改出来的一版冒出原文没有的数字 → 作废用原稿（改稿不许添事实）', async () => {
    llm.reply = { text: HUMAN_TEXT.replace('坐了大半', '坐了 37 个人'), mocked: false };
    const r = await humanizePass('t', AI_TEXT, 'xiaohongshu');
    expect(r.changed).toBe(false);
    expect(r.text).toBe(AI_TEXT);
    expect(r.note).toMatch(/数字/);
  });

  it('🔒 Mock 模型 / 空回 / 长度失控 / 套话反而更多 → 都用原稿，且不抛', async () => {
    llm.reply = { text: HUMAN_TEXT, mocked: true };
    expect((await humanizePass('t', AI_TEXT, 'xiaohongshu')).changed).toBe(false);
    llm.reply = { text: '', mocked: false };
    expect((await humanizePass('t', AI_TEXT, 'xiaohongshu')).changed).toBe(false);
    llm.reply = { text: '太短了。', mocked: false };
    expect((await humanizePass('t', AI_TEXT, 'xiaohongshu')).note).toMatch(/长度/);
    llm.reply = { text: AI_TEXT + '\n毋庸置疑，众所周知，不可否认，相信大家都懂。', mocked: false };
    expect((await humanizePass('t', AI_TEXT, 'xiaohongshu')).note).toMatch(/套话反而更多|长度|人味分/);
  });

  it('模型抛错（配额/网络）→ 原稿照常返回，不让起稿失败', async () => {
    const mod = await import('@/lib/llm/gateway');
    const spy = vi.spyOn(mod, 'llmComplete').mockRejectedValueOnce(new Error('今日 AI 额度已用完'));
    const r = await humanizePass('t', AI_TEXT, 'xiaohongshu');
    expect(r.changed).toBe(false);
    expect(r.note).toMatch(/没跑成/);
    spy.mockRestore();
  });
});

describe('🔒 接线：每个起稿出口落库前都过这一道', () => {
  it('工坊五处（普通+深度共用一处 / 改写 / 想法深度 / 想法普通 / 派生）+ 流式路由 + 工作流', () => {
    const actions = strip(read('app/(app)/studio/actions.ts'));
    expect((actions.match(/finishDraft\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    const route = strip(read('app/api/studio/draft/stream/route.ts'));
    expect(route).toMatch(/finishDraft\(/);
    expect(route).toMatch(/send\('polished', content\)/);
    expect(route).toMatch(/send\('done', \{[^}]*humanize/);
    const wf = strip(read('lib/workflow/run.ts'));
    expect(wf).toMatch(/finishDraft\(\{ tenantId: ctx\.tenantId/);
  });

  it('两个前端出口认 polished 事件（否则用户看到的预览与存下来的不一样）', () => {
    for (const f of ['components/BattleStartDraft.tsx', 'app/(app)/studio/DraftButton.tsx']) {
      const src = strip(read(f));
      expect(src, f).toMatch(/ev === 'polished'/);
      expect(src, f).toMatch(/setPreview\(String\(data\)\)/);
    }
  });

  it('「不像机器」块补了路标词/对仗/具体化三条', () => {
    const core = strip(read('lib/studio/draft-core.ts'));
    expect(core).toMatch(/首先\/其次\/最后/);
    expect(core).toMatch(/不仅…而且/);
    expect(core).toMatch(/写具体/);
  });
});
