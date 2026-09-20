import { describe, it, expect } from 'vitest';
import { structureReport } from '@/lib/humanize/structure';
import { humanizeReport } from '@/lib/humanize/score';
import { judgeDraft } from '@/lib/studio/humanize-pass';

// 结构性 AI 指纹（2026-09-17）。
//
// 这一组测试的由来：用户第二次反馈「就地起稿得内容……还是很强的 ai 味」。
// 把开发库里那份真机初稿拿去跑旧版人味分，结果是 **90 分、判「不需要改」**——
// 自动去 AI 味那一道对最典型的 AI 稿从来没有触发过。
// 下面 REAL_AI_DRAFT 就是那份稿子（按原样节选），它是这一整块的回归钉子：
// **任何一次改动之后，它都必须被判成要改。**

const REAL_AI_DRAFT = [
  '【💤1.2元睡2.5小时！新型午休影城太会玩了🤔】',
  '',
  '👀最近发现了一种超新奇的电影院玩法——午休影院！1.2元就能睡2.5小时，简直是打工人的福音💤。',
  '',
  '📌【目标客群：谁会来？】',
  '',
  '- 传统影院：主要面向周末和晚间的观影人群👫，情侣约会、家庭聚会是主力军。',
  '- 午休影院：瞄准的是白领上班族💼，尤其是那些中午没地方休息的人。',
  '',
  '📌【盈利模式：靠什么赚钱？】',
  '',
  '- 传统影院：主要靠票房收入💰，再加上爆米花🍿、饮料🥤等周边。',
  '- 午休影院：主打空间租赁🏠，提供的是「床位」而不是「座位」。',
  '',
  '🤔【体验感受】',
  '',
  '我亲自去体验了一下午休影院，不得不说，真的很舒服！💤 独立的灯光、柔软的床铺、安静的氛围。',
  '',
  '👇那么问题来了：你会为了午休去体验这种新型影院吗？',
  '',
  '欢迎在评论区分享你的看法哦！😊',
].join('\n');

// 一段真人写的：没有栏目、没有分点模板、没有讨好式收尾
const HUMAN_DRAFT = [
  '中午十二点，写字楼下的电影院开始卖床位。',
  '',
  '一张票一块二，能睡两个半小时。这个价格在任何一个城市都算不上钱，却解决了一个很多人不好意思说出口的问题：中午没地方躺。',
  '',
  '传统影院靠晚上的票房活着，白天的座位是空的。午休影院把这段空着的时间拿出来重新卖了一次，卖的不是电影，是一个能平躺的地方。',
  '',
  '所以问题不是有没有需求，而是谁先想到把闲置的东西重新定价。',
  '',
  '你们公司附近，有这样的地方吗？',
].join('\n');

