import { describe, it, expect } from 'vitest';
import { extractConcerns, kindBreakdown } from '@/lib/insight/reader-voice';

// 「粉丝在关心什么」的话题提取。这块最容易出的错不是漏词，而是**印出一堆看着像结论的噪声**：
// 满屏「这个」「怎么」，或者同一件事被拆成「多少钱 / 少钱 / 多少」三行占满榜单。

describe('话题提取', () => {
  it('统计的是「多少条评论提到」，不是总出现次数', () => {
    // 同一条评论里把「价格」说三遍，说明这个人啰嗦，不是三个人在关心
    const topics = extractConcerns(['价格价格价格到底多少', '价格能便宜点吗']);
    const price = topics.find((t) => t.term === '价格');
    expect(price?.docs).toBe(2);
  });

  it('只有一条评论提到的词不算「大家在关心」', () => {
    const topics = extractConcerns(['独一无二的怪词汇出现在这里', '完全不相干的另一句话']);
    expect(topics.find((t) => t.term.includes('怪词'))).toBeUndefined();
  });

  it('子串被父串吃掉时不重复上榜', () => {
    const texts = ['这个多少钱啊', '想知道多少钱', '多少钱能拿下'];
    const terms = extractConcerns(texts).map((t) => t.term);
    expect(terms).toContain('多少钱');
    // 「少钱」必然与「多少钱」同频，留着只是把同一件事说两遍
    expect(terms).not.toContain('少钱');
  });

  it('纯虚词不上榜', () => {
    // 三条评论**只**共享虚词，一个话题都不该产出。
    // ⚠️ 断言必须是「整个结果为空」，不能逐个 not.toContain('这个')/('是不')：
    // 去掉停用词闸后上榜的是 4-gram「这个是不」，子串吸收顺手把「这个」「是不」都吃掉了，
    // 逐词断言照样全绿——这条测试第一版就是这么假绿的。
    const texts = ['这个是不是很好', '这个是不是可以', '这个是不是能行'];
    expect(extractConcerns(texts)).toEqual([]);
  });

  it('两字词里含虚字的一律丢（真机上「声了」是这么冒出来的）', () => {
    // 「太大声了」「盖过人声了」——滑窗跨过词边界粘出的「声了」曾经真的上了话题榜
    const texts = ['背景音乐太大声了', '音乐盖过人声了'];
    const terms = extractConcerns(texts).map((t) => t.term);
    expect(terms).toContain('音乐');
    expect(terms).not.toContain('声了');
  });

  it('含实义字的词不会被当虚词误杀', () => {
    const texts = ['什么时候更新下一期', '什么时候能看到新的'];
    const terms = extractConcerns(texts).map((t) => t.term);
    // 「什么」是虚词，但「什么时候」里有「时」「候」，是真的在问时间
    expect(terms.some((t) => t.includes('时候'))).toBe(true);
  });

  it('不跨标点拼词（跨句 n-gram 是纯噪声）', () => {
    // 两条**用同一个标点**才测得到这条：标点不同的话跨句 gram 各自 docs=1，
    // 达不到上榜门槛，去掉切分逻辑测试照样绿（第一版就是这么假绿的）。
    const texts = ['真好看。价格多少', '很好看。价格贵吗'];
    const terms = extractConcerns(texts).map((t) => t.term);
    expect(terms).toContain('价格');
    // 真正的判据：产出的词里不能有任何标点——有就说明滑窗越过了句子边界
    for (const t of terms) expect(t).not.toMatch(/[。，、；：！？\s]/);
  });

  it('每个话题带例句——只给数字不给出处等于让人凭空信', () => {
    const topics = extractConcerns(['这个镜头怎么调的', '镜头参数能说下吗']);
    const lens = topics.find((t) => t.term === '镜头');
    expect(lens?.samples.length).toBeGreaterThan(0);
    expect(lens?.samples[0]).toContain('镜头');
  });

  it('空输入返回空表，不编', () => {
    expect(extractConcerns([])).toEqual([]);
  });
});

describe('分类占比', () => {
  it('按 kind 计数并给出占比', () => {
    const rows = [{ kind: 'praise' }, { kind: 'praise' }, { kind: 'question' }, { kind: 'other' }];
    const b = kindBreakdown(rows);
    expect(b[0]).toMatchObject({ kind: 'praise', count: 2, pct: 0.5 });
    expect(b.map((k) => k.kind)).not.toContain('demand'); // 零的不占位
  });

  it('未知 kind 归到 other，不自己新造一类', () => {
    const b = kindBreakdown([{ kind: 'sentiment_positive_0.87' }]);
    expect(b).toEqual([{ kind: 'other', count: 1, pct: 1 }]);
  });

  it('空输入不除零', () => {
    expect(kindBreakdown([])).toEqual([]);
  });
});
