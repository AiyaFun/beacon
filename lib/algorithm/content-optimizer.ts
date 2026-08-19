// 切片B 内容优化算法引擎：对「一篇待发正文」做确定性、可解释的逐维诊断（零 LLM 成本，可高频调用）。
// 与 coach.ts 的分工：coach 诊断「账号级」历史数据短板；本模块诊断「单篇内容」的结构问题，
// 并可传入账号真实数据基线（MetricBaseline）把通用规则升级为个性化结论。
// 规则均为数据驱动结构，便于按平台扩展；阈值为行业共识层面的方向性建议，非平台官方参数。

import { PLATFORMS } from '@/lib/constants';
import type { MetricBaseline } from './coach';

export type ContentFinding = {
  dimension: string; // 诊断维度中文名
  severity: 'good' | 'warn' | 'bad';
  finding: string; // 现状（含具体数字）
  advice: string; // 可执行建议
};

export type ContentDiagnosis = {
  findings: ContentFinding[];
  /**
   * 20-100；**null = 这个平台的规则表还不全，给不出可比的分**。
   * null 不是 0 分也不是满分，UI 必须显示 scoreNote 而不是印一个数字。
   */
  score: number | null;
  /** score 为 null 时的原因（唯一文案来源）；有分时为 null。 */
  scoreNote: string | null;
  personalized: boolean; // 是否结合了账号真实数据基线
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ── 数据驱动的平台规则表 ──

// 各平台合理篇幅区间（字数，含标点；min=0 表示不做过短检查）
const LENGTH_RULES: Record<string, { min: number; max: number; form: string; overAdvice: string; underAdvice: string }> = {
  douyin: {
    min: 150, max: 800, form: '口播稿',
    overAdvice: '口播超 800 字通常意味着成片超 90 秒，完播率会被拖垮：删铺垫与重复论证，或拆成上下两条。',
    underAdvice: '不足 150 字撑不起一条有信息量的口播，补一个具体案例或数据点。',
  },
  xiaohongshu: {
    min: 300, max: 1200, form: '图文笔记',
    overAdvice: '超过 1200 字阅读负担偏重、完读率下滑，把次要内容折进「下一篇」或评论区置顶。',
    underAdvice: '不足 300 字很难形成「值得收藏」的干货密度，补步骤、清单或数据。',
  },
  wechat: {
    min: 800, max: 4000, form: '公众号文章',
    overAdvice: '超过 4000 字完读率显著下滑（完读率影响推荐流二次分发），拆成系列或加目录导读。',
    underAdvice: '推荐流下太短的文章缺乏完读与「在看」的积累空间，扩充到 800 字以上。',
  },
  bilibili: {
    min: 500, max: 3500, form: '中长视频脚本',
    overAdvice: '脚本超 3500 字成片偏长，先用留存曲线验证再加量；建议压缩、删注水段。',
    underAdvice: '中长视频脚本至少 500 字才撑得起 3 分钟以上的信息增量。',
  },
  x: {
    min: 0, max: 560, form: '推文',
    overAdvice: '超过单帖容量，建议拆成 Thread：首帖抛核心观点当钩子，后续每帖一个论据——Thread 还能拉停留时长与 profile click。',
    underAdvice: '',
  },
  youtube: {
    min: 800, max: 5000, form: '长视频脚本',
    overAdvice: '脚本超 5000 字注水风险高，中段流失会伤观看时长信号，删减到 5000 字内。',
    underAdvice: '不足 800 字难以支撑 5 分钟以上的观看时长积累，补案例与演示环节。',
  },
  tiktok: {
    min: 60, max: 900, form: '短视频口播稿',
    overAdvice: '超 900 字成片会拖到 3 分钟以上，完播率是 TikTok 的第一信号，先砍到 60 秒以内的量再谈加长。',
    underAdvice: '不足 60 字撑不起一条有信息量的短视频，容易被划走；补一个具体场景或结果。',
  },
};

// 各平台文末互动引导（CTA）核心词与建议
const CTA_RULES: Record<string, { words: string[]; label: string; advice: string }> = {
  douyin: {
    words: ['评论', '留言', '关注', '点赞', '弹幕'], label: '评论/关注引导',
    advice: '结尾加一句争议性提问或「你会选哪个」二选一——评论互动是撬动下一级流量池的关键信号。',
  },
  xiaohongshu: {
    words: ['收藏', '码住', '马住', '关注'], label: '收藏/关注引导',
    advice: '文末加「收藏备用」提示——收藏是 CES 互动分的核心加权项，还带来搜索长尾。',
  },
  wechat: {
    words: ['在看', '星标', '点赞', '分享'], label: '在看/星标引导',
    advice: '文末直接请求「点在看/设星标」——「在看」进入朋友♡社交推荐池，是当前最大增量入口。',
  },
  bilibili: {
    words: ['三连', '投币', '充电', '收藏', '关注'], label: '三连/投币引导',
    advice: '在信息密度最高点后口播「一键三连」（B站文化认可的合法引导）——投币是最强价值投票信号。',
  },
  x: {
    words: ['?', '？'], label: '结尾提问',
    advice: '结尾改成开放式提问——开源算法中 reply≈27×like、作者回复≈150×like，对话链是 X 最大杠杆。',
  },
  youtube: {
    words: ['订阅', 'subscribe', '点赞', 'like'], label: '订阅引导',
    advice: '结尾加订阅引导 + 下期预告——订阅与会话时长共同决定推荐量。',
  },
  tiktok: {
    words: ['comment', 'follow', 'share', 'part 2', '?', '？'], label: '评论/转发引导',
    advice: '结尾抛一个非此即彼的问题，或预告 Part 2——评论与转发是 TikTok 把内容推出兴趣圈层的主要信号，比点赞权重高。',
  },
};

// 开头钩子元素：数字 / 疑问 / 冲突或结果前置词 / 第二人称
const HOOK_SIGNALS: { name: string; re: RegExp }[] = [
  { name: '数字', re: /\d/ },
  { name: '疑问', re: /[?？]|吗|为什么|凭什么|怎么办|如何/ },
  { name: '冲突/结果前置', re: /最|别|千万|竟|居然|实测|亲测|警告|真相|后悔|避雷|翻车|坑|错了|没想到/ },
  { name: '第二人称', re: /你/ },
];

// 绝对化/标题党算法风险词（合规词库之外的算法侧提示：伤满意度信号、易触发限流）
const RISK_WORDS = ['保证', '必爆', '必火', '震惊', '100%', '史上最', '绝对有效', '错过再无', '不看后悔', '全网首发'];

// 清单结构：数字序号 / ①② / emoji 列表 / 短横列表
const LIST_RE = /[①-⑳]|(?:^|\n)\s*\d+\s*[.、．)]|(?:^|\n)\s*[-•·]|[✅✔☑📌🔹]/u;

