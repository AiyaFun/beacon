import { describe, it, expect } from 'vitest';
import {
  checkFactDrift,
  extractNumbers,
  extractQuotes,
  extractSourceClaims,
  MIN_QUOTE_CHARS,
} from '@/lib/humanize/factcheck';

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
    expect(checkFactDrift('', '').level).toBe('none');
  });
});

// ─────────────────────────── 引语 ───────────────────────────
//
// GEO 论文的三大改写手法（加引语/加统计/标来源）在其源码里本来就允许编造。
// 数字编错用户还能一眼看出，凭空多出一个「谁说的」——那是一整套虚构归因。

describe('新增引语', () => {
  it('模型给一句原文没有的话套上引号，报出来', () => {
    const r = checkFactDrift(
      '这个行业的人普遍不看好这条路。',
      '这个行业的人普遍不看好这条路。一位从业十年的老兵说：「这条路根本走不通，早点转行。」',
    );
    expect(r.addedQuotes.some((q) => q.includes('这条路根本走不通'))).toBe(true);
    expect(r.level).toBe('attribution');
    expect(r.attributionWarning).toContain('虚构');
  });

  it('中英各种引号形式都认', () => {
    const forms = ['「', '『', '“', '‘', '"', "'"];
    const close = ['」', '』', '”', '’', '"', "'"];
    forms.forEach((open, i) => {
      const after = `他后来补了一句${open}这件事我们从来没做过${close[i]}。`;
      const r = checkFactDrift('他后来补了一句话。', after);
      expect(r.addedQuotes.length, `第 ${i} 种引号没被识别`).toBeGreaterThan(0);
    });
  });

  it('原文里本来就有的引语不报（口径是「新增的」不是「存在的」）', () => {
    const before = '客户当时原话是：「你们这个价格我接受不了。」我没接。';
    const after = '客户当时甩下一句「你们这个价格我接受不了」，我没接。';
    const r = checkFactDrift(before, after);
    expect(r.addedQuotes).toEqual([]);
    expect(r.level).not.toBe('attribution');
  });

  it('只是给原文的话加上引号，不算造引语（剥引号再比内容）', () => {
    const r = checkFactDrift('他说效果不错，让我们继续做。', '他说：「效果不错，让我们继续做。」');
    expect(r.addedQuotes).toEqual([]);
    expect(r.level).toBe('none');

    // 原文已经有引号、改写只是把引号范围挪大——这一条才真正用得上「先剥引号再比」：
    // 不剥的话原文里那对「」把内容切成两段，扩过的引语就永远找不到匹配，变成误伤。
    const moved = checkFactDrift('他说「效果不错」，让我们继续做。', '他说：「效果不错，让我们继续做。」');
    expect(moved.addedQuotes).toEqual([]);
    expect(moved.level).toBe('none');
  });

  it('英文撇号不会被当成一对单引号（don’t … it’s）', () => {
    const r = checkFactDrift(
      'We shipped it anyway.',
      "We shipped it anyway. It doesn't matter what they think, it's done.",
    );
    expect(r.addedQuotes).toEqual([]);
  });

  it('短词条不当引语——「」在中文里还兼职强调号', () => {
    expect(extractQuotes('要先做出自己的「护城河」')).toEqual([]);
    expect(MIN_QUOTE_CHARS).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────── 来源断言 ───────────────────────────

describe('新增来源断言', () => {
  it('模型编一个机构 + 数据，报出来', () => {
    const r = checkFactDrift(
      '这个品类这两年确实在涨。',
      '据艾瑞咨询数据显示，该品类增长47%。',
    );
    expect(r.addedSources.some((s) => s.includes('艾瑞咨询'))).toBe(true);
    expect(r.level).toBe('attribution');
  });

  it('「据…报道」「…研究显示」「官方数据」「根据…报告」这几类句式都认', () => {
    const cases = [
      '据新华社报道，政策下个月落地。',
      '斯坦福的研究显示，这种方法有效。',
      '官方数据是这么写的。',
      '根据麦肯锡报告，市场规模翻倍。',
      'According to Gartner, the market doubled.',
      'Research shows the opposite.',
    ];
    for (const after of cases) {
      const r = checkFactDrift('我自己的体感是这样。', after);
      expect(r.addedSources.length, `没认出来源：${after}`).toBeGreaterThan(0);
      expect(r.level).toBe('attribution');
    }
  });

  it('新增 URL 算来源断言', () => {
    const r = checkFactDrift('细节我就不展开了。', '细节见 https://example.com/report/2026 里的原文。');
    expect(r.addedSources).toContain('https://example.com/report/2026');
    expect(r.level).toBe('attribution');
  });

  it('原文里就有的信源换个句式不报（新增的才拦）', () => {
    const before = '艾瑞咨询的那份报告我翻过，写得挺细。';
    const after = '据艾瑞咨询报告显示，这块确实在涨。';
    const r = checkFactDrift(before, after);
    expect(r.addedSources).toEqual([]);
  });

  it('原文一模一样的来源断言不报', () => {
    const before = '据新华社报道，政策下个月落地，我觉得节奏偏快。';
    const after = '据新华社报道，政策下个月落地。这个节奏，偏快。';
    expect(checkFactDrift(before, after).addedSources).toEqual([]);

    // 上面那条其实是被「新华社这个机构名原文里有」放过的，走的不是整句比对。
    // 泛指信源（官方/行业…）不吃机构名那一路，只能靠整句比对——这一条才验的是它。
    const generic = checkFactDrift('官方数据显示，这个政策三月生效。', '官方数据显示，这个政策三月生效——我核过了。');
    expect(generic.addedSources).toEqual([]);
  });

  it('「数据报告」「占据」里的「据」不会被切成来源断言', () => {
    // 「数据报告」正好凑出「据+报告」，是负向后顾唯一拦得住的那种切法
    expect(extractSourceClaims('后台数据报告我天天看')).toEqual([]);
    expect(extractSourceClaims('后台数据我每天都看，这个位置占据了半屏')).toEqual([]);
    expect(checkFactDrift('我每天看后台。', '后台数据报告我天天看。').addedSources).toEqual([]);
  });

  it('泛指词不能当「原文里有这个信源」的凭据', () => {
    // 原文提过「行业」两个字，不等于原文里有「行业报告」这个信源
    const r = checkFactDrift('这个行业我做了八年。', '据行业报告显示，八年老兵只剩两成。');
    expect(r.addedSources.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────── 分级 ───────────────────────────

describe('处置分级', () => {
  it('只有数字漂移时维持原样：level=number，还是那句「请核对」', () => {
    const r = checkFactDrift('收入涨了不少', '收入涨了47%');
    expect(r.level).toBe('number');
    expect(r.added).toEqual(['47%']);
    expect(r.attributionWarning).toBe('');
    expect(r.warning).toContain('核对');
    expect(r.warning).not.toContain('虚构');
  });

  it('引语/来源比数字严重：level 升到 attribution，两类分开装', () => {
    const r = checkFactDrift(
      '这个品类这两年在涨，我自己也有体感。',
      '据艾瑞咨询数据显示，该品类增长47%。一位业内人士说：「明年还会更猛，早入场早吃到。」',
    );
    expect(r.level).toBe('attribution');
    expect(r.added).toContain('47%'); // 数字仍然照旧装在 added 里，向后兼容
    expect(r.addedSources.length).toBeGreaterThan(0);
    expect(r.addedQuotes.length).toBeGreaterThan(0);
    // 合并出来的 warning 两句都要在，且严重的那句排前面——老调用点只认这一个字符串，
    // 少一句就等于这道闸对它们不存在。
    // ⚠️ 只写 indexOf 比较是假绿：缺席时 indexOf 返回 -1，比谁都小，断言照样过。
    expect(r.warning).toContain('虚构');
    expect(r.warning).toContain('核对');
    expect(r.warning.indexOf('虚构')).toBeLessThan(r.warning.indexOf('核对'));
  });

  it('只有引语/来源、没有数字时，warning 就是那句更重的话', () => {
    const r = checkFactDrift('这个品类这两年在涨。', '据艾瑞咨询报告显示，这个品类这两年在涨。');
    expect(r.added).toEqual([]);
    expect(r.attributionWarning).not.toBe('');
    expect(r.warning).toBe(r.attributionWarning);
  });

  it('没漂移时所有字段都是空的', () => {
    const r = checkFactDrift('今天写完了这篇稿子。', '今天，把这篇稿子写完了。');
    expect(r).toEqual({
      added: [],
      warning: '',
      addedQuotes: [],
      addedSources: [],
      addedUrls: [],
      level: 'none',
      attributionWarning: '',
    });
  });
});

// ─────────────────────────────────────────────────────────────
// addedUrls：唯一会拦住「采纳为人工终稿」的一类漂移。
// 分出来的理由是它没有「换了个写法」的解释空间——「据某某报告显示」可能只是把原文已有的
// 信源改了句式，而一条原文里不存在的 URL 指向一个具体地址，模型拼出来的就是编的。
describe('addedUrls：凭空多出来的链接单列', () => {
  const BEFORE = '这个品类这两年在涨，我自己的号也感觉到了。';

  it('新增 URL 进 addedUrls，也仍然在 addedSources 里（子集关系）', () => {
    const r = checkFactDrift(BEFORE, `${BEFORE}详见 https://example.com/report/2026 的数据。`);
    expect(r.addedUrls).toEqual(['https://example.com/report/2026']);
    expect(r.addedSources).toContain('https://example.com/report/2026');
    expect(r.level).toBe('attribution');
  });

  it('句式类来源不进 addedUrls——那一类只提示、不拦', () => {
    const r = checkFactDrift(BEFORE, `据艾瑞咨询报告显示，${BEFORE}`);
    expect(r.addedSources.length).toBeGreaterThan(0);
    expect(r.addedUrls).toEqual([]); // 拦不拦的分界就在这里
  });

  it('原文里本来就有的链接不算新增（口径是「新增的」不是「存在的」）', () => {
    const withUrl = `${BEFORE}来源 https://example.com/report/2026`;
    const r = checkFactDrift(withUrl, `${withUrl}\n补一句结论。`);
    expect(r.addedUrls).toEqual([]);
  });

  it('🔒 域名在原文出现过，也不能放过新拼的路径', () => {
    // 模型最常见的编法就是拿一个真域名拼一个假路径。phrase 类有「机构名原文里有过就算换句式」
    // 的豁免，URL 绝不能吃这条豁免——差一个字符就是另一个地址。
    const withUrl = `${BEFORE}我在 https://example.com/about 写过。`;
    const r = checkFactDrift(withUrl, `${withUrl}另见 https://example.com/report/2026-q3。`);
    expect(r.addedUrls).toEqual(['https://example.com/report/2026-q3']);
  });

  it('🔒 URL 的 entity 必须为空——它是「不吃豁免」的唯一依靠', () => {
    // 上面那条测不到真正的机制：URL 的 entity 是空串，豁免分支（e.length>=2）本来就不成立，
    // 所以即使把挡它的代码删掉，行为也不变（mutation 实测确认过是死代码）。
    // 真正要钉死的是**这个前提**：谁将来给 URL 抠个域名当 entity，豁免就会立刻生效，
    // 「域名在原文出现过」会把新拼的假路径整条放过去。这条测试就是拦那一天的。
    const claims = extractSourceClaims('见 https://example.com/report/2026 和 据艾瑞咨询报告显示');
    expect(claims).toContain('https://example.com/report/2026');
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync('lib/humanize/factcheck.ts', 'utf8');
    // scanSourceClaims 里 URL 那一支必须写死 entity: ''
    expect(src).toMatch(/kind:\s*'url'[^}]*\}|entity:\s*''[^}]*kind:\s*'url'/);
    expect(src).toMatch(/seen\.set\(m\[0\],\s*\{\s*text:\s*m\[0\],\s*entity:\s*'',\s*kind:\s*'url'\s*\}\)/);
  });

  it('www. 开头的裸链接同样算', () => {
    const r = checkFactDrift(BEFORE, `${BEFORE}见 www.example.com/data。`);
    expect(r.addedUrls).toHaveLength(1);
  });

  it('只有数字漂移时 addedUrls 为空，采纳不该被拦', () => {
    const r = checkFactDrift(BEFORE, `${BEFORE}涨了 47%。`);
    expect(r.level).toBe('number');
    expect(r.addedUrls).toEqual([]);
  });
});

describe('🔒 采纳闸的接线（源码级）', () => {
  it('「采纳为人工终稿」必须被 urlBlocked 拦，且勾选后放行', async () => {
    // 光在 factcheck 里算出 addedUrls 没有用，得真的接到那个按钮上。
    // 这条守卫防的是「算了但没接」——本项目这一批里已经出现过三次同款（死代码/零调用点）。
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/(app)/studio/Rewriter.tsx', 'utf8');
    const btn = src.match(/onClick=\{saveAsHuman\}[\s\S]{0,160}?disabled=\{([^}]*)\}/);
    expect(btn, '没找到「采纳为人工终稿」按钮').toBeTruthy();
    expect(btn![1]).toContain('urlBlocked');
    // 闸的判据：有链接且没勾确认
    expect(src).toMatch(/urlBlocked\s*=\s*urlDrift\.length\s*>\s*0\s*&&\s*!urlsChecked/);
    // 每出一次新结果要清零，否则上一次的确认会顺延到下一批链接上。
    // ⚠️ 必须**剥掉注释再找**：直接 /setUrlsChecked\(false\)/ 是假绿——把那行注释掉，
    //    正则照样在注释文本里匹配到，守卫全绿而行为已经坏了（本条 mutation 实测过）。
    const live = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(live).toMatch(/setUrlsChecked\(false\)/);
  });
});
