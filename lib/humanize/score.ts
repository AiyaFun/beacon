import { scanAiFlavor, AI_FLAVOR_CATEGORY_LABEL, type AiFlavorHit } from './lexicon';

// 人味分：一篇稿子「像不像人写的」的**确定性**体检（零 LLM、可高频调用、可解释）。
//
// ─────────────── 为什么 AI 味能被规则测出来 ───────────────
// AI 味的本质不是用词华丽，是**分布过于均匀**：句子长度几乎一样、段落几乎等长、
// 句句都是完整主谓宾、每隔几句来一组对仗、外加一批模型偏爱的套话。
// 人写东西是不均匀的——忽长忽短，会有半句话，会有一个词单独成段。
// 所以这里量的是「方差」和「密度」，而不是「词好不好」。这也是它能做成规则而非 LLM 的原因。
//
// ─────────────── 两条纪律 ───────────────
// ① **阈值是方向性经验值，不是平台官方参数**——与 algorithm/content-optimizer.ts 同一约定，
//    UI 上不许把它说成「平台标准」。
// ② **样本不足就不报分**（sufficient=false）。一段 40 字的稿子算不出句长方差，
//    硬给一个 73 分只会让用户把噪声当信号——与「不足 3 条不报胜率」同一条规矩。

export type HumanizeSeverity = 'good' | 'warn' | 'bad';

export type HumanizeFinding = {
  dimension: string;
  severity: HumanizeSeverity;
  finding: string;
  advice: string;
};

export type HumanizeMetrics = {
  chars: number;
  sentences: number;
  avgSentenceLen: number;
  /** 句长变异系数（标准差/均值）：越小越平铺 */
  lenCv: number;
  /** 段落长度变异系数 */
  paraCv: number;
  /** 每千字对仗/排比句式数 */
  parallelPer1k: number;
  /** 短句（≤8 字）占比：口语碎句的代理指标 */
  shortRatio: number;
  /** 每千字套话加权命中 */
  flavorPer1k: number;
};

export type HumanizeReport = {
  /** 20-100，越高越像人写的。sufficient=false 时该值无意义，UI 不许展示 */
  score: number;
  sufficient: boolean;
  findings: HumanizeFinding[];
  hits: AiFlavorHit[];
  metrics: HumanizeMetrics;
};

// 少于这个字数不出分：方差类指标在短文本上是噪声。
export const MIN_CHARS_FOR_SCORE = 120;
// 少于这么多句同理（一段长独白也算不出句长分布）。
const MIN_SENTENCES = 5;

// 口语形态的平台：这些平台上「句句完整、零碎句」是真问题；
// 公众号/知乎/YouTube 长文本来就该完整成句，不该因此扣分。
const COLLOQUIAL_PLATFORMS = new Set(['douyin', 'xiaohongshu', 'shipinhao', 'x', 'bilibili']);

