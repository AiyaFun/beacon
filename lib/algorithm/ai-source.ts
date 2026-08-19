import type { PlatformKey } from '@/lib/constants';

// 「这个平台上的内容，会不会被某个 AI 引擎抠走当答案」——逐平台列明。
//
// 【为什么有这张表】搜索的命题已经从「能不能被搜索引擎收录」变成「能不能进 AI 的引用池」，
// 而国内引擎是**平台依附**：厂商先吃自己生态里的内容（元宝吃公众号，豆包吃头条/抖音）。
// 这对创作者是一条能执行的决策——「同一篇稿子多派生一个公众号版本」是他在 beacon 里点一下就能做的事。
//
// 【为什么是纯常量、不建表】这类校准知识在本库的先例就是常量：lib/insight/platform-metrics.ts 的
// MATRIX、lib/studio/draft-core.ts 的 PLATFORM_STYLE。建表要付「两份 schema + RLS 数组 +
// 生产手动建表」的代价，换来的能力是零——没有任何人要在运行时改它，改它的人是下一次校准的我们。
//
// 【为什么只有 8 行】只列 beacon 自己支持的平台。知乎/百家号/今日头条这些在 GEO 口径里权重更高，
// 但 beacon 建不了号（AccountManager 下拉被 PLATFORM_LIST 钉死）、派生不了（PLATFORM_STYLE 只有 8 key）、
// 采不到、/data 也看不见。写一条用户既执行不了又度量不了的建议，只会变成客服负担。

/** 这张表的口径版本。改了任何一行都要连它一起改，出问题时能一眼看出用户看到的是哪一版。 */
export const AI_SOURCE_VERSION = '2026-08-12';
// 下次校准日期：2027-02-12。引擎生态半年就会翻一次（元宝 2025-09 才接入公众号），
// 过期不改的后果不是「旧」，是拿一份已经不成立的实证在页面上冒充现状。

// 分档沿用 lib/insight/platform-metrics.ts 的口径，但**故意只留两档**。
//
// platform-metrics 敢写 'no'，是因为它每一格 'no' 背后都有真机复核（抖音公开页确实没有播放量）
// 或平台形态上的确定性（投币是 B站 独有概念，别的平台不存在这种东西）。
// 这里一格 'no' 都给不出来：证据只有一份「哪些平台**被统计到**进了引用池」的第三方报告，
// 从来没有任何一条证据形如「某平台**不**进任何引擎的引用池」。
// 把「权重表里没这一行」印成 'no'，就是把缺席当成 0 —— 本库在 hotScore 上刚栽过这个跟头
// （无播放量平台被写死成 0，一路污染进榜、排序、选题候选和 AI 上下文）。
// ⚠️ 后来者想「顺手补全」时请先读完上面这段：tests/algorithm/ai-source.test.ts 会拦下来。
export type AiSourceCoverage = 'yes' | 'unknown';

export type AiSourceRow = {
  coverage: AiSourceCoverage;
  /** 确认吃这个平台的引擎名。unknown 时必须是 null——没有结论就不许有引擎名。 */
  engine: string | null;
  /**
   * 这条结论的可信度，直接喂给 UI 的 ConfidenceBadge。
   * 类型上就封死在 'consensus'：证据是第三方统计报告，不是平台官方披露、也不是开源代码，
   * 到不了 official/opensource。也正因为最高只到行业共识，它不进发布前 Checklist、不进诊断提示词。
   */
  confidence: 'consensus' | null;
  /** 为什么是这一档。UI 直接拿去当正文/悬停说明，所以要写成人话，且**不许出现任何百分比或评分**。 */
  note: string;
  /** 前置条件：满足不了这条，上面那个 yes 就兑现不了（抖音的字幕就是这种）。没有则 null。 */
  caveat: string | null;
  /** 证据出处。查库查不出来的东西必须标清楚是从哪抄来的，否则半年后没人敢改。 */
  source: string;
  /** 证据的口径年份，不是我们写代码的日期——用户要判断的是「这个结论有多旧」。 */
  asOf: string;
};

// 六个 unknown 共用的那半句：单独抽出来，是因为它才是这张表最容易被误读的地方。
export const AI_SOURCE_UNKNOWN_NOTE =
  '这一格在国产引擎信源实证里没有条目。没有条目只说明没人统计过，不等于这个平台的内容进不了引用池——两件事差得很远。';

const NEWRANK = '新榜《超 1600 万条 AI 引用数据》实证（豆包/元宝/DeepSeek/Kimi 四大引擎）';

