import { describe, it, expect } from 'vitest';
import { splitForDiff, diffSentences, diffStats } from '@/lib/studio/diff';

const text = (ops: ReturnType<typeof diffSentences>, type: 'same' | 'add' | 'del') =>
  ops.filter((o) => o.type === type).map((o) => o.text).join('');

describe('版本对比 · 切句', () => {
  it('按句末标点切，标点跟着前一句走（拼回去必须等于原文）', () => {
    const src = '第一句。第二句！第三句？';
    expect(splitForDiff(src)).toEqual(['第一句。', '第二句！', '第三句？']);
    expect(splitForDiff(src).join('')).toBe(src);
  });

  it('换行自成一个 token，末尾没标点的残句也保留', () => {
    expect(splitForDiff('甲。\n乙')).toEqual(['甲。', '\n', '乙']);
  });

  it('任意输入拼回去都还原原文——diff 的正确性全靠这条', () => {
    for (const s of ['', '没有标点', '甲。乙！丙？丁；戊;', '\n\n\n', 'a。\nb。']) {
      expect(splitForDiff(s).join(''), JSON.stringify(s)).toBe(s);
    }
  });
});

describe('版本对比 · diff', () => {
  it('完全相同 → 只有 same', () => {
    const ops = diffSentences('甲。乙。', '甲。乙。');
    expect(ops).toEqual([{ type: 'same', text: '甲。乙。' }]);
  });

  it('中间换了一句：前后保留，只标出改动的那句', () => {
    const ops = diffSentences('甲。乙。丙。', '甲。改了。丙。');
    expect(text(ops, 'same')).toBe('甲。丙。');
    expect(text(ops, 'del')).toBe('乙。');
    expect(text(ops, 'add')).toBe('改了。');
  });

  it('纯新增：没有 del', () => {
    const ops = diffSentences('甲。', '甲。乙。');
    expect(ops.some((o) => o.type === 'del')).toBe(false);
    expect(text(ops, 'add')).toBe('乙。');
  });

  it('纯删除：没有 add', () => {
    const ops = diffSentences('甲。乙。', '甲。');
    expect(ops.some((o) => o.type === 'add')).toBe(false);
    expect(text(ops, 'del')).toBe('乙。');
  });

  it('相邻同类会合并，不会渲染成一串碎色块', () => {
    const ops = diffSentences('甲。', '乙。丙。丁。');
    expect(ops.filter((o) => o.type === 'add')).toHaveLength(1);
  });

  it('把 del 拼回去是旧稿，把 same+add 拼回去是新稿（顺序也要对）', () => {
    const before = '开头。中间一句。结尾。';
    const after = '开头。换了的中间。又加一句。结尾。';
    const ops = diffSentences(before, after);
    expect(ops.filter((o) => o.type !== 'add').map((o) => o.text).join('')).toBe(before);
    expect(ops.filter((o) => o.type !== 'del').map((o) => o.text).join('')).toBe(after);
  });

  it('空对空返回空数组，不产出假的改动', () => {
    expect(diffSentences('', '')).toEqual([]);
  });

  it('超长输入退化成整篇替换而不是把页面算死', () => {
    const huge = '句。'.repeat(2000);
    const ops = diffSentences(huge, `${huge}尾巴`);
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe('del');
    expect(ops[1].type).toBe('add');
  });
});

describe('版本对比 · 统计', () => {
  it('按字符数算，空白不计', () => {
    const s = diffStats([
      { type: 'same', text: '一二三 ' },
      { type: 'add', text: '四五' },
      { type: 'del', text: '六' },
    ]);
    expect(s).toMatchObject({ kept: 3, added: 2, removed: 1 });
  });

  it('从空稿写出内容算 100% 改动，且不会出现除零', () => {
    expect(diffStats([{ type: 'add', text: '新写的' }]).changedRatio).toBe(100);
    expect(diffStats([]).changedRatio).toBe(0);
  });
});
