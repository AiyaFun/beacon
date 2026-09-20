import { platformName } from '../constants';
import { titleLengthRule } from './title';
import { platformFormat, type PlatformFormat } from './platform-format';
import { hasEmoji } from '../humanize/structure';

// 平台格式**体检**（2026-09-17，用户：「就地起稿得内容，还是不符合各个平台的意思」）。
//
// ─────────────── 为什么光有 PLATFORM_FORMAT 不够 ───────────────
// 1.3.76 把各平台的字数/标题/分段/标签写成了可执行的格式块喂给模型（platform-format.ts），
// 但**落库前没有任何一处检查模型到底照没照做**。提示词只降低概率：模型会给不需要标题的
// 抖音口播稿加一行标题，会把小红书的 3-6 个 #话题# 全忘了，会写出 2400 字的「短视频脚本」。
// 用户看到的就是「不符合这个平台的意思」。
//
// 本项目在提示词这件事上的结论一直是同一条（见 two-stage 的 stripStageLabels、
// lib/humanize/factcheck）：**能确定性检查的，就不要指望模型听话**。所以这里：
//   · checkPlatformFit  量出到底违了哪几条（零 LLM、可解释、可测）
//   · enforceFormat     能直接改对的（markdown、栏目壳、口播稿里的 emoji、超量标签）当场改掉
//   · formatProblemBlock 改不掉的（字数不够、缺标签、语言不对）写成清单，交给修复那一次调用
//
// ─────────────── 一条纪律 ───────────────
// 字数区间是**方向性经验值**，不是平台参数（与 title.ts / humanize/score.ts 同一约定）。
// 所以字数只判到 warn，且文案写「偏短/偏长」，不写「不符合平台规定」。

export type FitSeverity = 'bad' | 'warn';

export type FormatViolation = {
  /** 稳定的机器码，测试与 UI 按它断言，不按文案 */
  code: string;
  severity: FitSeverity;
  /** 给人看的一句话 */
  finding: string;
  /** 给模型的可执行指令 */
  fix: string;
};

export type FormatFitReport = {
  platform: string;
  violations: FormatViolation[];
  /** bad 级违规数：这是「算不算合这个平台」的判据 */
  badCount: number;
  ok: boolean;
  /** 能靠「改一遍」修好的那些（见 REPAIR_EXEMPT_CODES） */
  repairable: FormatViolation[];
  /** repairable 里的 bad 数：决定要不要为它再花一次额度 */
  repairBadCount: number;
};

/**
 * **不该触发改写**的违规码。
 *
 * 「正文比这个平台常见的字数偏短」是真问题，但它的修法只有一种——**再写出点东西来**，
 * 而这一道的第一条纪律是「信息一个不许加」。把它丢给修复轮，等于亲手要求模型编内容，
 * 然后再被 checkFactDrift 判掉，白烧一次额度。所以它只报给用户看（UI 与 note），
 * 不进修复提示词、也不算「需要再调一次模型」的理由。
 */
export const REPAIR_EXEMPT_CODES = new Set(['chars_short']);

const HASHTAG_RE = /#[^#\s]{1,20}#?/g;

/** 正文字数：不含空白（与工坊字数统计同口径） */
function bodyChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

function splitTitleAndBody(text: string, f: PlatformFormat): { title: string; body: string } {
  if (!f.title) return { title: '', body: text };
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim();
  return { title: first, body: lines.slice(1).join('\n').trim() };
}

/**
 * 标题行「像不像标题」：太长的一段话不是标题，是正文被误当成了标题。
 *
 * ⚠️ 判据只有两条——**长度**和**有没有句号**。别拿「句中有没有感叹号」当判据：
 * 小红书标题「1.2 元睡 2.5 小时！午休影城太会玩了」正是这种写法，按那条判会被
 * 判成「第一行不是标题」，然后修复那一次就去改一个本来就对的标题。
 */
function looksLikeTitle(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.length > 45) return false;
  return !/[。；]/.test(t); // 标题里出现句号/分号 = 这是正文
}

/**
 * 量这篇稿子合不合目标平台的形。
 *
 * 只看**可判定**的维度：标题行、字数、段长、emoji、排版记号、话题标签、语言、thread 条数。
 * 「调性对不对」不在这里判——那是人味体检与人设那一侧的事。
 */
