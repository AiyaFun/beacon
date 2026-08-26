import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { availabilityOf, absenceNote, displayKeys } from '@/lib/insight/platform-metrics';
import type { MetricCountKey } from '@/lib/json';

// 各平台给的字段本来就不一样。这张表要回答的是：一个空格子到底是
// 「平台没有」「详情页才有」「还没验过」还是「这次没采到」——四件事，四种说法。

const ALL: readonly MetricCountKey[] = ['views', 'likes', 'comments', 'collects', 'shares'];

describe('🔒 平台能力矩阵：缺省是「不知道」，绝不是「没有」', () => {
  it('没列到的平台一律 unknown（视频号/TikTok 都没做过真机校准）', () => {
    expect(availabilityOf('shipinhao', 'views')).toBe('unknown');
    expect(availabilityOf('tiktok', 'likes')).toBe('unknown');
  });

  it('🔒 表里没有的平台名同样是 unknown，不许当成 no', () => {
    expect(availabilityOf('不存在的平台', 'views')).toBe('unknown');
  });

  it('真机确认过的「没有」才写 no：抖音/小红书/X 的播放量', () => {
    for (const p of ['douyin', 'xiaohongshu', 'x']) {
      expect(availabilityOf(p, 'views'), `${p} 的播放量`).toBe('no');
    }
  });

  it('B站 与 YouTube 的播放量是真有的', () => {
    expect(availabilityOf('bilibili', 'views')).toBe('yes');
    expect(availabilityOf('youtube', 'views')).toBe('yes');
  });

  it('抖音的评论/收藏/转发标成 detail —— 主页采不到，详情页才有', () => {
    for (const k of ['comments', 'collects', 'shares'] as const) {
      expect(availabilityOf('douyin', k), `抖音 ${k}`).toBe('detail');
    }
  });
});

describe('🔒 四种缺席给四种说法', () => {
  it('平台没有 → 说清是平台不提供', () => {
    expect(absenceNote('douyin', 'views')).toContain('不提供');
  });

  it('详情页才有 → 告诉用户去哪补', () => {
    expect(absenceNote('douyin', 'comments')).toContain('详情页');
  });

  it('没验过 → 明说不知道，不冒充「平台没有」', () => {
    const note = absenceNote('tiktok', 'likes');
    expect(note).toMatch(/没.*确认|不知道/);
    expect(note).not.toContain('该平台公开页面不提供');
  });

  it('🔒 平台有、但这次没采到 → 要说「重采」，不能说「平台没有」', () => {
    const note = absenceNote('bilibili', 'views');
    expect(note).toContain('重采');
    expect(note).not.toContain('不提供');
  });
});

describe('展示哪些列', () => {
  it("'no' 的项不占位——抖音永远不会有播放量，留一列破折号没意义", () => {
    expect(displayKeys('douyin', ALL)).not.toContain('views');
  });

  it('detail / unknown 都要留位：它们可能补得上，空着才提示得了用户', () => {
    const keys = displayKeys('douyin', ALL);
    expect(keys).toContain('comments');
    expect(keys).toContain('collects');
    expect(keys).toContain('shares');
  });

  it('没校准过的平台，赞评藏转播整行留位（一项都不敢说没有）', () => {
    expect(displayKeys('tiktok', ALL)).toEqual([...ALL]);
  });

  it('🔒 投币/弹幕是 B站 独有概念 → 别的平台是 no，不是 unknown', () => {
    // 区别在于：unknown 是「可能有，没去确认」；这两项是平台形态上就不存在这种东西。
    // 标成 unknown 的代价：每一行抖音/TikTok 作品都白白多两个破折号（真机上撞到过）。
    for (const p of ['douyin', 'tiktok', 'x', 'youtube', 'xiaohongshu']) {
      expect(availabilityOf(p, 'coins'), `${p} 投币`).toBe('no');
      expect(availabilityOf(p, 'danmaku'), `${p} 弹幕`).toBe('no');
    }
    expect(availabilityOf('bilibili', 'coins')).toBe('yes');
    expect(availabilityOf('bilibili', 'danmaku')).toBe('yes');
  });
});

describe('🔒 榜上按平台区分，空格子给得出原因', () => {
  const TOP = readFileSync(resolve(process.cwd(), 'app/(app)/competitors/CompetitorTopPosts.tsx'), 'utf8');

  it('卡片行按 displayKeys 决定摆哪些指标（不是所有平台一套写死的列）', () => {
    expect(TOP).toContain('displayKeys(p.platform');
  });

  it('🔒 空格子必须带 absenceNote 说明为什么没有', () => {
    expect(TOP).toContain('absenceNote(p.platform');
  });

  it('表格里的评论/收藏/转发也走同一套（不能只改卡片视图）', () => {
    expect(TOP).toMatch(/\['comments', 'collects', 'shares'\] as const/);
  });
});

