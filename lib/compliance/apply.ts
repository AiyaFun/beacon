// 合规命中的「一键改掉」（2026-09-17，用户：「合规命中部分，可以点检一键修改」）。
//
// ─────────────── 为什么不能用 replaceAll ───────────────
// 合规中心原来的「使用建议」按钮写的是 `text.replaceAll(h.word, rep)`。两个问题：
//   ① **改到了别处**：文中三处「第一」，用户点的是第二处，三处一起被换掉；
//   ② **偏移全错**：命中项的 start/end 是按旧文本算的，一次 replaceAll 之后，
//      其余每一条的位置都对不上了，再点第二条就会切到别的字上。
// 所以这里一律**按位置**替换，并且在动手之前先核一遍 `text.slice(start,end) === word`——
// 对不上就说明这份报告已经过期（用户手改过正文），宁可跳过也不能瞎切。
//
// 「全部替换」从后往前做：先改后面的，前面的偏移才不会被动过。

// ─────────────── 词库里的「建议」不都是能直接替进去的词 ───────────────
// 全库 427 条 suggestion 一律写成括号形式，而括号里装的是两类东西：
//   · **能直接替**：（私信我）（知名品牌）（定制款）（已通过质检）
//   · **只是说明**：（更优选择之一 / 建议）（已获得 XX 认证，注明具体机构）（可能有助于缓解，具体请遵医嘱）
// 第二类硬替进去会写出病句：「这款面膜效果（更优选择之一 / 建议）」。
// 所以一键替换只认第一类，第二类照旧显示成建议文字、让用户自己改（或交给 AI 安全改写整段）。
// 判据：带「/」的是在给你几个选项、带 XX/注明/请/具体 的是在给你做法说明——两者都不是替换词。
const ADVICE_MARKERS = /[/／]|XX|注明|请|具体|遵医嘱|口径/;

/** 括号壳脱掉、尾部补充说明去掉；判不出是替换词就返回 null（不给一键替换的按钮） */
export function normalizeSuggestion(raw?: string | null): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  if ((s.startsWith('（') && s.endsWith('）')) || (s.startsWith('(') && s.endsWith(')'))) s = s.slice(1, -1).trim();
  // 「加入粉丝群（站内）」→「加入粉丝群」：尾括号是补充说明，不该念进正文
  s = s.replace(/[（(][^（()）]*[）)]\s*$/, '').trim();
  if (!s || s.length > 14) return null;
  if (ADVICE_MARKERS.test(s)) return null;
  return s;
}

export type ApplicableHit = {
  word: string;
  start: number;
  end: number;
  suggestion?: string;
  action?: string;
};

/** 这一条能不能一键改：建议是个能直接替进去的词、位置对得上 */
export function canApply(text: string, hit: ApplicableHit): boolean {
  const rep = normalizeSuggestion(hit.suggestion);
  if (!rep || rep === hit.word) return false;
  if (hit.start < 0 || hit.end > text.length || hit.start >= hit.end) return false;
  return text.slice(hit.start, hit.end) === hit.word;
}

/** 改一处。位置对不上就原样返回（报告过期，见文件头）。 */
export function applyHit(text: string, hit: ApplicableHit): string {
  if (!canApply(text, hit)) return text;
  return text.slice(0, hit.start) + normalizeSuggestion(hit.suggestion) + text.slice(hit.end);
}

export type ApplyAllResult = {
  text: string;
  /** 改掉了几处 */
  applied: number;
  /** 跳过几处（没有建议 / 位置对不上 / 与已改的重叠） */
  skipped: number;
  /** 跳过的词，给用户看「这几处得自己改」 */
  skippedWords: string[];
};

/**
 * 把所有**给得出建议**的命中一次改掉。没有建议的（多数法律级红线只说「不能用」，
 * 给不出替代说法）原样留着——产品不替用户编一个合规的说法，那是在替他承担风险。
 */
export function applyAllHits(text: string, hits: ApplicableHit[]): ApplyAllResult {
  const sorted = [...hits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let applied = 0;
  const skippedWords: string[] = [];
  let lastStart = Number.POSITIVE_INFINITY; // 从后往前：下一条的 end 必须 ≤ 上一条的 start
  for (const h of sorted) {
    if (h.end > lastStart) { skippedWords.push(h.word); continue; } // 与已改的那处重叠
    if (!canApply(out, h)) { skippedWords.push(h.word); continue; }
    out = applyHit(out, h);
    applied += 1;
    lastStart = h.start;
  }
  return { text: out, applied, skipped: skippedWords.length, skippedWords: [...new Set(skippedWords)] };
}

/** 语义命中没有位置，只有片段：改第一处出现的地方。 */
export function applySnippet(text: string, snippet: string, suggestion: string): string {
  const s = (snippet ?? '').trim();
  const rep = normalizeSuggestion(suggestion) ?? '';
  if (!s || !rep) return text;
  const i = text.indexOf(s);
  if (i < 0) return text;
  return text.slice(0, i) + rep + text.slice(i + s.length);
}