// 评论率偏弱的相对阈值（评论率 < 点赞率 × ratio 视为弱；与 coach.ts 口径对齐）
const COMMENT_WEAK_RATIO: Record<string, number> = { douyin: 0.05, x: 0.5 };

// ── 长文结构判据（只对 kind === 'article' 的平台生效）────────────────────────
//
// 【为什么按 kind 判而不是写死平台 key】这三条量的是「一段文字被单独抠出来还能不能读懂」，
// 是**长文形态**的属性，不是公众号这个平台的属性。今天 PLATFORMS 里 kind==='article'
// 只有公众号一个，将来知乎/百家号进表就该自动生效——写死 'wechat' 的话得记得再改一次这里，
// 而漏改是静默的（只是少了三条诊断，页面照样一切正常，没人会发现）。
//
// 【它们量的是什么，不量什么】三条都只陈述结构事实（有几句以指代开头、剔完日期还剩几个数字、
// 有没有定义句和边界说明）。它们**不预测任何分发结果**——一段文字最终有没有被人摘走、
// 被谁摘走，主项是平台与渠道，不是这几条句法。把句法当分发结果的代理指标印给用户，
// 就是拿代理冒充观测（同「缺席不许当 0」那条纪律的另一种犯法方式）。

// 三条判据共同的下限：短于这个字数的稿子还在起草中，占比/密度算出来都是噪声。
// 同「样本不足不出结论」（humanize/score.ts 的 sufficient、insight/guardrails.ts 的 <5 不出数）。
export const ARTICLE_MIN_CHARS = 300;
// 自包含性额外要句子数够：3 句里 1 句指代开头就是 33%，那是分母太小，不是问题。
export const ARTICLE_MIN_SENTENCES = 5;
// 指代开头句占比超过这个数才报。
export const ANAPHORA_RATIO_LIMIT = 0.3;
// 真数字密度下限（每千字个数），低于它报「量化论据不足」。
export const REAL_NUMBER_PER_1K_MIN = 2;

