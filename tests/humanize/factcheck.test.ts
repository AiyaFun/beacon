import { describe, it, expect } from 'vitest';
import { checkFactDrift, extractNumbers } from '@/lib/humanize/factcheck';

// 真机上抓到的那个失败：喂了风格样本去改写，模型把**样本里**的「只留五个客户」「涨了两成」
// 写进了一篇原文没提过这些数的稿子。提示词已经加了硬约束，这里是确定性的第二道闸。

describe('事实漂移检查', () => {
  it('抓出改写后新冒出来的数字', () => {
    const before = '我砍掉了一批老客户，现在轻松多了。';
    const after = '我砍掉了一批老客户，现在只留五个，收入还涨了两成。';
    const r = checkFactDrift(before, after);
    expect(r.added).toContain('五个');
    expect(r.added).toContain('两成');
    expect(r.warning).toContain('核对');
  });

  it('原文有的数字不算漂移', () => {
    const r = checkFactDrift('三年老客户，收入涨了20%', '合作三年的老客户，收入涨了20%');
    expect(r.added).toEqual([]);
    expect(r.warning).toBe('');
  });

  it('同一个数换个写法不误报（20 → 20%）', () => {
    expect(checkFactDrift('涨了20', '涨了20%').added).toEqual([]);
  });

  it('孤零零的「一/半/两」这类字不当事实（否则「一直」「一些」全变告警）', () => {
    expect(extractNumbers('一直这样，有一些想法')).not.toContain('一');
    expect(checkFactDrift('这事我想了很久', '这事我一直在想，有一些新想法').added).toEqual([]);
  });

  it('中文数字整串抓，不把「三个通宵」和「三成」混为一谈', () => {
    const r = checkFactDrift('熬了三个通宵', '熬了三个通宵，利润涨了三成');
    expect(r.added).toEqual(['三成']);
  });

  it('空输入不炸', () => {
    expect(checkFactDrift('', '').added).toEqual([]);
  });
});
