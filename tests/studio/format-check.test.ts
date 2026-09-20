import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkPlatformFit, formatProblemBlock, fitSummary, REPAIR_EXEMPT_CODES } from '@/lib/studio/format-check';
import { platformFormatBlock, platformHardSpec, PLATFORM_SKELETON, tidyDraft } from '@/lib/studio/platform-format';
import { PLATFORM_LIST } from '@/lib/constants';

// 平台格式体检（2026-09-17，用户：「就地起稿得内容，还是不符合各个平台的意思」）。
//
// 1.3.76 已经把格式写进提示词了，但**落库前没有任何一处检查模型照没照做**。
// 这一组测试钉的是：每一条格式要求都能被验出来，而且验出来的东西是可执行的。

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const codes = (text: string, platform: string) => checkPlatformFit(text, platform).violations.map((v) => v.code);

describe('平台格式体检', () => {
  it('小红书：缺标题行、缺话题标签都验得出来', () => {
    const body = '中午十二点，写字楼下的电影院开始卖床位。一张票一块二，能睡两个半小时。这个价格在任何一个城市都算不上钱，却解决了一个很多人不好意思说出口的问题：中午没地方躺。传统影院靠晚上的票房活着，白天的座位是空的。午休影院把这段空着的时间重新卖了一次，卖的不是电影，是一个能平躺的地方。对上班族来说，趴在工位上睡四十分钟，起来脖子是僵的。躺着睡两个小时，下午的状态完全不一样。';
    const c = codes(body, 'xiaohongshu');
    expect(c).toContain('title_missing');
    expect(c).toContain('hashtag_missing');
  });

  it('小红书：标题 + 正文 + 3-6 个标签 = 一条都不报', () => {
    const ok = [
      '一块二睡两个半小时的午休影院',
      '',
      '中午十二点，写字楼下的电影院开始卖床位。',
      '',
      '一张票一块二，能睡两个半小时。解决的是一个很多人不好意思说出口的问题：中午没地方躺。',
      '',
      '传统影院靠晚上的票房活着，白天的座位空着。这段时间被重新卖了一次，卖的不是电影，是一个能平躺的地方。',
      '',
      '对上班族来说，趴在工位上睡四十分钟，起来脖子是僵的。躺着睡两个小时，下午完全不一样。这笔账每个人都会算，所以中午那两个小时才有人愿意花钱。',
      '',
      '有意思的地方在于，它没有创造任何新东西。影院还是那个影院，时间还是那段时间，只是换了一种卖法。闲置的东西被重新定价，生意就成立了。',
      '',
      '我问了老板，说中午这两个小时的翻台率比晚上还稳。这大概是最不费劲的一门生意：客人来了就睡，睡完就走。',
      '',
      '你们公司附近有这样的地方吗？',
      '',
      '#午休影院 #打工人 #城市生活',
    ].join('\n');
    expect(checkPlatformFit(ok, 'xiaohongshu').violations).toEqual([]);
    expect(fitSummary(checkPlatformFit(ok, 'xiaohongshu'))).toMatch(/符合小红书/);
  });

  it('🔒 标题里带感叹号不算「不是标题」——小红书标题本来就那么写', () => {
    // 这一条修的是第一版判据的误伤：拿「句中有没有感叹号」判，
    // 「1.2 元睡 2.5 小时！午休影城太会玩了」会被判成「第一行不是标题」，
    // 然后修复那一轮就去改一个本来就对的标题。
    const t = ['1.2元睡2.5小时！午休影城太会玩了', '', '中午十二点，写字楼下的电影院开始卖床位。', '', '#午休 #打工人 #城市'].join('\n');
    expect(codes(t, 'xiaohongshu')).not.toContain('title_missing');
  });

  it('抖音：不该有标题行、不该有 emoji、超长段落要报', () => {
    const t = ['【午休影院】', '', '👀 中午十二点，写字楼下的电影院开始卖床位，一张票一块二，能睡两个半小时，这个价格在任何一个城市都算不上钱，却解决了一个很多人不好意思说出口的问题，就是中午实在没有地方可以躺下来休息。'].join('\n');
    const c = codes(t, 'douyin');
    expect(c).toContain('title_unexpected');
    expect(c).toContain('emoji_banned');
    expect(c).toContain('para_long');
  });

  it('markdown 与栏目名在哪个平台都是硬伤', () => {
    const t = ['正文第一句。', '', '## 小标题', '', '**加粗**的一句。', '', '📌【目标客群】', '', '白领上班族。'].join('\n');
    const c = codes(t, 'wechat');
    expect(c).toContain('markdown_left');
    expect(c).toContain('section_label');
  });

  it('TikTok 要英文：满篇中文报 language_mismatch', () => {
    expect(codes('中午十二点，写字楼下的电影院开始卖床位。一张票一块二。', 'tiktok')).toContain('language_mismatch');
  });

  it('X：单条超 280 字符要拆 thread', () => {
    expect(codes('午'.repeat(300), 'x')).toContain('thread_split');
  });

  it('🔒 「正文偏短」只报给人看，不进修复清单——补字数只能靠编内容', () => {
    const short = '中午十二点，写字楼下的电影院开始卖床位。一张票一块二。';
    const r = checkPlatformFit(short, 'douyin');
    expect(r.violations.map((v) => v.code)).toContain('chars_short');
    expect(r.repairable.map((v) => v.code)).not.toContain('chars_short');
    expect(formatProblemBlock(r)).not.toMatch(/偏短/);
    expect(REPAIR_EXEMPT_CODES.has('chars_short')).toBe(true);
  });

  it('每条违规都给得出「怎么改」，而不是只说「不合规」', () => {
    const r = checkPlatformFit('### 标题\n\n正文。', 'xiaohongshu');
    expect(r.violations.length).toBeGreaterThan(0);
    for (const v of r.violations) {
      expect(v.fix.length).toBeGreaterThan(4);
      expect(v.code).toMatch(/^[a-z_]+$/);
    }
  });

  it('空正文不炸', () => {
    expect(checkPlatformFit('', 'douyin').badCount).toBe(1);
  });
});

