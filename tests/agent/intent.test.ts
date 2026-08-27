import { describe, it, expect } from 'vitest';
import { looksActionable } from '@/lib/agent/intent';

// 「问一句」答完之后要不要亮出「让它直接去做」那个按钮。
//
// 误判的代价不对称：多亮一个按钮 = 用户忽略它；少亮 = 那条路没了。
// 所以往召回偏，但纯咨询句必须排除——每条回答后面都挂个按钮就成了背景噪音。

describe('是派活', () => {
  const yes = [
    '帮我建个草稿',
    '帮我想 3 个本周选题',
    '给我来5条选题',
    '把我监控的对标账号都采一遍最新数据',
    '添加一个竞对，链接是 https://example.com',
    '跑一遍小红书日更三件套',
    '按我的人设生成 6 条选题推荐',
    '这篇稿子排发布',
    // 问句形式的派活：最典型的中文说法，只看问号会把这一整类漏掉
    '能不能帮我建个草稿',
    '可以帮我采一下抖音的数据吗',
  ];
  for (const t of yes) it(`「${t}」`, () => expect(looksActionable(t)).toBe(true));
});

describe('不是派活', () => {
  const no = [
    '这条标题怎么改更抓人',
    '我的账号适合做什么变现',
    '给我一些建议', // 「建议」里有「建」——单字动作词会在这儿串台
    '草稿是怎么创建的',
    '发布之前要注意什么',
    '智能体和技能有什么区别',
    '有没有必要每天都发',
    '为什么我的播放量掉了',
    '',
    '  ',
  ];
  for (const t of no) it(`「${t || '(空)'}」`, () => expect(looksActionable(t)).toBe(false));
});

describe('这些判据坏掉的时候会怎样（改坏任一条都要变红）', () => {
  it('单字动作词会串台，所以词表里一律用两字以上的组合', () => {
    // 「建」撞「建议」、「采」撞「采纳」、「排」撞「排名」、「加」撞「参加」。
    // 同 [[beacon-metric-parsing-pitfalls]] 的子串陷阱：串台了也不会报错，只会静静地误判
    expect(looksActionable('给我一些建议')).toBe(false);
    expect(looksActionable('我采纳了这个说法')).toBe(false);
    expect(looksActionable('这条排名第几')).toBe(false);
    expect(looksActionable('我想参加这个活动')).toBe(false);
  });

  it('「动词+数量」这一族只在紧跟数量时才算，否则「我想知道」全被误判', () => {
    expect(looksActionable('我想知道播放量怎么算')).toBe(false);
    expect(looksActionable('这个流量来源是什么')).toBe(false);
    expect(looksActionable('出现了一个报错')).toBe(false);
    // 紧跟数量的才算
    expect(looksActionable('想 3 个选题')).toBe(true);
    expect(looksActionable('出6条脚本')).toBe(true);
  });

  it('委派词优先于问句标志——顺序反了，最常见的说法整类漏掉', () => {
    // 「能不能帮我建个草稿」同时命中问句（能不能）与委派（帮我）。
    // 判定次序若改成「先看问句就 return false」，这一条会变成 false
    expect(looksActionable('能不能帮我建个草稿')).toBe(true);
    // 而没有委派词的同款问句仍然是咨询
    expect(looksActionable('草稿能不能自动创建')).toBe(false);
  });

  it('超长输入直接不判——那已经是一段贴进来的正文，不是一句指令', () => {
    expect(looksActionable('帮我建个草稿'.repeat(400))).toBe(false);
  });
});

describe('wantsExecution：明说要执行的直通执行侧', () => {
  it('「帮我去执行一下今天的采集」→ true（2026-08-26 用户原话，之前只得到一篇计划）', async () => {
    const { wantsExecution } = await import('@/lib/agent/intent');
    expect(wantsExecution('帮我去执行一下今天的采集')).toBe(true);
    expect(wantsExecution('执行一下小红书日更')).toBe(true);
    expect(wantsExecution('直接去做今天的选题推荐')).toBe(true);
  });
  it('普通提问与普通派活不直通——那条路仍走「先答后做」', async () => {
    const { wantsExecution } = await import('@/lib/agent/intent');
    expect(wantsExecution('执行模式是什么意思')).toBe(false);
    expect(wantsExecution('帮我想 3 个选题')).toBe(false);
    expect(wantsExecution('采集是怎么工作的')).toBe(false);
    expect(wantsExecution('执行一下是什么意思')).toBe(false);
  });
  it('查系统数据的说法直通执行侧（对话侧没工具，只会编造）', async () => {
    const { wantsExecution } = await import('@/lib/agent/intent');
    expect(wantsExecution('给我今天的选题')).toBe(true);   // 2026-08-26 真机原话
    expect(wantsExecution('看看我的竞对最近的动态')).toBe(true);
    expect(wantsExecution('查一下本周的数据')).toBe(true);
    // 疑问口吻照旧走对话
    expect(wantsExecution('选题是什么意思')).toBe(false);
    expect(wantsExecution('我的选题怎么没了')).toBe(false);
  });
});
