import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyHit, applyAllHits, applySnippet, canApply, normalizeSuggestion } from '@/lib/compliance/apply';

// 合规命中的一键修改（2026-09-17，用户：「合规命中部分，可以点检一键修改」）。
//
// 改之前这一块的状态：合规中心只能一条一条点「使用建议」，而且用的是 replaceAll；
// 创作工坊里命中词只是带 tooltip 的标签，连点都点不了；
// 「AI 安全改写」的 runRewrite 早就写好了，却没有任何按钮调它（写了没接）。

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const hit = (text: string, word: string, suggestion: string, nth = 0) => {
  let start = -1;
  for (let i = 0; i <= nth; i++) start = text.indexOf(word, start + 1);
  return { word, start, end: start + word.length, suggestion };
};

describe('按位置改掉一处', () => {
  const text = '这款面膜效果最好，用过的人都说效果最好。';

  it('🔒 只改点中的那一处，同一个词在别处原样保留', () => {
    // replaceAll 会把两处一起改掉——用户点的是第一处，第二处不该被动
    const out = applyHit(text, hit(text, '效果最好', '很多人回购'));
    expect(out).toBe('这款面膜很多人回购，用过的人都说效果最好。');
  });

  it('🔒 位置对不上（报告是改正文之前出的）就不动，绝不瞎切', () => {
    const stale = { word: '效果最好', start: 0, end: 4, suggestion: '很多人回购' };
    expect(canApply(text, stale)).toBe(false);
    expect(applyHit(text, stale)).toBe(text);
  });

  it('没有替代说法的不给改（产品不替用户编一个合规说法）', () => {
    expect(canApply(text, { ...hit(text, '效果最好', ''), suggestion: undefined })).toBe(false);
    expect(canApply(text, hit(text, '效果最好', '效果最好'))).toBe(false); // 建议与原词相同 = 没改
  });

  it('越界的位置不炸', () => {
    expect(applyHit('短', { word: '短', start: 0, end: 99, suggestion: 'x' })).toBe('短');
  });
});

describe('🔒 词库里的「建议」不都是能直接替进去的词', () => {
  // 真机点了一次「一键改掉这 7 处」才发现的：全库 427 条 suggestion 都写成括号形式，
  // 里面一半是说明而不是替换词，硬替进去写出来的是病句
  //（「这款面膜效果（更优选择之一 / 建议）」）。
  it('括号壳脱掉，尾部补充说明去掉', () => {
    expect(normalizeSuggestion('（私信我）')).toBe('私信我');
    expect(normalizeSuggestion('（加入粉丝群（站内））')).toBe('加入粉丝群');
    expect(normalizeSuggestion('（知名品牌）')).toBe('知名品牌');
  });

  it('给的是选项或做法说明 → 不给一键替换（照旧显示成建议，自己改）', () => {
    expect(normalizeSuggestion('（更优选择之一 / 建议）')).toBeNull();
    expect(normalizeSuggestion('（已获得 XX 认证，注明具体机构）')).toBeNull();
    expect(normalizeSuggestion('（可能有助于缓解，具体请遵医嘱）')).toBeNull();
    expect(normalizeSuggestion('（销量较好，附统计口径）')).toBeNull();
    expect(normalizeSuggestion('')).toBeNull();
  });

  it('替进去的是脱壳之后的词，不是带括号的原文', () => {
    const text = '加微信私聊。';
    const h = { word: '微信', start: 1, end: 3, suggestion: '（私信我）' };
    expect(canApply(text, h)).toBe(true);
    expect(applyHit(text, h)).toBe('加私信我私聊。');
  });
});

describe('一键改掉全部', () => {
  it('从后往前改，前面几处的偏移不会被动过', () => {
    const text = '全网第一的面膜，100%有效，包治百病。';
    const hits = [
      hit(text, '全网第一', '上个月卖得最多'),
      hit(text, '100%有效', '我用了三周'),
      hit(text, '包治百病', '对我这种干皮有用'),
    ];
    const r = applyAllHits(text, hits);
    expect(r.applied).toBe(3);
    expect(r.text).toBe('上个月卖得最多的面膜，我用了三周，对我这种干皮有用。');
    expect(r.skipped).toBe(0);
  });

  it('没有建议的那几处留着，并如实报出来「这几处得自己改」', () => {
    const text = '全网第一的面膜，加微信私聊。';
    const r = applyAllHits(text, [
      hit(text, '全网第一', '上个月卖得最多'),
      { ...hit(text, '加微信', ''), suggestion: '' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.skippedWords).toContain('加微信');
    expect(r.text).toContain('加微信'); // 没有替代说法的原样留着
  });

  it('重叠的命中只改一处，另一处跳过（同一处被两条词规则同时命中）', () => {
    const text = '这是全网第一的产品。';
    const r = applyAllHits(text, [
      hit(text, '全网第一', 'A'),
      { word: '全网', start: text.indexOf('全网'), end: text.indexOf('全网') + 2, suggestion: 'B' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('空命中列表原样返回', () => {
    expect(applyAllHits('原文', []).text).toBe('原文');
  });
});

describe('语义命中（只有片段没有位置）', () => {
  it('改第一处出现的地方；找不到就不动', () => {
    expect(applySnippet('加我微信 abc 详聊', '加我微信 abc', '私信我')).toBe('私信我 详聊');
    expect(applySnippet('正文', '不存在的片段', 'x')).toBe('正文');
  });
});

describe('🔒 接线：两处都能一键改', () => {
  it('合规中心：按位置替换 + 一键全部 + AI 安全改写按钮真的接上了', () => {
    const src = strip(read('app/(app)/compliance/Checker.tsx'));
    expect(src).toMatch(/applyHit\(text, h\)/);
    expect(src).toMatch(/applyAllHits\(text, fixableHits\)/);
    // runRewrite 以前写了却没有任何按钮调它
    expect(src).toMatch(/onClick=\{runRewrite\}/);
    expect(src).toMatch(/rewrite && \(/);
    // 老写法（replaceAll 全文替换）不许回来
    expect(src).not.toMatch(/replaceAll\(h\.word/);
  });

  it('创作工坊：命中项是可点的按钮，且有一键改掉全部', () => {
    const src = strip(read('app/(app)/studio/Rewriter.tsx'));
    expect(src).toMatch(/onClick=\{\(\) => setText\(applyHit\(text, h\)\)\}/);
    expect(src).toMatch(/applyAllHits\(text, fixableHits\)/);
  });
});