// 指代开头：句子的第一个词就在指回上文，这句被单独抠出来（摘录、目录跳转、片段转发）就不成立。
const ANAPHORA_START_RE =
  /^(?:如前所述|综上所述|承上|上文|前文|上述|以上|(?:上面|前面|刚才)(?:说|讲|提|提到|说到|讲到)|这|那|该|其|它们?|他们|她们)/;
// 形似指代、其实不指回上文的开头。不排掉的话「其实/其次/那么」会把占比刷到失真，
// 而一条恒亮的告警等于没有告警。
const PSEUDO_ANAPHORA_RE = /^(?:其实|其次|那么)/;

// 日期：19xx/20xx 起头，覆盖 -、/、年月 三种分隔符。月/日后要数字边界，
// 否则「5000-8000」这类区间会被整段当成日期吃掉（Python 版 _DATE_ANY 同一处考量）。
const DATE_RE = /(?<!\d)(?:19|20)\d{2}\s*[-/年]\s*\d{1,2}(?!\d)(?:\s*[-/月]\s*\d{1,2}(?!\d))?\s*日?/g;
// 中文里「6月18日」这种不带年份的写法极常见（节点、大促），照样不是论据，Python 版没覆盖，这里补上。
// 代价是「用了 3 月」这种口语时长会被误剔——比起把满篇日期算成论据，这个方向的误差更能接受。
const CN_MONTH_DAY_RE = /(?<!\d)\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?/g;
// 版本号：带 v 的两段起，或裸三段起。裸两段（87.3）保留——那是小数，是真数字。
const VERSION_RE = /(?<![A-Za-z0-9])v\d+(?:\.\d+)+(?!\d)|(?<!\d)\d+\.\d+\.\d+(?!\d)/gi;
// 章节序号：「第3章」「第 2 步」是文章结构，不是论据。
const SECTION_NO_RE = /第\s*\d+\s*(?:章|节|篇|部分|讲|步|点|条)/g;
// 只数阿拉伯数字。中文数字（三成/两倍）在 humanize/factcheck.ts 的 NUM_RE 里必须抓——那边要的是
// 「改写后多出来的数字」，宁可多问一句；这边要的是「有多少可核对的量化论据」，
// 把「一个/三年前/两句话」算进来会把密度刷满，两边口径互补，谁都别去改对方。
const NUM_RE = /\d+(?:[.,]\d+)?%?/g;

// 术语定义句 / 问答块。**只收显式定义构式**：把「如何/怎么/为什么」也收进来的话，
// 长文里几乎必然出现，这条判据就恒为真，等于没做。
//
// 两处负向后顾是实测补的（两批中文长文语料反推，见 tests/algorithm/content-optimizer.test.ts）：
// 「为什么是这三款」里含「什么是」、「这是指标体系」「不是指望」里含「是指」——
// 都是长文高频写法，裸子串一律误判成「写了定义句」。
const DEFINITION_RE =
  /(?<![为凭])什么是|所谓|(?<![这那不就只但可])是指|指的是|定义为|可以理解为|简单说|通俗地?讲|常见问题|FAQ|Q[:：]|问[:：]/i;
// 适用边界 / 局限说明（对应 Python 版 _LIMIT 的中文部分）。
//
// ⚠️ 这里**只收构式，不收裸词**，代价是漏报，但反过来的错更贵。原先收「注意/风险/限制/前提」
// 四个裸词，实测（仓库自有中文长文语料 54 段）12 次命中里有 10 次是靠这四个词撑起来的，
// 一条真·边界说明都没有。最要命的是「值得注意的是」——它是本库 AI 味词库里 weight 3 的套话
// （lib/humanize/lexicon.ts 的 TRANSITION），而 analyzeContent 的主要输入正是 LLM 起的稿：
// 同一个编辑器，左边把这半句标成 AI 腔红字，右边拿它当「你写了适用边界」放行。
const LIMIT_RE =
  /局限性|局限在|适用范围|适用于|不适用|仅限|例外情况|前提是|前提条件|风险在于|风险点|免责|并不适合|不一定|因人而异|视情况|不保证|做不到|做不了/;

