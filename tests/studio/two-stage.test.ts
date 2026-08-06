import { describe, it, expect } from 'vitest';
import { buildOutlinePrompt, buildVoicePrompt, cleanOutline, stripStageLabels } from '@/lib/studio/two-stage';

// 深度模式的两段提示词。锁的是那两条纪律——它们一松，这个模式就退化成「多花一倍的钱做润色」。

describe('第一段：要点大纲', () => {
  const p = buildOutlinePrompt({
    platformName: '小红书',
    topicTitle: '砍掉老客户',
    topicAngle: '算账视角',
    contextBlock: '【素材库】三年老客户的经历',
    selectionBlock: '【这个选题为什么值得做】同题在抖音已爆',
  });

  it('明确要求短语、不许写成成品句子（否则第二段变成照抄）', () => {
    expect(p).toContain('不要写成完整的成品句子');
  });

  it('缺素材要如实写「（缺具体案例）」，不许编', () => {
    expect(p).toContain('（缺具体案例）');
    expect(p).toContain('绝不编造');
  });

  it('不许出现「数据支撑：」这类字段名——真机上一提「数据」模型就自己造了一个', () => {
    expect(p).toContain('不要写「数据支撑：」');
    expect(p).not.toContain('哪个数据');
  });

  it('账号上下文与选题上下文都进得去', () => {
    expect(p).toContain('三年老客户的经历');
    expect(p).toContain('同题在抖音已爆');
  });

  it('缺省块不留空行噪声', () => {
    const bare = buildOutlinePrompt({ platformName: '抖音', topicTitle: 'T' });
    expect(bare).not.toContain('\n\n\n');
  });
});

describe('第二段：按语感成稿', () => {
  const p = buildVoicePrompt({
    platformName: '小红书',
    outline: '钩子点：砍客户',
    personaBlock: '【人设】自由职业者',
    voiceBlock: '【他自己写的原文样本】…',
    styleHint: '小红书图文：口语化',
    banBlock: '【禁用词表】综上所述',
  });

  it('硬约束：不许新增大纲里没有的事实', () => {
    expect(p).toContain('不许新增大纲里没有的事实');
  });

  it('要求抹掉大纲痕迹（否则成稿看着像 PPT）', () => {
    expect(p).toContain('不要保留任何大纲的痕迹');
  });

  it('语感块与禁用词表都在', () => {
    expect(p).toContain('原文样本');
    expect(p).toContain('禁用词表');
  });
});

describe('大纲清洗', () => {
  it('剥掉 ``` 围栏', () => {
    expect(cleanOutline('```\n钩子点：A\n要点1：B\n```')).toBe('钩子点：A\n要点1：B');
  });

  it('丢掉「好的，这是大纲：」这类客套首行（否则「好的」会被当成信息喂给第二段）', () => {
    expect(cleanOutline('好的，大纲如下：\n钩子点：A')).toBe('钩子点：A');
  });

  it('正常大纲一个字不动', () => {
    const t = '钩子点：三年老客户，一年赚的抵不上熬的夜\n要点1：算账（真实数字）';
    expect(cleanOutline(t)).toBe(t);
  });

  it('单行内容不会被误删', () => {
    expect(cleanOutline('钩子点：A')).toBe('钩子点：A');
  });

  it('空输入不炸', () => {
    expect(cleanOutline('')).toBe('');
  });
});

describe('第二段的成品化约束（真机上踩过的）', () => {
  it('禁掉「标题：」「正文：」这类标签开头——那是大纲思维的残留，用户还得手删一遍', () => {
    const p = buildVoicePrompt({ platformName: '小红书', outline: 'x' });
    expect(p).toContain('不要输出「标题：」「正文：」');
  });
});

describe('成稿标签清洗（提示词禁了模型照样输出，只能代码兜底）', () => {
  it('脱掉「### 标题：」保留标题内容本身', () => {
    const out = stripStageLabels('### 标题：上周我砍了老客户\n\n正文第一段。');
    expect(out.startsWith('上周我砍了老客户')).toBe(true);
    expect(out).toContain('正文第一段。');
  });

  it('独占一行的「**正文：**」整行删掉', () => {
    expect(stripStageLabels('**正文：**\n内容开始')).toBe('内容开始');
  });

  it('正文里正常出现的冒号不受影响', () => {
    const t = '我问自己：这活到底图什么？\n答案是：不图什么。';
    expect(stripStageLabels(t)).toBe(t);
  });

  it('没有标签时原样返回', () => {
    expect(stripStageLabels('干净的正文。')).toBe('干净的正文。');
  });

  it('空输入不炸', () => {
    expect(stripStageLabels('')).toBe('');
  });
});
