import { describe, it, expect } from 'vitest';
import { buildDailyBrief, countByQueue, type BriefTopic } from '@/lib/topic/brief';

// 选题晨报（lib/topic/brief.ts）。用户每天只看这一条通知，措辞即产品契约，故全部钉死在单测里。

function topic(over: Partial<BriefTopic> = {}): BriefTopic {
  return {
    title: '选题标题',
    totalScore: 80,
    queue: 'today',
    angle: '从反常识切入',
    sourceType: 'hot',
    isExploration: false,
    mocked: false,
    ...over,
  };
}

describe('buildDailyBrief', () => {
  it('按时间队列分组，今日突击排在最前', () => {
    const b = buildDailyBrief('测试账号', [
      topic({ title: '本周的题', queue: 'week' }),
      topic({ title: '常青的题', queue: 'evergreen' }),
      topic({ title: '今天的题', queue: 'today' }),
    ])!;
    expect(b.title).toContain('测试账号');
    const text = b.lines.join('\n');
    expect(text.indexOf('今日突击')).toBeLessThan(text.indexOf('本周窗口'));
    expect(text.indexOf('本周窗口')).toBeLessThan(text.indexOf('常青储备'));
  });

  it('每条都带切入角——只给标题和分数，用户还得开网页才知道怎么做', () => {
    const b = buildDailyBrief('测试账号', [topic({ angle: '从亲身翻车切入' })])!;
    expect(b.lines.join('\n')).toContain('切入角：从亲身翻车切入');
  });

  it('有窗口的标出还剩多久', () => {
    const b = buildDailyBrief('测试账号', [topic({ windowHint: '抖音抢跑窗口约剩 13 小时' })])!;
    expect(b.lines.join('\n')).toContain('⏳ 抖音抢跑窗口约剩 13 小时');
  });

  it('常青题不许显示窗口提示——假紧迫感会让真正的抢跑提醒也被无视', () => {
    const b = buildDailyBrief('测试账号', [
      topic({ queue: 'evergreen', windowHint: '无时效压力，任何时候做都成立' }),
    ])!;
    expect(b.lines.join('\n')).not.toContain('⏳');
  });

  it('Mock 分标「示例分」，不冒充真实评分', () => {
    const b = buildDailyBrief('测试账号', [topic({ mocked: true, totalScore: 77 })])!;
    const text = b.lines.join('\n');
    expect(text).toContain('示例分');
    expect(text).not.toContain('77 分');
  });

  it('来源标签用人话（抢跑窗口 / 旧文翻新），不吐 sourceType 原始值', () => {
    const b = buildDailyBrief('测试账号', [
      topic({ title: 'A', sourceType: 'gap' }),
      topic({ title: 'B', sourceType: 'recycle' }),
    ])!;
    const text = b.lines.join('\n');
    expect(text).toContain('抢跑窗口');
    expect(text).toContain('旧文翻新');
    expect(text).not.toContain('sourceType');
  });

  it('每队最多列 3 条，其余引导到网页——晨报是通知不是列表页', () => {
    const many = Array.from({ length: 6 }, (_, i) => topic({ title: `题${i}`, totalScore: 90 - i }));
    const b = buildDailyBrief('测试账号', many)!;
    const text = b.lines.join('\n');
    expect(text).toContain('题0');
    expect(text).toContain('题2');
    expect(text).not.toContain('题3');
    expect(text).toContain('另有 3 条');
  });

  it('队内按分数降序', () => {
    const b = buildDailyBrief('测试账号', [
      topic({ title: '低分题', totalScore: 40 }),
      topic({ title: '高分题', totalScore: 95 }),
    ])!;
    const text = b.lines.join('\n');
    expect(text.indexOf('高分题')).toBeLessThan(text.indexOf('低分题'));
  });

  it('空队列不出现在晨报里（不推「本周窗口 0 条」这种废话行）', () => {
    const b = buildDailyBrief('测试账号', [topic({ queue: 'today' })])!;
    expect(b.lines.join('\n')).not.toContain('本周窗口');
  });

  it('一条都没有 → 返回 null，宁可不推也不推空通知', () => {
    expect(buildDailyBrief('测试账号', [])).toBeNull();
  });

  it('站内信摘要给出队列结构与头条选题', () => {
    const b = buildDailyBrief('测试账号', [
      topic({ title: '头条选题', totalScore: 90 }),
      topic({ title: '本周的题', queue: 'week' }),
    ])!;
    expect(b.summary).toContain('今日突击 1');
    expect(b.summary).toContain('本周窗口 1');
    expect(b.summary).toContain('头条选题');
  });
});

describe('countByQueue', () => {
  it('缺队列字段的按今日算（与 resolveQueue 的落库默认一致）', () => {
    expect(countByQueue([topic({ queue: '' }), topic({ queue: 'week' })])).toEqual({
      today: 1,
      week: 1,
      evergreen: 0,
    });
  });

  it('未知队列值不计入任何一队，也不崩', () => {
    expect(countByQueue([topic({ queue: 'nonsense' })])).toEqual({ today: 0, week: 0, evergreen: 0 });
  });
});