/** 这个平台是不是长文形态。表里没有的平台一律 false——不认识就不套长文判据。 */
function isArticlePlatform(platform: string): boolean {
  return (PLATFORMS as Record<string, { kind: string } | undefined>)[platform]?.kind === 'article';
}

// 断句只切到句号级标点，不切分号/逗号：分号后的分句本来就依附前半句，
// 把它算成「以指代开头的句子」是误报。
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?…\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 剔掉日期、版本号、章节序号后的正文——剩下的数字才当论据数。 */
export function stripNonEvidenceNumbers(text: string): string {
  return text
    .replace(DATE_RE, ' ')
    .replace(VERSION_RE, ' ')
    .replace(SECTION_NO_RE, ' ')
    .replace(CN_MONTH_DAY_RE, ' ');
}

/** 真数字个数：剔除日期/版本号/章节序号之后还剩几个数字。 */
export function realNumberCount(text: string): number {
  return (stripNonEvidenceNumbers(text).match(NUM_RE) ?? []).length;
}

/**
 * 篇幅与 CTA 两张规则表**都**有这个平台，才算这一篇能被完整评分。
 * 目前视频号（shipinhao）两张表都不在，是这条判断真正拦住的那个平台。
 */
export function scoreCovered(platform: string): boolean {
  return Boolean(LENGTH_RULES[platform] && CTA_RULES[platform]);
}

/** 规则覆盖不全时给用户看的原因。唯一文案来源，UI 不许另写一份。 */
export const UNSCORED_NOTE = '这个平台还没有篇幅/互动引导基准，本次只跑了通用维度，不给总分——规则不全时分数只会虚高。';

// 取第一句（到第一个。！？!?或换行，保留句末标点以便疑问检测）
function firstSentence(text: string): string {
  const m = text.match(/^[^。！？!?\n]*[。！？!?]?/);
  return (m ? m[0] : text).trim();
}

// 标题核心词：去掉标点后最长词段的前 4 字（至少 2 字才有检索意义）
function coreKeyword(title: string): string | null {
  const segs = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (segs.length === 0) return null;
  const longest = segs.reduce((m, s) => (s.length > m.length ? s : m), '');
  const core = longest.slice(0, 4);
  return core.length >= 2 ? core : null;
}

