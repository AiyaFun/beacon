import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeVoice, voicePromptBlock, checkVoiceFit, MIN_VOICE_CHARS } from '@/lib/humanize/voice';
import { emptyPersona } from '@/lib/persona';

// 账号的说话方式（2026-09-17，用户：「就地起稿，包括视角，语气，口吻等等
// 都要按照账号的记忆和方法出现」）。
//
// 人设卡给的是标签（「语气风格：轻松幽默」），模型只能回给你「它理解的平均幽默」。
// 这里量的是可执行、可核对的几条：用「我」还是「我们」、管读者叫什么、句子多长、
// 爱不爱用感叹号和 emoji。量不出来就如实说量不出来，绝不拿默认值去纠正用户真实的写法。

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 一个「我 + 你 + 不用感叹号 + 不用 emoji」的账号
const SAMPLES = [
  [
    '我做这行第六年了，见过太多人一上来就问投产比。',
    '你要是刚开始，先别算这个账。头三个月你连基准线都没有，算出来的数只会骗自己。',
    '我自己的做法是先跑满三十条，再回头看哪五条是有人愿意看完的。剩下的二十五条不是浪费，是底噪。',
    '你手上如果只有一个小时，我建议你全花在选题上，别花在剪辑上。',
  ].join('\n'),
  [
    '我上周把三条旧稿翻出来重写了一遍。',
    '你可能以为重写是为了涨粉，其实不是。我是想看看半年前的判断到底错在哪。',
    '结论有点扎心：错的不是表达，是选题。当时我以为别人关心的事，其实没人关心。',
  ].join('\n'),
];

describe('量说话方式', () => {
  it('量得出人称、怎么称呼读者、句长、标点与 emoji 习惯', () => {
    const v = analyzeVoice(SAMPLES, emptyPersona(), ['先别算这个账']);
    expect(v.source).toBe('samples');
    expect(v.person).toBe('first');
    expect(v.readerAddress).toBe('你');
    expect(v.sentenceLen).toBeGreaterThan(10);
    expect(v.exclaim).toBe('few');
    expect(v.emoji).toBe('no');
    expect(v.catchphrases).toContain('先别算这个账');
  });

  it('「我们」是先数的：不会把每个「我们」都算成一次「我」', () => {
    const we = [
      '我们团队今年只做了一件事：把发布节奏从每天一条压到每周三条。',
      '我们发现，压下来之后完读率反而涨了。你可以理解为读者开始相信我们不会浪费他的时间。',
      '我们不打算再加量了，至少今年不加。这件事我们讨论了两个月，结论是宁可少发也不要发废稿。',
      '我们把省下来的时间放到了选题上。以前一周出七条，真正想清楚的可能只有一条；现在一周三条，每条都过得了我们自己这一关。',
      '我们也不确定这个节奏能撑多久，先跑一个季度再说。',
    ].join('\n');
    expect(analyzeVoice([we]).person).toBe('first_plural');
  });

  it('🔒 样本不足就不下结论（source 不是 samples，一条都不判）', () => {
    const tiny = analyzeVoice(['我今天很忙。'], { ...emptyPersona(), tone: '克制、偶尔自嘲' });
    expect(tiny.sampleChars).toBeLessThan(MIN_VOICE_CHARS);
    expect(tiny.source).toBe('persona');
    // 没有样本时拿默认值去纠正用户真实的写法 = 帮倒忙
    expect(checkVoiceFit('我们认为这件事很重要。我们会继续观察。', tiny)).toEqual([]);
    expect(voicePromptBlock(tiny)).toMatch(/克制、偶尔自嘲/);
    expect(voicePromptBlock(tiny)).toMatch(/还没有可供学习的历史正文/);
  });

  it('指令块是可执行的几条，并写死「只借语感不许搬内容」', () => {
    const block = voicePromptBlock(analyzeVoice(SAMPLES, emptyPersona(), []));
    expect(block).toMatch(/用「我」开口/);
    expect(block).toMatch(/管读者叫「你」/);
    expect(block).toMatch(/一个字都不许搬/);
  });
});

describe('验新稿子是不是他在说', () => {
  const spec = analyzeVoice(SAMPLES, emptyPersona(), []);

  it('人称对不上要报', () => {
    const bad = '我们认为这个方法值得一试。我们建议先跑三十条再复盘，我们会持续跟进效果。';
    const out = checkVoiceFit(bad, spec);
    expect(out.map((v) => v.code)).toContain('voice_person');
    expect(out[0].fix).toMatch(/我/);
  });

  it('称呼对不上要报（他叫「你」，稿子叫「大家」）', () => {
    const bad = '大家好，这个方法大家可以先跑三十条试试，大家有问题再说。';
    expect(checkVoiceFit(bad, spec).map((v) => v.code)).toContain('voice_reader');
  });

  it('他从不用 emoji，稿子里冒出来要报', () => {
    expect(checkVoiceFit('我先跑了三十条😴，再回头看哪五条有人看完。', spec).map((v) => v.code)).toContain('voice_emoji');
  });

  it('对得上就一条都不报', () => {
    expect(checkVoiceFit('我先跑满三十条，再回头看哪五条有人愿意看完。你要是刚开始，别急着算投产比。', spec)).toEqual([]);
  });
});

describe('🔒 接线：说话方式随账号上下文走，每个起稿出口都拿得到', () => {
  it('account-context 有 voice 块，且与原句样本吃同一批样本', () => {
    const src = strip(read('lib/account-context.ts'));
    expect(src).toMatch(/analyzeVoice\(/);
    expect(src).toMatch(/parts\.voice = voicePromptBlock\(voice\)/);
    // 两块共用一次取样：分开取会出现「样本块是 A 文、规格按 B 文量」的错位
    expect(src).toMatch(/want\.has\('exemplar'\) \|\| want\.has\('voice'\)/);
  });

  it('起稿出口的 blocks 里都带 voice', () => {
    const files = ['lib/studio/draft-core.ts', 'app/(app)/studio/actions.ts'];
    for (const f of files) {
      const src = read(f);
      const lists = src.match(/blocks: \[[^\]]*'exemplar'[^\]]*\]/g) ?? [];
      expect(lists.length, f).toBeGreaterThan(0);
      for (const l of lists) expect(l, `${f}: ${l}`).toContain("'voice'");
    }
  });

  it('成稿收口会拿 voice 规格去验人称与称呼', () => {
    const src = strip(read('lib/studio/humanize-pass.ts'));
    expect(src).toMatch(/checkVoiceFit\(/);
    expect(src).toMatch(/voiceProblemBlock/);
    expect(src).toMatch(/voice: input\.accountCtx\?\.voice/);
  });
});
