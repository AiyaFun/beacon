// 切片B 内容优化算法引擎：对「一篇待发正文」做确定性、可解释的逐维诊断（零 LLM 成本，可高频调用）。
// 与 coach.ts 的分工：coach 诊断「账号级」历史数据短板；本模块诊断「单篇内容」的结构问题，
// 并可传入账号真实数据基线（MetricBaseline）把通用规则升级为个性化结论。
// 规则均为数据驱动结构，便于按平台扩展；阈值为行业共识层面的方向性建议，非平台官方参数。

import type { MetricBaseline } from './coach';

export type ContentFinding = {
  dimension: string; // 诊断维度中文名
  severity: 'good' | 'warn' | 'bad';
  finding: string; // 现状（含具体数字）
  advice: string; // 可执行建议
};

export type ContentDiagnosis = {
  findings: ContentFinding[];
  score: number; // 20-100
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

  if (!body) {
    return {
      findings: [{ dimension: '正文', severity: 'warn', finding: '正文为空。', advice: '先输入内容再诊断。' }],
      score: 20,
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
    const weakCollect = !!b && b.collectRate < b.likeRate * 0.3;
    if (!LIST_RE.test(body)) {
      findings.push({
        dimension: '清单结构',
        severity: weakCollect ? 'bad' : 'warn',
        finding: '正文未检出清单/序号结构（数字序号、①②、emoji 列表均未出现）。',
        advice: `${weakCollect && b ? `你近 ${b.sample} 条收藏率 ${pct(b.collectRate)} 明显低于点赞率 ${pct(b.likeRate)}，` : ''}改成「N 个要点」清单体：序号 + 小标题 + 一句展开——「留着有用」的结构直接提升收藏（CES 核心加权项）。`,
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
    const weakComment = !!b && b.commentRate < b.likeRate * (COMMENT_WEAK_RATIO[platform] ?? 0.1);
    if (!cta.words.some((w) => tail.includes(w))) {
      findings.push({
        dimension: `互动引导（${cta.label}）`,
        severity: weakComment ? 'bad' : 'warn',
        finding: `文末 25% 未检出${cta.label}相关表述。`,
        advice: `${weakComment && b ? `你近 ${b.sample} 条评论率仅 ${pct(b.commentRate)}（点赞率 ${pct(b.likeRate)}），互动引导是当前第一优先修复项。` : ''}${cta.advice}`,
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

  // ── 评分：100 起步，bad −15、warn −6，clamp 20–100 ──
  let score = 100;
  for (const f of findings) {
    if (f.severity === 'bad') score -= 15;
    else if (f.severity === 'warn') score -= 6;
  }
  score = Math.max(20, Math.min(100, score));

  return { findings, score, personalized };
}
