import { describe, it, expect } from 'vitest';
import { scanAiFlavor, aiFlavorBanBlock, AI_FLAVOR_LEXICON } from '@/lib/humanize/lexicon';

describe('AI 味词库', () => {
  it('命中带位置，可用于编辑器高亮', () => {
    const text = '值得注意的是，这个方法很好用。';
    const hits = scanAiFlavor(text);
    expect(hits.length).toBe(1);
    expect(hits[0].word).toBe('值得注意的是');
    expect(text.slice(hits[0].start, hits[0].end)).toBe('值得注意的是');
  });

  it('长词优先：重叠区间只保留更长的那条，同一处不报两遍', () => {
    // 「随着社会的发展」含「随着」…若不去重会一处报两条，用户以为有两个问题
    const hits = scanAiFlavor('随着社会的发展，大家越来越忙。');
    expect(hits.map((h) => h.word)).toEqual(['随着社会的发展']);
  });

  it('多处命中按出现顺序返回', () => {
    const hits = scanAiFlavor('众所周知，A 很好。综上所述，B 更好。');
    expect(hits.map((h) => h.word)).toEqual(['众所周知', '综上所述']);
  });

  it('干净文本零命中', () => {
    expect(scanAiFlavor('昨天我把三个老客户砍了。就这么简单。')).toEqual([]);
  });

  it('空输入不炸', () => {
    expect(scanAiFlavor('')).toEqual([]);
  });

  it('禁用词表只收权重 ≥2 的词——权重 1 的词人也常用，写进禁令会把稿子改别扭', () => {
    const block = aiFlavorBanBlock();
    const weakWords = AI_FLAVOR_LEXICON.filter((e) => e.weight === 1).map((e) => e.word);
    // 「因此」是权重 1，不该出现在禁令里
    expect(weakWords).toContain('因此');
    const banned = block.split('\n')[1].split('、');
    expect(banned).not.toContain('因此');
    expect(banned).toContain('值得注意的是');
  });

  it('禁用词表有上限，不会把 prompt 撑爆', () => {
    const banned = aiFlavorBanBlock(10).split('\n')[1].split('、');
    expect(banned.length).toBe(10);
  });

  it('词库里没有平台真实用语（不许把真人天天说的话当 AI 腔）', () => {
    const words = AI_FLAVOR_LEXICON.map((e) => e.word);
    for (const real of ['码住', '建议收藏', '姐妹们', '家人们', '绝了']) {
      expect(words).not.toContain(real);
    }
  });
});