// Record<PlatformKey, …> 是故意的：以后 PLATFORMS 里加一个平台，这里漏配就是 tsc 报错，
// 而不是悄悄走进「表里没有 → 缺省 unknown」，让用户以为我们查过了。
export const AI_SOURCE: Record<PlatformKey, AiSourceRow> = {
  // ── 有实证的三格 ──
  wechat: {
    coverage: 'yes',
    engine: '腾讯元宝',
    confidence: 'consensus',
    note: '元宝 2025 年 9 月全面接入公众号，是目前唯一能联网搜公众号的 AI，也就是说公众号内容出了元宝生态基本搜不到。反过来讲，想被元宝引用，公众号是唯一的入口。',
    caveat: null,
    source: NEWRANK,
    asOf: '2025',
  },
  shipinhao: {
    coverage: 'yes',
    engine: '腾讯元宝',
    // 诚实一点：权重表那一行统计到的是公众号，视频号是「同一批接入的腾讯自有内容池」这个生态判断，
    // 不是逐平台的引用量实证。所以 note 里写明证据比公众号那格弱，别让用户以为两格一样硬。
    confidence: 'consensus',
    note: '视频号与公众号在 2025 年 9 月同批接入元宝，同属腾讯自有内容池。注意这一格的证据比公众号弱：实证统计到的是公众号的引用量，视频号是按同批接入推的，还没有单独的引用数据。',
    caveat: null,
    source: 'GEO 知识库 03·发布曝光库：元宝 2025-09 全面接入公众号与视频号（腾讯自有内容池，非逐平台实证）',
    asOf: '2025',
  },
  douyin: {
    coverage: 'yes',
    engine: '豆包',
    confidence: 'consensus',
    note: '抖音是字节自有内容池，豆包的 TOP5 信源里有它。但机器抠走的是**文本**：视频靠字幕和文案转录进引用池。',
    // 这条 caveat 在 beacon 里是能执行也能验证的：插件已经在抓 YouTube/B站 的字幕轨（见
    // beacon-video-analysis 的记录），所以「有没有字幕」不是一句空话。
    caveat: '需要字幕/文案文本——纯口播不写字幕，等于对 AI 不可见',
    source: NEWRANK,
    asOf: '2025',
  },

  // ── 没有条目的五格：一律 unknown，一格都不许写成「不覆盖」 ──
  xiaohongshu: {
    coverage: 'unknown',
    engine: null,
    confidence: null,
    note: 'GEO 知识库对小红书只有定性说法——消费决策类内容跨 AI 被引「中高」，靠 UGC 真实体验的可信度。定性够不上说「哪个引擎收它」，更够不上说「没人收它」。',
    caveat: null,
    source: `${NEWRANK}：无该平台条目；定性说法见 GEO 知识库 03·发布曝光库「渠道价值速查表」`,
    asOf: '2025',
  },
  bilibili: {
    coverage: 'unknown',
    engine: null,
    confidence: null,
    note: 'GEO 知识库对 B站 的说法同样是定性——跨 AI（知识类）「中」，靠视频转录文本进引用池。字幕完整度大概率是关键变量，但这是推论，没有逐引擎的引用数据。',
    caveat: null,
    source: `${NEWRANK}：无该平台条目；定性说法见 GEO 知识库 03·发布曝光库「渠道价值速查表」`,
    asOf: '2025',
  },
  // 海外三家：那份实证只抽了国产引擎的信源，样本里压根没有它们。
  // 「不在样本里」和「不被引用」是两件事——ChatGPT/Gemini 怎么取 YouTube 我们一次都没测过。
  youtube: {
    coverage: 'unknown',
    engine: null,
    confidence: null,
    note: '手上这份实证只统计国产引擎（豆包/元宝/DeepSeek/Kimi），海外平台不在它的抽样范围里。海外引擎怎么取 YouTube，我们没有测过，不编。',
    caveat: null,
    source: `${NEWRANK}：统计范围不含海外平台`,
    asOf: '2025',
  },
  x: {
    coverage: 'unknown',
    engine: null,
    confidence: null,
    note: '手上这份实证只统计国产引擎（豆包/元宝/DeepSeek/Kimi），海外平台不在它的抽样范围里。海外引擎怎么取 X，我们没有测过，不编。',
    caveat: null,
    source: `${NEWRANK}：统计范围不含海外平台`,
    asOf: '2025',
  },
  tiktok: {
    coverage: 'unknown',
    engine: null,
    confidence: null,
    note: '手上这份实证只统计国产引擎（豆包/元宝/DeepSeek/Kimi），海外平台不在它的抽样范围里。TikTok 与抖音是两个平台，抖音那一格的实证不能顺移过来。',
    caveat: null,
    source: `${NEWRANK}：统计范围不含海外平台`,
    asOf: '2025',
  },
};

/**
 * 取某个平台的信源口径。认不出来的键（比如草稿里的伪平台 'multi'）返回 null，
 * 让调用方**整块不渲染**——比返回一行 unknown 强：那会让页面看起来像「我们查过了，不知道」。
 */
export function aiSourceOf(platform: string): AiSourceRow | null {
  return (AI_SOURCE as Record<string, AiSourceRow>)[platform] ?? null;
}

/** 一稿多平台里，公众号那颗按钮旁边的理由。只有这一处定义，页面引用它而不是抄一遍。 */
export const WECHAT_DERIVE_HINT = '公众号是元宝的独家信源——目前唯一能联网搜公众号的 AI';

/**
 * 该不该给这个工作区提示「你缺一个公众号」。
 *
 * 只对「有别的平台号、偏偏没有公众号」的人显示：
 *   · 已经有公众号的 —— 他已经在做了，再提示一遍是噪音；
 *   · 一个号都还没建的 —— 他还在冷启动，先建号比谈 AI 引用池重要得多，
 *     这时候弹一条「你缺公众号」是在给新人加任务。
 * 'multi' 之类的伪平台键不算「别的平台号」（它不对应任何一个真平台，也派生不出东西）。
 */
export function shouldHintWechatAiSource(ownedPlatforms: readonly string[]): boolean {
  const real = ownedPlatforms.filter((p): p is PlatformKey => p in AI_SOURCE);
  return !real.includes('wechat') && real.length > 0;
}
