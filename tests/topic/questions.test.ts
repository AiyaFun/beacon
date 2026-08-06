import { describe, it, expect } from 'vitest';
import { isQuestion, extractQuestions, questionToInspiration } from '@/lib/topic/sources/questions';

// 读者提问挖掘（lib/topic/sources/questions.ts）。
// 挖出来的每一条都会变成候选选题，所以判定**刻意从严**：
// 宁可漏掉一些真问题，也绝不把陈述句当成问题灌进推荐池。本文件主要在钉这条边界。

describe('isQuestion 提问判定', () => {
  it('强标记出现即判定为问句，不需要问号', () => {
    expect(isQuestion('新手应该先学哪个好')).toBe(true);
    expect(isQuestion('这个工具值不值得买')).toBe(true);
    expect(isQuestion('请问有教程吗')).toBe(true);
    expect(isQuestion('求推荐几个入门资料')).toBe(true);
  });

  it('弱标记必须配问号——「不管怎么说」不是提问', () => {
    expect(isQuestion('不管怎么说这条我很喜欢')).toBe(false);
    expect(isQuestion('这个到底怎么用的？')).toBe(true);
  });

  it('句末的「吗/呢」不带问号也算——中文评论最常见的提问形态就长这样', () => {
    expect(isQuestion('这个工具收费吗')).toBe(true);
    expect(isQuestion('那我这种情况呢')).toBe(true);
    expect(isQuestion('这个工具收费吗。')).toBe(true); // 尾部标点先剥掉再看
  });

  it('但「吗」不在句末就不算——保守优先', () => {
    expect(isQuestion('我看嘛这条挺好的确实不错')).toBe(false);
  });

  it('纯陈述句一律不算，哪怕很长很有观点', () => {
    expect(isQuestion('讲得真好，我已经三连了支持一下')).toBe(false);
    expect(isQuestion('我按你说的做了效果确实不错')).toBe(false);
  });

  it('太短的没有信息量，太长的多半是长篇分享', () => {
    expect(isQuestion('为什么')).toBe(false);
    expect(isQuestion(`为什么${'很长的铺垫'.repeat(20)}`)).toBe(false);
  });

  it('剥掉「回复 XXX：」「@某人」这类前缀噪声后再判定', () => {
    expect(isQuestion('回复 张三：这个工具收费吗？')).toBe(true);
    expect(isQuestion('@某某 新手应该先学哪个好')).toBe(true);
    expect(isQuestion('3. 这个工具值不值得买')).toBe(true);
  });
});

describe('extractQuestions 归并与排序', () => {
  it('同一个问题的不同问法归成一组，被问次数就是需求强度', () => {
    const raw = [
      '这个工具收费吗？',
      '讲得真好',
      '请问这个工具收费吗',
      '想知道这个工具收费吗，有免费版没',
      '新手应该先学哪个好',
    ].join('\n');
    const qs = extractQuestions(raw);
    expect(qs).toHaveLength(2);
    expect(qs[0].count).toBe(3);
    expect(qs[0].text).toBe('这个工具收费吗？'); // 代表句取最短
    expect(qs[0].variants.length).toBeGreaterThan(0);
  });

  it('被问得多的排前面', () => {
    const raw = ['新手先学哪个好', '这个工具收费吗', '这个工具收费吗？', '这个工具收费吗有免费版'].join('\n');
    expect(extractQuestions(raw)[0].text).toContain('收费');
  });

  it('同一个人刷屏和两个人各问一次算不出区别——那是刻意的：两票就是两票', () => {
    const qs = extractQuestions(['这个工具收费吗？', '这个工具收费吗？'].join('\n'));
    expect(qs[0].count).toBe(2);
    // 但完全相同的句子不会重复出现在 variants 里
    expect(qs[0].variants).toEqual([]);
  });

  it('全是陈述句 → 一条不出（而不是硬挑几条最像的）', () => {
    const raw = ['讲得真好', '已经三连支持', '学到了谢谢分享'].join('\n');
    expect(extractQuestions(raw)).toEqual([]);
  });

  it('空输入不崩', () => {
    expect(extractQuestions('')).toEqual([]);
    expect(extractQuestions('   \n\n  ')).toEqual([]);
  });

  it('limit 生效', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `第${i}个完全不同的疑问是什么呢？`).join('\n');
    expect(extractQuestions(raw, 5).length).toBeLessThanOrEqual(5);
  });
});

describe('questionToInspiration 落库形态', () => {
  it('被问多次时在备注里写清次数——那是这条值不值得做的核心依据', () => {
    const r = questionToInspiration({ text: '这个工具收费吗', count: 5, variants: ['请问收费吗'] });
    expect(r.title).toBe('这个工具收费吗');
    expect(r.note).toContain('被问到 5 次');
    expect(r.note).toContain('请问收费吗');
  });

  it('只被问一次就如实说「读者提问」，不夸大成「被问到 1 次」', () => {
    const r = questionToInspiration({ text: '这个怎么用', count: 1, variants: [] });
    expect(r.note).toBe('读者提问');
  });
});