export function analyzeContent(
  text: string,
  platform: string,
  opts?: { title?: string; baseline?: MetricBaseline | null },
): ContentDiagnosis {
  const body = text.trim();
  // 只有真实样本 > 0 的基线才参与个性化
  const b = opts?.baseline && opts.baseline.sample > 0 ? opts.baseline : null;
  const personalized = !!b;
  const findings: ContentFinding[] = [];

  // 规则覆盖度先算：它决定这一篇到底给不给分（见文件末尾评分段的说明）。
  // 空正文也照这条走——null 的含义是「这个平台给不出可比的分」，破例给它一个 20 会让这个字段有两种读法。
  const covered = scoreCovered(platform);

  if (!body) {
    return {
      findings: [{ dimension: '正文', severity: 'warn', finding: '正文为空。', advice: '先输入内容再诊断。' }],
      score: covered ? 20 : null,
      scoreNote: covered ? null : UNSCORED_NOTE,
      personalized,
    };
  }

  // 个性化升级开关：账号完播基线弱 → 钩子/篇幅问题从 warn 升级为 bad，并引用真实数据
  const weakCompletion = !!b && b.avgCompletion !== null && b.avgCompletion < 0.4;
  const completionNote = weakCompletion && b ? `你近 ${b.sample} 条平均完播率仅 ${pct(b.avgCompletion!)}，` : '';

  // ── 1. 开头钩子（所有平台）──
  const first = firstSentence(body);
  const hookHits = HOOK_SIGNALS.filter((h) => h.re.test(first)).map((h) => h.name);
  if (first.length > 40) {
    findings.push({
      dimension: '开头钩子',
      severity: weakCompletion ? 'bad' : 'warn',
      finding: `第一句 ${first.length} 字，铺垫过长（建议 ≤40 字）。`,
      advice: `${completionNote}把结果/冲突压进第一句：「${first.slice(0, 12)}…」改为先抛结论或反差，背景放到第二句之后。`,
    });
  } else if (hookHits.length === 0) {
    findings.push({
      dimension: '开头钩子',
      severity: weakCompletion ? 'bad' : 'warn',
      finding: `第一句「${first.slice(0, 20)}${first.length > 20 ? '…' : ''}」缺少钩子元素（数字/疑问/冲突词/第二人称均未检出）。`,
      advice: `${completionNote}第一句加数字对比、疑问句或「最/别/千万/实测」类前置词，3 秒内给用户一个留下来的理由。`,
    });
  } else {
    findings.push({
      dimension: '开头钩子',
      severity: 'good',
      finding: `第一句 ${first.length} 字，含钩子元素：${hookHits.join('、')}。`,
      advice: '开头结构达标，保持结果前置的写法。',
    });
  }

  // ── 2. 篇幅适配 ──
  const lr = LENGTH_RULES[platform];
  const len = body.length;
  if (lr) {
    if (len > lr.max) {
      findings.push({
        dimension: '篇幅适配',
        severity: weakCompletion ? 'bad' : 'warn',
        finding: `正文 ${len} 字，超出${lr.form}合理区间（${lr.min > 0 ? `${lr.min}–` : '≤'}${lr.max} 字）。`,
        advice: `${completionNote}${lr.overAdvice}`,
      });
    } else if (lr.min > 0 && len < lr.min) {
      findings.push({
        dimension: '篇幅适配',
        severity: 'warn',
        finding: `正文 ${len} 字，低于${lr.form}合理区间（${lr.min}–${lr.max} 字）。`,
        advice: lr.underAdvice,
      });
    } else {
      findings.push({
        dimension: '篇幅适配',
        severity: 'good',
        finding: `正文 ${len} 字，处于${lr.form}合理区间（${lr.min > 0 ? `${lr.min}–` : '≤'}${lr.max} 字）。`,
        advice: '篇幅合适，把精力放在信息密度与节奏上。',
      });
    }
  }

  // ── 3. 段落结构 ──
  const paras = body.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const longestPara = paras.reduce((m, p) => Math.max(m, p.length), 0);
  if (longestPara > 200) {
    findings.push({
      dimension: '段落结构',
      severity: 'warn',
      finding: `最长段落 ${longestPara} 字（共 ${paras.length} 段），大段文字在移动端劝退读者。`,
      advice: '按「一段一个信息点」拆段，单段控制在 100 字内，段间留白降低跳出。',
    });
  }
  // 小红书：清单结构检测（清单体直接抬收藏率）
  if (platform === 'xiaohongshu') {
    // 率是 null（该平台拿不到播放量）时不算「弱」——那是没数据，不是表现差。
    // 判据和引用它的那句话一起算：分开写的话 TS 收窄不到，还容易漏掉一处印出 0.0%。
    const collectLine =
      b && b.collectRate !== null && b.likeRate !== null && b.collectRate < b.likeRate * 0.3
        ? `你近 ${b.sample} 条收藏率 ${pct(b.collectRate)} 明显低于点赞率 ${pct(b.likeRate)}，`
        : '';
    const weakCollect = collectLine !== '';
    if (!LIST_RE.test(body)) {
      findings.push({
        dimension: '清单结构',
        severity: weakCollect ? 'bad' : 'warn',
        finding: '正文未检出清单/序号结构（数字序号、①②、emoji 列表均未出现）。',
        advice: `${collectLine}改成「N 个要点」清单体：序号 + 小标题 + 一句展开——「留着有用」的结构直接提升收藏（CES 核心加权项）。`,
      });
    } else {
      findings.push({
        dimension: '清单结构',
        severity: 'good',
        finding: '检出清单/序号结构，符合小红书收藏型内容形态。',
        advice: '保持清单体，结尾用「收藏备用」承接收藏动作。',
      });
    }
  }

  // ── 4. 互动引导 CTA（检测文末 25%）──
  const cta = CTA_RULES[platform];
  if (cta) {
    const tail = body.slice(Math.floor(body.length * 0.75));
    const commentLine =
      b && b.commentRate !== null && b.likeRate !== null &&
      b.commentRate < b.likeRate * (COMMENT_WEAK_RATIO[platform] ?? 0.1)
        ? `你近 ${b.sample} 条评论率仅 ${pct(b.commentRate)}（点赞率 ${pct(b.likeRate)}），互动引导是当前第一优先修复项。`
        : '';
    const weakComment = commentLine !== '';
    if (!cta.words.some((w) => tail.includes(w))) {
      findings.push({
        dimension: `互动引导（${cta.label}）`,
        severity: weakComment ? 'bad' : 'warn',
        finding: `文末 25% 未检出${cta.label}相关表述。`,
        advice: `${commentLine}${cta.advice}`,
      });
    } else {
      findings.push({
        dimension: `互动引导（${cta.label}）`,
        severity: 'good',
        finding: `文末已包含${cta.label}。`,
        advice: '发布后 30–60 分钟内作者下场回评，把互动信号做实。',
      });
    }
  }

  // ── 5. 搜索关键词（小红书，需传入标题）──
  if (platform === 'xiaohongshu' && opts?.title) {
    const core = coreKeyword(opts.title);
    if (core) {
      const count = body.split(core).length - 1;
      if (count < 2) {
        findings.push({
          dimension: '搜索关键词',
          severity: 'warn',
          finding: `标题核心词「${core}」在正文仅出现 ${count} 次（建议 ≥2 次）。`,
          advice: '首段点题 + 正文自然重复标题核心词 2–3 次——小红书约一半流量来自搜索，埋词吃长尾。',
        });
      } else {
        findings.push({
          dimension: '搜索关键词',
          severity: 'good',
          finding: `标题核心词「${core}」在正文出现 ${count} 次，搜索埋词到位。`,
          advice: '可再补 1–2 个下拉联想长尾词，扩大搜索覆盖。',
        });
      }
    }
  }

  // ── 6. 外链降权（X）──
  if (platform === 'x' && /https?:\/\//i.test(body)) {
    findings.push({
      dimension: '外链降权',
      severity: 'warn',
      finding: '正文含 http(s) 外链。',
      advice: '把链接移到首条回复——非 Premium 账号正文带外链普遍被降权（开源代码 + 大量实测）。',
    });
  }

  // ── 7. 绝对化/标题党算法风险词 ──
  const riskHits = RISK_WORDS.filter((w) => body.includes(w));
  if (riskHits.length > 0) {
    findings.push({
      dimension: '算法风险词',
      severity: 'warn',
      finding: `检出绝对化/标题党风险词：${riskHits.map((w) => `「${w}」`).join('')}。`,
      advice: '换成可验证的具体描述（数据、实测过程）——过度承诺伤满意度信号，各平台都会算法侧惩罚，且部分词同时踩合规红线。',
    });
  }

  // ── 8. 长文结构判据（kind === 'article'）──
  // 三条都只在正文够长时才出结论；不够长时**一条都不出**（不是出 good），
  // 因为「没测」和「测过没问题」在用户眼里长得一样，但含义完全相反。
  if (isArticlePlatform(platform) && len >= ARTICLE_MIN_CHARS) {
    // 8a. 自包含性
    const sentences = splitSentences(body);
    if (sentences.length >= ARTICLE_MIN_SENTENCES) {
      const anaphoric = sentences.filter(
        (s) => ANAPHORA_START_RE.test(s) && !PSEUDO_ANAPHORA_RE.test(s),
      );
      const ratio = anaphoric.length / sentences.length;
      if (ratio > ANAPHORA_RATIO_LIMIT) {
        const first = anaphoric[0];
        findings.push({
          dimension: '自包含性',
          severity: 'warn',
          finding: `共 ${sentences.length} 句，有 ${anaphoric.length} 句以指代开头（${pct(ratio)}），第一处是「${first.slice(0, 20)}${first.length > 20 ? '…' : ''}」——脱离上文单独读不成立。`,
          advice: '把句首的指代换成它指向的那个具体名词（「这个方法」→「双层缓存」），每句拿出来单独看都要能站住。',
        });
      } else {
        findings.push({
          dimension: '自包含性',
          severity: 'good',
          finding: `共 ${sentences.length} 句，以指代开头的 ${anaphoric.length} 句（${pct(ratio)}），大部分句子能独立成立。`,
          advice: '保持每句自带主语的写法。',
        });
      }
    }

    // 8b. 真数字密度（先剔日期/版本号/章节序号再数——「2026年6月」「v2.0」「第3章」不是论据）
    const realNums = realNumberCount(body);
    const per1k = (realNums / len) * 1000;
    if (per1k < REAL_NUMBER_PER_1K_MIN) {
      findings.push({
        dimension: '量化论据',
        severity: 'warn',
        finding: `正文 ${len} 字，剔除日期/版本号/章节序号后只剩 ${realNums} 个数字（每千字 ${per1k.toFixed(1)} 个，低于 ${REAL_NUMBER_PER_1K_MIN}）。`,
        advice: '把「大幅提升 / 很多人 / 效果明显」换成具体数值和口径（多少、什么时间、多大样本）；日期和版本号不算论据。',
      });
    } else {
      findings.push({
        dimension: '量化论据',
        severity: 'good',
        finding: `剔除日期/版本号后仍有 ${realNums} 个数字（每千字 ${per1k.toFixed(1)} 个），量化论据密度够。`,
        advice: '保持给数字配上口径（时间、样本、来源），别只留一个孤零零的百分比。',
      });
    }

    // 8c. 定义块与限制说明
    const hasDef = DEFINITION_RE.test(body);
    const hasLimit = LIMIT_RE.test(body);
    // 两样**都**没有才提示，不是缺一样就提示。
    //
    // 收严正则之后（见 DEFINITION_RE / LIMIT_RE 上面那两段），两条构式在真实中文长文里的
    // 命中率都只有一成上下——按「缺一样就报」算，几乎每篇都会亮，而一条恒亮的告警等于没有告警
    // （同 PSEUDO_ANAPHORA_RE 那条注释的道理）。更要紧的是它对**叙事型内容根本不适用**：
    // 复盘、故事、随笔本来就不需要术语定义，逼他补一句「X 是指……」是把说明文格式套到所有人头上。
    // 「两样都没有」才是一个真正值得说的信号：整篇既没解释清楚概念、也没交代适用条件。
    if (!hasDef && !hasLimit) {
      findings.push({
        dimension: '定义与边界',
        severity: 'warn',
        finding: '全文既没有术语定义句，也没有适用边界/局限说明。',
        advice:
          '二选一补一处即可：用「X 是指……」把核心概念说清，或交代适用前提与不适用场景（什么条件下这套做法不成立）——两样都缺时，读者只能按自己的理解去套，抠走任意一段也读不出限定条件。',
      });
    } else {
      findings.push({
        dimension: '定义与边界',
        severity: 'good',
        finding: hasDef && hasLimit
          ? '正文既有术语定义句，也写了适用边界/局限说明。'
          : `正文有${hasDef ? '术语定义句' : '适用边界/局限说明'}。`,
        advice: '保持这个结构，边界说明尽量给出具体条件而不是「仅供参考」。',
      });
    }
  }

  // ── 评分：100 起步，bad −15、warn −6，clamp 20–100 ──
  //
  // ⚠️ 规则覆盖不全的平台**不给分**。这套评分是扣分制，而 LENGTH_RULES / CTA_RULES 查不到平台时
  // 上面那两段是**静默跳过**的：不检查 = 不扣分 = 分更高。于是两张表里没有的平台（视频号至今
  // 一张表都没进）反而拿满分，用户看到的是一个像模像样、却完全由「没检查」堆出来的数字。
  // 这是「缺席不许当 0」的反向踩坑：缺席被当成了「满分通过」。
  //
  // 为什么返回 null 而不是加个 coverage 布尔让调用方自己判：布尔要靠每个调用方**记得**去判，
  // 漏判是静默的（照样印出虚高分，和修之前一模一样）；改成可空，tsc 会把每个调用点逼出来。
  if (!covered) return { findings, score: null, scoreNote: UNSCORED_NOTE, personalized };

  let score = 100;
  for (const f of findings) {
    if (f.severity === 'bad') score -= 15;
    else if (f.severity === 'warn') score -= 6;
  }
  score = Math.max(20, Math.min(100, score));

  return { findings, score, scoreNote: null, personalized };
}
