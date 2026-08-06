import { describe, it, expect } from 'vitest';
import { diagnoseTitle, parseTitleMatrix, buildTitlePrompt, titleLengthRule, TITLE_ANGLES } from '@/lib/studio/title';

describe('标题诊断', () => {
  it('小红书超 20 字是硬上限，判 bad 并说明会被截断', () => {
    const d = diagnoseTitle('这是一个非常非常非常长的标题一定会超过二十个字的限制', 'xiaohongshu');
    expect(d.severity).toBe('bad');
    expect(d.notes.join()).toContain('截断');
  });

  it('偏长/偏短只判 warn', () => {
    expect(diagnoseTitle('太短', 'wechat').severity).toBe('warn');
    // 27 字：超过公众号建议区间（26）但没有硬上限 → warn
    expect(diagnoseTitle('这个标题的长度已经超过了公众号的建议区间但是并没有硬上限', 'wechat').severity).toBe('warn');
  });

  it('标题里的套话会被点出来', () => {
    const d = diagnoseTitle('众所周知，做副业要先想清楚三件事', 'wechat');
    expect(d.notes.join()).toContain('套话');
    expect(d.severity).not.toBe('good');
  });

  it('没有数字时提示加一个具体的数', () => {
    expect(diagnoseTitle('我把老客户砍掉之后发生的事', 'wechat').notes.join()).toContain('数字');
  });

  it('中文口语量词也算数字（真机上「涨了两成」曾被误报成「没有任何数字」）', () => {
    for (const t of ['砍掉老客户后收入涨了两成', '只用了半年就把收入做起来了', '收入翻了一倍的那半年']) {
      expect(diagnoseTitle(t, 'wechat').notes.join(), t).not.toContain('没有任何数字');
    }
  });

  it('长度合适 + 有数字 + 无套话 = good', () => {
    const d = diagnoseTitle('砍掉3个老客户后，我的收入涨了', 'wechat');
    expect(d.severity).toBe('good');
  });

  it('未知平台有兜底规则', () => {
    expect(titleLengthRule('unknown-platform').max).toBeGreaterThan(0);
  });
});

describe('标题矩阵解析', () => {
  it('解析正常 JSON', () => {
    const raw = JSON.stringify({
      titles: [{ angle: 'result', title: '收入涨了3倍', why: '结果最直接' }],
      cover: { headline: '砍客户', sub: '只留五个', visual: '手撕合同特写', note: '冲突感' },
    });
    const m = parseTitleMatrix(raw);
    expect(m.titles).toHaveLength(1);
    expect(m.titles[0].angle).toBe('result');
    expect(m.cover?.headline).toBe('砍客户');
  });

  it('容忍 ```json 围栏（有些模型即使被要求只输出 JSON 也会包一层）', () => {
    const m = parseTitleMatrix('```json\n{"titles":[{"angle":"pain","title":"你也这样吗"}]}\n```');
    expect(m.titles).toHaveLength(1);
  });

  it('重复标题只留一条', () => {
    const m = parseTitleMatrix(JSON.stringify({ titles: [{ title: 'A' }, { title: 'A' }, { title: 'B' }] }));
    expect(m.titles.map((t) => t.title)).toEqual(['A', 'B']);
  });

  it('未知角度归为 other，缺 title 的条目直接丢', () => {
    const m = parseTitleMatrix(JSON.stringify({ titles: [{ angle: '瞎编的', title: 'A' }, { angle: 'result' }] }));
    expect(m.titles).toHaveLength(1);
    expect(m.titles[0].angle).toBe('other');
  });

  it('解析不了返回空矩阵（调用方据此如实报失败，不假装有结果）', () => {
    expect(parseTitleMatrix('模型今天心情不好，随便说了点什么').titles).toEqual([]);
    expect(parseTitleMatrix('').cover).toBeNull();
  });

  it('封面缺主文案时整块判空', () => {
    const m = parseTitleMatrix(JSON.stringify({ titles: [{ title: 'A' }], cover: { sub: '只有副标' } }));
    expect(m.cover).toBeNull();
  });
});

describe('标题 prompt', () => {
  it('六个角度全部写进 prompt，且明令不许编造', () => {
    const p = buildTitlePrompt({ platform: 'xiaohongshu', draftTitle: 'T', content: '正文' });
    for (const a of TITLE_ANGLES) expect(p).toContain(a.name);
    expect(p).toContain('不许编造');
    expect(p).toContain('20 字'); // 小红书硬上限进了 prompt
  });
});