describe('平台骨架与硬指标', () => {
  it('每个平台都有走向骨架，且写明「不是模板」', () => {
    for (const p of PLATFORM_LIST) {
      const steps = PLATFORM_SKELETON[p.key];
      expect(steps, p.key).toBeTruthy();
      expect(steps.length, p.key).toBeGreaterThanOrEqual(4);
    }
    expect(platformFormatBlock('xiaohongshu')).toMatch(/这是走向不是模板/);
  });

  it('十四个平台的骨架不能是同一套（不然又是「一篇稿子换字数」）', () => {
    const firsts = new Set(PLATFORM_LIST.map((p) => PLATFORM_SKELETON[p.key][0]));
    // 头条/百家号是同一类分发型图文，允许共用；其余各不相同
    expect(firsts.size).toBeGreaterThanOrEqual(PLATFORM_LIST.length - 1);
  });

  it('🔒 骨架与「怎么改」里不许出现成品句子——模型会原样抄进正文', () => {
    // 真机第一稿：骨架里写了「中间留一处反转（「看着是赚钱，其实是在卖时间」）」，
    // 模型把那句话一字不差写进了一篇跟它毫无关系的稿子里。
    // 判据：给模型看的那几块里，不许出现「引号包起来的整句话」（8 字以上、带句读的）。
    const blocks = PLATFORM_LIST.map((p) => platformFormatBlock(p.key)).join('\n');
    const quoted = blocks.match(/「[^」]{8,}」/g) ?? [];
    const sentences = quoted.filter((q) => /[，。！？]/.test(q));
    expect(sentences, `骨架里出现了成品句子：${sentences.join(' / ')}`).toEqual([]);
  });

  it('硬指标一行说清字数/标题/emoji/标签', () => {
    expect(platformHardSpec('xiaohongshu')).toMatch(/正文 300-800 字/);
    expect(platformHardSpec('xiaohongshu')).toMatch(/第一行标题/);
    expect(platformHardSpec('douyin')).toMatch(/不要标题行/);
    expect(platformHardSpec('tiktok')).toMatch(/用英文写/);
  });

  it('🔒 硬指标钉在 user 消息里（system 块会被长上下文稀释）', () => {
    expect(strip(read('lib/studio/draft-core.ts'))).toMatch(/本篇硬指标：\$\{platformHardSpec/);
    const actions = strip(read('app/(app)/studio/actions.ts'));
    expect((actions.match(/platformHardSpec\(platform\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('🔒 成稿收口把格式也验了', () => {
  it('🔒 只是格式不合（读起来一点不像 AI）也要判「要改」', async () => {
    // 行为守卫：光断言源码里出现过 checkPlatformFit 是不够的——
    // 判定里把格式那一条删掉，源码断言照样绿，而产品行为已经退回改之前。
    const { judgeDraft } = await import('@/lib/studio/humanize-pass');
    const noTags = [
      '一块二睡两个半小时的午休影院',
      '',
      '中午十二点，写字楼下的电影院开始卖床位。',
      '',
      '一张票一块二，能睡两个半小时。解决的是一个很多人不好意思说出口的问题：中午没地方躺。',
      '',
      '传统影院靠晚上的票房活着，白天的座位空着。这段时间被重新卖了一次，卖的不是电影，是一个能平躺的地方。',
      '',
      '对上班族来说，趴在工位上睡四十分钟，起来脖子是僵的。躺着睡两个小时，下午完全不一样。这笔账每个人都会算。',
      '',
      '我问了老板，说中午这两个小时的翻台率比晚上还稳。这大概是最不费劲的一门生意：客人来了就睡，睡完就走。',
      '',
      '你们公司附近有这样的地方吗？',
    ].join('\n'); // ← 少了结尾那行 #话题#
    const v = judgeDraft(noTags, 'xiaohongshu');
    expect(v.report.hits).toHaveLength(0); // 不是 AI 味的问题
    expect(v.needed).toBe(true); // 但它确实不合小红书
    expect(v.reasons.join(' ')).toMatch(/小红书/);
  });

  it('humanize-pass 的判定里有 checkPlatformFit，修复提示词里有格式清单', () => {
    const src = strip(read('lib/studio/humanize-pass.ts'));
    expect(src).toMatch(/checkPlatformFit\(/);
    expect(src).toMatch(/formatProblemBlock/);
  });

  it('工坊实时诊断把格式体检一起返回（零 LLM，搭同一次防抖的车）', () => {
    expect(strip(read('app/(app)/studio/actions.ts'))).toMatch(/const fit = checkPlatformFit\(body, platform\)/);
    expect(strip(read('app/(app)/studio/Rewriter.tsx'))).toMatch(/coach\.fit\.violations/);
  });

  it('清洗后的稿子不该再有 markdown 与栏目行', () => {
    const raw = ['### 【标题在这】', '', '正文。', '', '📌【栏目名】', '', '内容。'].join('\n');
    expect(codes(tidyDraft(raw, 'xiaohongshu'), 'xiaohongshu')).not.toContain('section_label');
    expect(codes(tidyDraft(raw, 'xiaohongshu'), 'xiaohongshu')).not.toContain('markdown_left');
  });
});
