import { describe, it, expect } from 'vitest';
import { humanizeReport, humanizeProblemBlock, countParallel, MIN_CHARS_FOR_SCORE } from '@/lib/humanize/score';

// 造一段「句长高度均匀 + 套话满满 + 密集对仗」的典型 AI 腔文本
const AI_TEXT = [
  '在这个信息爆炸的时代，每个人都面临着同样的困境。',
  '值得注意的是，方法论的选择决定了最终的结果好坏。',
  '不仅要有清晰的目标，而且要有可执行的具体路径规划。',
  '众所周知，坚持是所有成功者共同拥有的核心品质之一。',
  '综上所述，我们需要系统性地建立属于自己的成长闭环。',
  '希望这篇文章对你有帮助，让我们一起在路上持续精进。',
].join('\n');

// 人写的：句长忽长忽短、有碎句、无套话
const HUMAN_TEXT = [
  '上周我把跟了三年的老客户砍了。',
  '不是吵架，就是算了笔账——他一年给我的钱，抵不上我为他熬的那些夜。',
  '砍完那天晚上我睡得特别好。',
  '说实话，之前我一直以为，客户越多越安全。后来发现根本不是，客户越多，我越不敢涨价，因为我怕丢单，怕到连报价单都要改三遍。',
  '现在只留五个。',
  '收入没掉，反而涨了。',
].join('\n');

describe('人味分', () => {
  it('样本不足不给分（不足 120 字或不足 5 句）', () => {
    const r = humanizeReport('太短了，算不出方差。');
    expect(r.sufficient).toBe(false);
    expect(r.metrics.chars).toBeLessThan(MIN_CHARS_FOR_SCORE);
  });

  it('套话在短文本上照样报——命中就是命中，不需要分布', () => {
    const r = humanizeReport('综上所述，就是这样。');
    expect(r.sufficient).toBe(false);
    expect(r.hits.map((h) => h.word)).toContain('综上所述');
    expect(r.findings.some((f) => f.dimension === '套话密度')).toBe(true);
  });

  it('典型 AI 腔文本：低分且逐条指出问题', () => {
    const r = humanizeReport(AI_TEXT, 'wechat');
    expect(r.sufficient).toBe(true);
    expect(r.score).toBeLessThan(60);
    const dims = r.findings.filter((f) => f.severity !== 'good').map((f) => f.dimension);
    expect(dims).toContain('套话密度');
    expect(dims).toContain('句子节奏');
  });

  it('人写的文本明显高于 AI 腔文本', () => {
    const ai = humanizeReport(AI_TEXT, 'wechat');
    const human = humanizeReport(HUMAN_TEXT, 'wechat');
    expect(human.score).toBeGreaterThan(ai.score + 20);
    expect(human.hits.length).toBe(0);
  });

  it('句长变异系数能区分平铺与起伏', () => {
    const flat = humanizeReport(Array.from({ length: 8 }, () => '这是一句长度完全一样的话呀').join('。'), 'wechat');
    expect(flat.metrics.lenCv).toBeLessThan(0.2);
    expect(humanizeReport(HUMAN_TEXT, 'wechat').metrics.lenCv).toBeGreaterThan(0.45);
  });

  it('对仗句式能被数出来', () => {
    expect(countParallel('不仅要快，而且要稳。')).toBe(1);
    expect(countParallel('无论你在哪都能用。既省钱又省事。')).toBe(2);
    expect(countParallel('今天天气不错，我们出去走走。')).toBe(0);
  });

  it('口语碎句只在口语平台判定：同一段文字在公众号不扣这一项', () => {
    const bookish = [
      '第一段完整表达了一个观点，它有主语谓语和宾语，读起来非常书面。',
      '第二段同样完整表达了另一个观点，它也有主语谓语和宾语，读起来一样书面。',
      '第三段继续保持这种书面语气，把该说的事情说清楚，不使用任何口语碎句。',
      '第四段依旧如此，完整的句子结构贯穿始终，没有出现半句话式的表达方式。',
      '第五段收尾，仍然是完整的书面句子，用来凑够判定所需要的句子数量门槛。',
    ].join('\n');
    const dy = humanizeReport(bookish, 'douyin');
    const wx = humanizeReport(bookish, 'wechat');
    expect(dy.findings.some((f) => f.dimension === '口语碎句' && f.severity !== 'good')).toBe(true);
    expect(wx.findings.some((f) => f.dimension === '口语碎句')).toBe(false);
  });

  it('分数被夹在 20-100', () => {
    const worst = humanizeReport(Array.from({ length: 6 }, () => AI_TEXT).join('\n'), 'douyin');
    expect(worst.score).toBeGreaterThanOrEqual(20);
    expect(worst.score).toBeLessThanOrEqual(100);
  });

  it('问题清单只带要改的，good 不进 prompt', () => {
    const block = humanizeProblemBlock(humanizeReport(AI_TEXT, 'wechat'));
    expect(block).toContain('套话密度');
    expect(block).not.toContain('保持——');
    expect(humanizeProblemBlock(humanizeReport(HUMAN_TEXT, 'wechat'))).not.toContain('套话密度');
  });
});