// 对仗/排比句式：模型最爱、人偶尔用。用「一句之内成对出现」的正则匹配，避免跨句误报。
const PARALLEL_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /不仅[^。！？!?\n]{0,24}(而且|并且|还|更)/g, name: '不仅…而且' },
  { re: /既[^。！？!?\n]{0,20}又[^。！？!?\n]{0,20}/g, name: '既…又' },
  { re: /不是[^。！？!?\n]{0,20}而是/g, name: '不是…而是' },
  { re: /不只是[^。！？!?\n]{0,20}更是/g, name: '不只是…更是' },
  { re: /(?:^|[，。！？!?\n])[^。！？!?\n]{0,20}是[^。！？!?\n]{0,16}，更是/g, name: '是…更是' },
  { re: /无论[^。！？!?\n]{0,20}都/g, name: '无论…都' },
  { re: /从[^。！？!?\n]{0,14}到[^。！？!?\n]{0,14}再到/g, name: '从…到…再到' },
  { re: /要么[^。！？!?\n]{0,20}要么/g, name: '要么…要么' },
];

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?…；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function cv(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function countParallel(text: string): number {
  let n = 0;
  for (const { re } of PARALLEL_PATTERNS) {
    n += (text.match(re) ?? []).length;
  }
  return n;
}

export function humanizeReport(text: string, platform?: string): HumanizeReport {
  const body = (text ?? '').trim();
  const chars = body.length;
  const sentences = splitSentences(body);
  const paragraphs = splitParagraphs(body);
  const lens = sentences.map((s) => s.length);
  const hits = scanAiFlavor(body);

  const per1k = (n: number) => (chars > 0 ? round2((n / chars) * 1000) : 0);
  const weightedFlavor = hits.reduce((a, h) => a + h.weight, 0);
  const metrics: HumanizeMetrics = {
    chars,
    sentences: sentences.length,
    avgSentenceLen: lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
    lenCv: round2(cv(lens)),
    paraCv: round2(cv(paragraphs.map((p) => p.length))),
    parallelPer1k: per1k(countParallel(body)),
    shortRatio: lens.length ? round2(lens.filter((l) => l <= 8).length / lens.length) : 0,
    flavorPer1k: per1k(weightedFlavor),
  };

  const findings: HumanizeFinding[] = [];
  let penalty = 0;

  // ── 套话密度 ──（唯一一条在短文本上也算数的指标：命中就是命中，不需要分布）
  const heavy = hits.filter((h) => h.weight === 3);
  if (hits.length > 0) {
    const flavorPenalty = Math.min(35, Math.round(metrics.flavorPer1k * 3.5 + heavy.length * 2));
    penalty += flavorPenalty;
    const top = hits.slice(0, 4).map((h) => `「${h.word}」`).join('、');
    const cats = [...new Set(hits.map((h) => AI_FLAVOR_CATEGORY_LABEL[h.category]))].join('/');
    findings.push({
      dimension: '套话密度',
      severity: metrics.flavorPer1k > 8 || heavy.length >= 3 ? 'bad' : 'warn',
      finding: `命中 ${hits.length} 处大模型套话（${cats}），每千字 ${metrics.flavorPer1k} 处：${top}${hits.length > 4 ? ' 等' : ''}`,
      advice: '逐条替换成具体的人、事、数字、时间；说不出具体的就整句删掉——换个同义套话等于没改。',
    });
  } else if (chars >= MIN_CHARS_FOR_SCORE) {
    findings.push({
      dimension: '套话密度',
      severity: 'good',
      finding: '没有命中已知的大模型套话',
      advice: '保持——这一项是读者最容易一眼认出 AI 的地方。',
    });
  }

  const sufficient = chars >= MIN_CHARS_FOR_SCORE && sentences.length >= MIN_SENTENCES;

  if (sufficient) {
    // ── 句子节奏 ──
    if (metrics.lenCv < 0.3) {
      penalty += 18;
      findings.push({
        dimension: '句子节奏',
        severity: 'bad',
        finding: `句长几乎没有起伏（平均 ${metrics.avgSentenceLen} 字，变异系数 ${metrics.lenCv}），读起来像播报`,
        advice: '把其中三五句砍成半句话，再让一两句放长——人说话是忽长忽短的，这一项比换词更能去掉 AI 感。',
      });
    } else if (metrics.lenCv < 0.45) {
      penalty += 8;
      findings.push({
        dimension: '句子节奏',
        severity: 'warn',
        finding: `句长偏均匀（平均 ${metrics.avgSentenceLen} 字，变异系数 ${metrics.lenCv}）`,
        advice: '挑两三处关键的地方，用一个短句单独顶一行，节奏立刻不一样。',
      });
    } else {
      findings.push({
        dimension: '句子节奏',
        severity: 'good',
        finding: `句长有起伏（平均 ${metrics.avgSentenceLen} 字，变异系数 ${metrics.lenCv}）`,
        advice: '保持。',
      });
    }

    // ── 段落节奏 ──（段落太少时不判：三段以内谈不上分布）
    if (paragraphs.length >= 4) {
      if (metrics.paraCv < 0.2) {
        penalty += 10;
        findings.push({
          dimension: '段落节奏',
          severity: 'bad',
          finding: `${paragraphs.length} 个段落长度高度整齐（变异系数 ${metrics.paraCv}）`,
          advice: '整齐的段落是模板感的来源：让一段只有一句话，或把两段并成一长段。',
        });
      } else if (metrics.paraCv < 0.35) {
        penalty += 4;
        findings.push({
          dimension: '段落节奏',
          severity: 'warn',
          finding: `段落长度偏整齐（变异系数 ${metrics.paraCv}）`,
          advice: '挑一个关键结论单独成段，打破匀速。',
        });
      }
    }

    // ── 对仗密度 ──
    if (metrics.parallelPer1k > 4) {
      penalty += 12;
      findings.push({
        dimension: '对仗密度',
        severity: 'bad',
        finding: `每千字 ${metrics.parallelPer1k} 组排比对仗（不仅…而且 / 不是…而是 之类）`,
        advice: '留最有力的一组，其余全部拆成大白话——密集对仗是最容易被读者认出的 AI 特征之一。',
      });
    } else if (metrics.parallelPer1k > 2) {
      penalty += 6;
      findings.push({
        dimension: '对仗密度',
        severity: 'warn',
        finding: `每千字 ${metrics.parallelPer1k} 组排比对仗`,
        advice: '拆掉一半，改成直说。',
      });
    }

    // ── 口语碎句 ──（只对口语形态平台判定；长文平台句句完整是正常的）
    if (!platform || COLLOQUIAL_PLATFORMS.has(platform)) {
      if (metrics.shortRatio < 0.08) {
        penalty += 10;
        findings.push({
          dimension: '口语碎句',
          severity: 'warn',
          finding: `短句（≤8 字）只占 ${Math.round(metrics.shortRatio * 100)}%，几乎句句是完整书面句`,
          advice: '加几句真人说话的碎句：「就这么简单。」「我当时懵了。」——这类句子在口语平台是节奏支点。',
        });
      } else if (metrics.shortRatio < 0.15) {
        penalty += 4;
        findings.push({
          dimension: '口语碎句',
          severity: 'warn',
          finding: `短句占比 ${Math.round(metrics.shortRatio * 100)}%，偏书面`,
          advice: '再补两三句短促的口语句。',
        });
      } else {
        findings.push({
          dimension: '口语碎句',
          severity: 'good',
          finding: `短句占比 ${Math.round(metrics.shortRatio * 100)}%，有口语节奏`,
          advice: '保持。',
        });
      }
    }
  }

  const score = Math.max(20, Math.min(100, 100 - penalty));
  return { score, sufficient, findings, hits, metrics };
}

// 给「一键去 AI 味」用的问题清单（只挑要改的，good 不进 prompt）
export function humanizeProblemBlock(report: HumanizeReport): string {
  const problems = report.findings.filter((f) => f.severity !== 'good');
  if (problems.length === 0) return '';
  return [
    '【这篇稿子被检出的 AI 味问题（逐条改掉）】',
    ...problems.map((f) => `- [${f.dimension}] ${f.finding} → ${f.advice}`),
  ].join('\n');
}