describe('🔒 YouTube 评论数要尽力采（平台有的就别空着）', () => {
  const YT = readFileSync(resolve(process.cwd(), 'extension/content/youtube.js'), 'utf8');

  it('确实尝试读评论数节点', () => {
    expect(YT).toContain('ytd-comments-header-renderer #count');
  });

  it('🔒 读不到时不许写 0 冒充「零评论」', () => {
    // 判据：只有在拿到有效数字时才写入 metrics.comments
    expect(YT).toMatch(/if \(c != null && c >= 0\) metrics\.comments = c;/);
  });
});

describe('🔒 补齐详情：上限、串行、以及不许被下次采集抹掉', () => {
  const SW = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');
  const INGEST = readFileSync(resolve(process.cwd(), 'lib/ingest/competitor.ts'), 'utf8');
  const PRIVACY = readFileSync(resolve(process.cwd(), 'app/(public)/legal/privacy/page.tsx'), 'utf8');

  it('每次最多 20 条', () => {
    expect(SW).toMatch(/maxPostsPerRun:\s*20/);
  });

  it('🔒 超出上限的条数必须报出来，不许悄悄截断', () => {
    // 【别只验这个词在文件里出现过】原来这条是 `toContain('skipped')`，而 sw.js 里
    // `skipped` 出现十几次，**绝大多数属于另一件事**（后端回填响应里的「认出作品但没读到指标」）。
    // 把这里截断的那几行整个删掉，那些用法照样让它绿。要断就断在这一段的形状上。
    expect(SW, '没算出被截掉多少条').toMatch(/skipped\s*=\s*all\.length\s*-\s*targets\.length/);
    expect(SW, '算了却没报给用户——那就是悄悄截断').toMatch(/type: 'detail-done'[^}]*skipped/);
  });

  it('页间有等待，且逐条串行（不并发打 20 个页面）', () => {
    expect(SW).toMatch(/betweenPostsMs:\s*\d+/);
    expect(SW).toContain('DETAIL_RULES.betweenPostsMs');
  });

  it('🔒 详情页认不出同一条作品就跳过——不许把 A 的数字写到 B 上', () => {
    expect(SW).toMatch(/platformItemId\) === String\(post\.platformItemId\)/);
  });

  it('🔒 入库必须合并而不是覆盖，否则下次主页采集会把详情数据抹掉', () => {
    expect(INGEST).toContain('{ ...prev, ...metrics }');
  });

  it('🔒 快照记「这次观测到什么」，不能把合并结果写进去', () => {
    // 把上次的值抄进这次快照 = 声称我们看了其实没看的东西，增长会把「没去看」算成「没涨」
    // 判据是「快照写的是 metrics，不是 merged」——加了 source 字段之后正则要跟着放宽，
    // 但守的语义一点没变：这次观测到什么就记什么。
    expect(INGEST).toMatch(/postMetricSnapshot\.create\(\{[\s\S]{0,120}metrics: toJson\(metrics\)/);
    expect(INGEST).not.toMatch(/postMetricSnapshot\.create\(\{[\s\S]{0,120}metrics: toJson\(merged\)/);
  });

  it('🔒 隐私政策里要如实披露这条通道', () => {
    expect(PRIVACY).toContain('补齐前 20 条作品详情');
    expect(PRIVACY).toContain('逐条串行');
  });
});

describe('🔒 矩阵必须与解析器的真机结论对得上', () => {
  const DOUYIN_HOME = readFileSync(resolve(process.cwd(), 'extension/content/douyin.js'), 'utf8');
  const XHS_NOTE = readFileSync(resolve(process.cwd(), 'extension/content/xhs-note.js'), 'utf8');
  const X_JS = readFileSync(resolve(process.cwd(), 'extension/content/x.js'), 'utf8');

  it('抖音主页解析器确实只采点赞（矩阵把评论等标成 detail 才站得住）', () => {
    expect(DOUYIN_HOME).toContain("CARD_COUNT_KEY = 'likes'");
  });

  it('小红书详情页确实采了点赞/收藏/评论', () => {
    for (const k of ['likes', 'collects', 'comments']) {
      expect(XHS_NOTE, `小红书没采 ${k}`).toContain(`set('${k}'`);
    }
  });

  it('X 确实采了书签（矩阵里 collects=yes）', () => {
    // 【裸词满足不了这条】原来是 `toContain('bookmark')`，而 x.js 里除了真正读数的选择器，
    // 还有一份给主页解析器用的词表 `collects: ['bookmark', …]`——
    // 把真正读数的那一行删掉，词表照样让它绿，而矩阵里 collects 仍然印着 yes。
    expect(X_JS, '没有真正去读书签按钮上的数').toContain('data-testid="bookmark"');
  });

  // ── 'yes' 与 'detail' 的分界必须由主页解析器说了算 ──
  //
  // 上面三条只验了「详情页确实采了这几项」——那对 'yes' 和 'detail' **同样成立**，
  // 所以它们分不出这两档。2026-08-13 就是这么漏过去的：小红书的评论/收藏、YouTube 的点赞
  // 都只有详情页才有，却在矩阵里标成 'yes'（小红书那行的注释自己都写着「详情页 engage-bar 给…」）。
  //
  // 标错的后果不是数字错，是**说明错**：两档的悬停文案都会指向详情页，所以不严重，
  // 但 'yes' 那句是「这项该平台有，但**这次没采到**」——它把「这一页本来就没有」
  // 说成了「本该采到却没采到」。对着主页采完的用户，那是一句假话。
  //
  // 判据：矩阵标 'yes' 的指标，**主页/列表解析器必须真的产出它**。
  // 只覆盖主页与详情页分属两个文件的三家；YouTube/X 的两种页面写在同一个文件里，
  // 靠读文件分不出来，如实留在覆盖之外（不假装验过）。
  const HOME_PARSERS: Record<string, { file: string; produces: string[] }> = {
    // douyin.js:CARD_COUNT_KEY = 'likes' —— 主页角标是 ♡ 点赞，一张卡就这一个数
    douyin: { file: 'douyin.js', produces: ['likes'] },
    // xhs.js:63 只 parseCount 一个 .count 当 likes
    xiaohongshu: { file: 'xhs.js', produces: ['likes'] },
    // bilibili 列表卡片给播放与弹幕
    bilibili: { file: 'bilibili.js', produces: ['views', 'danmaku', 'likes', 'collects', 'shares', 'coins'] },
  };

  for (const [platform, home] of Object.entries(HOME_PARSERS)) {
    it(`🔒 ${platform}：矩阵标 yes 的指标，主页解析器(${home.file}) 必须真的采得到`, () => {
      // 走公开 API（availabilityOf），不去读没导出的 MATRIX——测的是消费方真正看到的东西
      const ALL_KEYS: MetricCountKey[] = ['views', 'likes', 'comments', 'collects', 'shares', 'danmaku', 'coins'];
      const claimed = ALL_KEYS.filter((k) => availabilityOf(platform, k) === 'yes');
      expect(claimed.length, `${platform} 一项 yes 都没有，这条用例就白跑了`).toBeGreaterThan(0);
      for (const metric of claimed) {
        expect(
          home.produces,
          `矩阵说 ${platform}.${metric} 是 'yes'（主页就有），但主页解析器 ${home.file} 并不产出它——`
            + `只有详情页有的话，这一档应该是 'detail'`,
        ).toContain(metric);
      }
    });
  }
});

// ── 消费方必须真的用上这套判据 ────────────────────────────────────────────
//
// 【被守的是什么】矩阵写得再对，只要有一处 UI 绕过它直接 `fmtNum(p.views)`，
// 抖音那条作品上就会印出「播放/阅读: 0」——把「这个平台公开页没有这项」说成「这条数据是 0」。
// 2026-08-11 修的是竞对卡片的**折叠行**与 chip；同一个文件的**展开面板**里还留着
// 七行写死的 fmtNum，一直在印 0（展开才看得到，所以谁都没注意）。
//
// 这条守的是接线，不是矩阵：矩阵有自己的用例，接不上就等于没有。
describe('🔒 竞对卡片的每一处指标渲染都过 displayKeys / absenceNote', () => {
  const FILE = 'app/(app)/competitors/CompetitorTopPosts.tsx';
  const raw = readFileSync(resolve(process.cwd(), FILE), 'utf8');
  // 注释里会引用错误写法讲坑（上面这段就是），扫源码前先剥掉，否则守卫会被自己的说明骗
  const src = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('没有任何一处**不带缺席判断**地把指标字段喂给 fmtNum', () => {
    // p.likes 不在此列：矩阵里没有任何平台把 likes 标成 'no'，它是行内的兜底展示项。
    // 其余五项都存在「平台公开页压根没有」的情形，直接印数字就是断言一个假事实。
    //
    // 逐行判：同一行里出现 `> 0 ?` 或 NA_TEXT/absenceNote 的，说明它自己带了缺席分支
    //（折叠行的播放量就是这么写的），放行；一行里只有 fmtNum(p.x) 的才是裸用。
    const naked = src
      .split('\n')
      .filter((line) => /fmtNum\(\s*p\.(views|comments|collects|danmaku|coins)\s*\)/.test(line))
      .filter((line) => !/>\s*0\s*\?/.test(line) && !/NA_TEXT|absenceNote/.test(line))
      .map((line) => line.trim());
    expect(naked).toEqual([]);
  });

  it('展开面板与折叠行用的是同一份 key 表和同一个缺席说明', () => {
    // displayKeys 至少被用两次（折叠行的 chip + 展开面板的基础数据对比）
    expect([...src.matchAll(/displayKeys\(/g)].length).toBeGreaterThanOrEqual(2);
    expect([...src.matchAll(/absenceNote\(/g)].length).toBeGreaterThanOrEqual(2);
    // 且没有第二份图标/标题清单——展开面板此前是自己写的一套 emoji
    expect([...src.matchAll(/METRIC_CHIPS\s*=/g)].length).toBe(1);
  });
});
