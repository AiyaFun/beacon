import { describe, it, expect } from 'vitest';
import { stripMemoryTags, memoryLine } from '@/lib/memory/core';

// 记忆行的 `[类型 · 时间 · 已重复验证N次]` 前缀是给模型看的元信息，绝不能出现在用户看到的正文里。
//
// 为什么是代码而不是 prompt：真机 2026-07-30（MiniMax-Text-01）三轮加码全部失败——
//   第 1 轮 prompt 只说「不要把类型名念进句子」→ 6 条推荐理由里 1 条带标注出街；
//   第 2 轮补一句「不许把方括号那段标注原样抄进回答」→ 反而涨到 5 条（越强调越显著）。
// 「模型必须记得不做某事」这类约束靠 prompt 是概率性的。prompt 里那几条留着降低发生率，
// 但最终保证由 stripMemoryTags 在出口给。

describe('stripMemoryTags', () => {
  it('洗掉 memoryLine 真实产出的标注，保留后面的句子', () => {
    const line = memoryLine('persona', '账号定位：家庭理财与保险避坑博主', new Date(), 1);
    expect(line).toMatch(/^\[.*记忆.*\]/); // 前提：memoryLine 确实带这个前缀
    expect(stripMemoryTags(`依据${line}，该切入角度契合。`)).toBe(
      '依据账号定位：家庭理财与保险避坑博主，该切入角度契合。',
    );
  });

  it('真机抓到的四种形态都洗得掉', () => {
    for (const tag of ['[人设记忆 · 今天]', '[热点记忆 · 更早]', '[合规记忆 · 更早]', '[偏好记忆 · 上月 · 已重复验证3次]']) {
      expect(stripMemoryTags(`${tag} 正文内容`), `未洗掉：${tag}`).toBe('正文内容');
    }
  });

  it('一段里出现多次也全洗（真机出现过一条理由里三个标注）', () => {
    const out = stripMemoryTags('[热点记忆 · 更早] A，又因为 [合规记忆 · 更早] B，所以 C。');
    expect(out).not.toContain('[');
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
  });

  it('不误伤正常方括号（只认「…记忆 ·」这个形状）', () => {
    for (const keep of ['参考[1]的数据', '用[停顿]标注口播节奏', '成本[高]']) {
      expect(stripMemoryTags(keep), `误删了：${keep}`).toBe(keep);
    }
  });

  it('空值安全', () => {
    expect(stripMemoryTags('')).toBe('');
  });
});

describe('stripMemoryTags · 删完之后的接缝', () => {
  it('「根据[标注]的记录」删完不留「根据的记录」', () => {
    expect(stripMemoryTags('根据[人设记忆 · 今天]的记录，账号面向新手。')).toBe('根据记录，账号面向新手。');
  });

  it('没有标注时绝不动正常文本（「我根据的是数据」不许被改）', () => {
    for (const keep of ['我根据的是数据', '依据的标准很明确', '基于的假设有问题']) {
      expect(stripMemoryTags(keep), `误改了：${keep}`).toBe(keep);
    }
  });
});