export function checkPlatformFit(text: string, platform: string): FormatFitReport {
  const raw = (text ?? '').trim();
  const f = platformFormat(platform);
  const name = platformName(platform);
  const v: FormatViolation[] = [];
  const push = (code: string, severity: FitSeverity, finding: string, fix: string) => v.push({ code, severity, finding, fix });

  if (!raw) {
    const empty: FormatViolation[] = [{ code: 'empty', severity: 'bad', finding: '正文是空的', fix: '写出正文。' }];
    return { platform, violations: empty, badCount: 1, ok: false, repairable: [], repairBadCount: 0 };
  }

  const { title, body } = splitTitleAndBody(raw, f);
  const lines = raw.split('\n');

  // ── 标题行 ──
  if (f.title) {
    const rule = titleLengthRule(platform);
    if (!title) {
      push('title_missing', 'bad', `${name}要第一行给标题，现在没有`, `第一行补一个 ${rule.min}-${rule.max} 字的标题，${rule.note}；标题下面空一行再写正文。`);
    } else if (!looksLikeTitle(title)) {
      push('title_missing', 'bad', '第一行不是标题，是一整段正文', `把第一行改成 ${rule.min}-${rule.max} 字的标题，正文另起一段。`);
    } else {
      if (rule.hardMax && title.length > rule.hardMax) {
        push('title_long', 'bad', `标题 ${title.length} 字，超过${name}的 ${rule.hardMax} 字上限会被截断`, `把标题压到 ${rule.max} 字以内，最重要的信息放前 ${Math.min(rule.max, 15)} 个字。`);
      } else if (title.length > rule.max) {
        push('title_long', 'warn', `标题 ${title.length} 字，比${name}常见的 ${rule.max} 字长`, `压到 ${rule.max} 字以内。`);
      } else if (title.length < rule.min) {
        push('title_short', 'warn', `标题只有 ${title.length} 字，信息不够`, `补到 ${rule.min} 字以上，${rule.note}。`);
      }
      if (/^#{1,6}\s|^\*\*|[《》]|^标题[:：]/.test(title)) {
        push('title_decorated', 'bad', '标题带了 #、**、书名号或「标题：」这类记号', '标题就是一行纯文字，把这些记号全去掉。');
      }
    }
  } else {
    const first = (lines[0] ?? '').trim();
    if (/^#{1,6}\s/.test(first) || /^【[^】]{1,40}】$/.test(first) || /^标题[:：]/.test(first)) {
      push('title_unexpected', 'bad', `${name}不写标题行，现在第一行是个标题`, '删掉标题行，第一句直接是正文（标题/文案在发布时另填）。');
    }
  }

  // ── 正文字数 ──
  const chars = bodyChars(body || raw);
  const [lo, hi] = f.chars;
  if (chars < lo) {
    push('chars_short', chars < lo * 0.7 ? 'bad' : 'warn', `正文 ${chars} 字，比${name}常见的 ${lo}-${hi} 字偏短`, `扩到 ${lo} 字以上：补的是具体的事实和场景，不是把话说两遍。`);
  } else if (chars > hi) {
    push('chars_long', chars > hi * 1.4 ? 'bad' : 'warn', `正文 ${chars} 字，比${name}常见的 ${lo}-${hi} 字偏长`, `压到 ${hi} 字以内：砍掉重复的论证和过渡句，留最有信息量的部分。`);
  }

  // ── 单段长度 ──
  const paragraphs = (body || raw).split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  const longParas = paragraphs.filter((p) => p.replace(/\s/g, '').length > f.paraMax * 1.3);
  if (longParas.length > 0) {
    push('para_long', 'warn', `有 ${longParas.length} 段超过 ${f.paraMax} 字（最长 ${Math.max(...longParas.map((p) => p.length))} 字）`, `把超长的段落拆开，每段不超过 ${f.paraMax} 字；${name}上一段就是一个气口。`);
  }

  // ── emoji ──
  if (f.emoji === 'none' && hasEmoji(raw)) {
    push('emoji_banned', 'bad', `${name}的稿子不该出现 emoji`, '把所有 emoji 删掉。');
  } else if (f.emoji === 'sparse') {
    const emojiCount = [...raw].filter((ch) => hasEmoji(ch)).length;
    if (emojiCount > Math.max(6, paragraphs.length)) {
      push('emoji_heavy', 'warn', `全篇 ${emojiCount} 个 emoji，超过段落数`, '一段最多留一个，只留在真有情绪的地方。');
    }
  }

  // ── 排版记号 / 栏目名 ──
  const mdLines = lines.filter((l) => /^\s*#{1,6}\s+\S/.test(l) || /^\s*([-*_]\s*){3,}$/.test(l)).length;
  if (mdLines > 0 || /\*\*[^\n*]+\*\*/.test(raw)) {
    push('markdown_left', 'bad', '正文里有 markdown 记号（#、**、---）', `${name}的编辑器不认这些符号，会原样显示出来——全部去掉。`);
  }
  // 与 structure.ts 同口径：第一行是标题，不按栏目算
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  // emoji 前缀要一起认：模型最常写的正是「📌【目标客群】」这种带图标的栏目行
  const sectionLines = lines.filter(
    (l, i) => i !== firstIdx && /^\s*(?:#{1,6}\s*)?(?:\p{Extended_Pictographic}\uFE0F?\s*)*【[^】\n]{1,40}】\s*[:：]?\s*$/u.test(l),
  ).length;
  if (sectionLines > 0) {
    push('section_label', 'bad', `有 ${sectionLines} 行是「【栏目名】」式小标题`, '删掉栏目名，让内容连着说下去。');
  }
  if (!f.headings && mdLines === 0) {
    // 允许小标题的平台不判；不允许的平台再看有没有「伪小标题」（独占一行、很短、不带句号）
    const pseudo = paragraphs.filter((p) => p.length <= 14 && !/[。！？!?，,、]$/.test(p) && !/^#/.test(p)).length;
    if (pseudo >= 3) {
      push('pseudo_heading', 'warn', `有 ${pseudo} 行短句像小标题`, `${name}不用小标题，把它们并进后面的段落里说。`);
    }
  }

  // ── 话题标签 ──
  const tags = raw.match(HASHTAG_RE) ?? [];
  const wantTags = /(\d+)\s*-\s*(\d+)\s*个/.exec(f.hashtags) ?? /(\d+)\s*-\s*(\d+)/.exec(f.hashtags);
  if (f.hashtags) {
    const min = wantTags ? Number(wantTags[1]) : 1;
    const max = wantTags ? Number(wantTags[2]) : 5;
    if (tags.length < min) {
      push('hashtag_missing', 'warn', `只有 ${tags.length} 个话题标签，${name}一般放 ${min}-${max} 个`, `结尾另起一行补到 ${min}-${max} 个话题标签，用空格分开；标签要贴着正文的内容，不要堆通用大词。`);
    } else if (tags.length > max + 2) {
      push('hashtag_many', 'warn', `${tags.length} 个话题标签，太多了`, `留最相关的 ${max} 个。`);
    }
  } else if (tags.length > 0) {
    push('hashtag_unexpected', 'warn', `${name}不写话题标签，正文里有 ${tags.length} 个`, '把话题标签删掉。');
  }

  // ── 语言 ──
  if (f.language === '英文') {
    const cjk = (raw.match(/[一-龥]/g) ?? []).length;
    if (cjk > raw.length * 0.1) {
      push('language_mismatch', 'bad', `${name}要用英文写，现在有 ${cjk} 个汉字`, '整篇改写成英文。');
    }
  }

  // ── thread 分条（X）──
  if (platform === 'x') {
    const parts = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const over = parts.filter((p) => p.length > 280).length;
    if (over > 0) {
      push('thread_split', 'bad', `有 ${over} 条超过 280 字符`, '拆成多条，每条各自成立、用空行分开，最多 6 条。');
    }
    if (parts.length > 6) {
      push('thread_long', 'warn', `${parts.length} 条，太长了`, '压到 6 条以内。');
    }
  }

  const badCount = v.filter((x) => x.severity === 'bad').length;
  const repairable = v.filter((x) => !REPAIR_EXEMPT_CODES.has(x.code));
  return {
    platform, violations: v, badCount, ok: v.length === 0,
    repairable, repairBadCount: repairable.filter((x) => x.severity === 'bad').length,
  };
}

/**
 * 给模型的问题清单（只列**能靠改写修好**的违规项；没有就返回空串，整块不进 prompt）。
 * 「字数偏短」这类不进来，理由见 REPAIR_EXEMPT_CODES。
 */
export function formatProblemBlock(report: FormatFitReport): string {
  if (report.repairable.length === 0) return '';
  return [
    `【这篇稿子不合${platformName(report.platform)}的地方（逐条改掉，别动没被点名的句子）】`,
    ...report.repairable.map((x) => `- ${x.finding} → ${x.fix}`),
  ].join('\n');
}

/** 一句话摘要，给 UI 与 note 用 */
export function fitSummary(report: FormatFitReport): string {
  if (report.violations.length === 0) return `符合${platformName(report.platform)}的格式`;
  const bad = report.violations.filter((x) => x.severity === 'bad').length;
  const warn = report.violations.length - bad;
  const parts = [bad ? `${bad} 处硬伤` : '', warn ? `${warn} 处偏差` : ''].filter(Boolean);
  return `不合${platformName(report.platform)}：${parts.join(' + ')}`;
}
