import { describe, it, expect } from 'vitest';
import { parseAltTitles } from '@/lib/studio/alt-titles';

// 「备选标题」解析器。宁可少认，不要把正文错当标题——错认的代价是给用户一个
// 「把这段正文当草稿标题/封面大字」的按钮，点下去就写坏数据。

describe('parseAltTitles', () => {
  it('认标准形态（小标题独占一行 + 三行标题）', () => {
    const out = `笔记正文……

#理财 #存钱 #副业

备选标题：
30岁才懂的5个存钱习惯
我用三个月存下第一笔应急金
存钱这件事，我踩过的4个坑`;
    expect(parseAltTitles(out)).toEqual([
      '30岁才懂的5个存钱习惯',
      '我用三个月存下第一笔应急金',
      '存钱这件事，我踩过的4个坑',
    ]);
  });

  it('认编号 / 项目符号 / 引号，并去掉它们', () => {
    const out = `备选标题：
1. 第一条标题
- 第二条标题
「第三条标题」`;
    expect(parseAltTitles(out)).toEqual(['第一条标题', '第二条标题', '第三条标题']);
  });

  it('认「备选标题：xxx」写在同一行的情况', () => {
    expect(parseAltTitles('备选标题：只有这一条')).toEqual(['只有这一条']);
  });

  it('容忍小标题后先空一行', () => {
    expect(parseAltTitles('备选标题：\n\n一条标题')).toEqual(['一条标题']);
  });

  it('遇到空行就结束（后面的正文不会被吞进来）', () => {
    const out = `备选标题：
标题甲
标题乙

这是后面又补的一段说明文字，不该被当成标题`;
    expect(parseAltTitles(out)).toEqual(['标题甲', '标题乙']);
  });

  it('🔒 没有「备选标题」小标题时返回空——不猜「最后三行大概是标题」', () => {
    expect(parseAltTitles('就是一段普通正文\n第二行\n第三行')).toEqual([]);
    expect(parseAltTitles('')).toEqual([]);
  });

  it('🔒 过长的行、话题标签行、小标题行都不算标题', () => {
    const out = `备选标题：
${'很'.repeat(41)}`;
    expect(parseAltTitles(out)).toEqual([]);
    expect(parseAltTitles('备选标题：\n#话题标签')).toEqual([]);
    expect(parseAltTitles('备选标题：\n注意事项：')).toEqual([]);
  });

  it('去重、最多 5 条', () => {
    expect(parseAltTitles('备选标题：\n甲\n甲\n乙')).toEqual(['甲', '乙']);
    const many = '备选标题：\n' + ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
    expect(parseAltTitles(many)).toHaveLength(5);
  });
});