describe('结构性 AI 指纹', () => {
  it('🔒 回归钉子：真机那份「栏目 + 分点 + 讨好收尾」的初稿必须被判成要改', () => {
    // 旧版（只量方差 + 词表）给这篇打 90 分、judgeDraft 判 needed=false。
    // 如果哪天这条又变绿了，说明自动去 AI 味那一道又对最典型的 AI 稿失效了。
    const v = judgeDraft(REAL_AI_DRAFT, 'xiaohongshu');
    expect(v.needed).toBe(true);
    expect(v.report.score).toBeLessThan(60);
    const bad = v.report.findings.filter((f) => f.severity === 'bad').map((f) => f.dimension);
    expect(bad).toContain('栏目化排版');
    expect(bad).toContain('分点模板');
  });

  it('逐项量得出来：栏目名、定义式分点、讨好收尾、凭空亲历', () => {
    const r = structureReport(REAL_AI_DRAFT, 'xiaohongshu');
    expect(r.stats.sectionLabels).toBeGreaterThanOrEqual(2);
    expect(r.stats.definitionBullets).toBeGreaterThanOrEqual(3);
    expect(r.stats.pleaserEndings).toBeGreaterThanOrEqual(1);
    expect(r.stats.personalClaims).toBeGreaterThanOrEqual(1);
  });

  it('真人写的那篇一条都不报（不许把正常写法判成 AI）', () => {
    const r = structureReport(HUMAN_DRAFT, 'xiaohongshu');
    expect(r.findings.filter((f) => f.severity !== 'good')).toHaveLength(0);
    expect(r.penalty).toBe(0);
    expect(humanizeReport(HUMAN_DRAFT, 'xiaohongshu').score).toBeGreaterThanOrEqual(70);
  });

  it('第一行的标题不算栏目——小红书标题本来就常写成【…】', () => {
    const withTitle = ['【1.2 元睡 2.5 小时，午休影院值不值】', '', '中午十二点，写字楼下的电影院开始卖床位。', '', '一张票一块二。'].join('\n');
    expect(structureReport(withTitle, 'xiaohongshu').stats.sectionLabels).toBe(0);
  });

  it('偶尔用一个 emoji 不报；每段都摆一个才报', () => {
    const light = ['今天试了那家午休影院😴', '', '一块二睡两个半小时。', '', '比在工位上趴着强太多。'].join('\n');
    expect(structureReport(light, 'xiaohongshu').findings.some((f) => f.dimension === '装饰性 emoji')).toBe(false);

    const heavy = ['😴今天试了那家午休影院', '', '💰一块二睡两个半小时', '', '🛏️比工位上趴着强'].join('\n');
    expect(structureReport(heavy, 'xiaohongshu').findings.some((f) => f.dimension === '装饰性 emoji' && f.severity === 'bad')).toBe(true);
  });

  it('口播平台上一个段首 emoji 也要提醒（emoji 是念不出来的）', () => {
    const spoken = ['😴今天试了那家午休影院。', '', '一块二睡两个半小时，比在工位上趴着强。'].join('\n');
    expect(structureReport(spoken, 'douyin').findings.some((f) => f.dimension === '装饰性 emoji')).toBe(true);
    expect(structureReport(spoken, 'wechat').findings.some((f) => f.dimension === '装饰性 emoji')).toBe(false);
  });

  it('🔒 行首「【开头钩子】正文…」也算栏目——它不吃第一行豁免（标题不会和正文挤一行）', () => {
    // 真机上种子草稿就是这么写的，第一版判据只认「独占一行的【xx】」，两条都漏了
    const seed = [
      '【开头钩子】你以为这件事很简单？我一开始也这么想，直到踩了三个坑。',
      '',
      '第一，别急着追求完美，先跑通最小闭环。',
      '',
      '【结尾引导】如果这条对你有用，点个收藏，下期讲具体怎么落地。',
    ].join('\n');
    const r = structureReport(seed, 'douyin');
    expect(r.stats.sectionLabels).toBe(2);
    expect(r.findings.some((f) => f.dimension === '栏目化排版' && f.severity === 'bad')).toBe(true);
  });

  it('🔒 一篇里用一次「——」不算口癖（139 字的稿子里一个破折号 = 6.9/千字）', () => {
    const once = '复盘比努力更重要——每条内容都留一个可改进点。这句话我贴在显示器上半年了。';
    expect(structureReport(once, 'douyin').findings.some((f) => f.dimension === '破折号口癖')).toBe(false);
    const many = '这不是玄学——是概率。你发的每一条——不管多用心——都在跟几万条抢同一批人的三秒钟。';
    expect(structureReport(many, 'douyin').findings.some((f) => f.dimension === '破折号口癖')).toBe(true);
  });

  it('🔒 路标词：一个不报，三个是在念提纲', () => {
    const one = '首先得把钱算清楚。一张票一块二，两个半小时，中午能睡一觉。这笔账每个人都会算。';
    expect(structureReport(one, 'xiaohongshu').findings.some((f) => f.dimension === '路标词')).toBe(false);
    const many = '首先，来的大多是白领。其次，他们要的是能躺下。说到这里，你可能会问影城靠什么赚钱。';
    const r = structureReport(many, 'xiaohongshu');
    expect(r.stats.signposts).toBeGreaterThanOrEqual(3);
    expect(r.findings.some((f) => f.dimension === '路标词' && f.severity === 'bad')).toBe(true);
  });

  it('空文本不炸', () => {
    expect(structureReport('', 'douyin').penalty).toBe(0);
  });
});
