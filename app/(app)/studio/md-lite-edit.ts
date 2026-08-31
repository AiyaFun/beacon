// 编辑器工具条的选区计算（纯函数，2026-08-30 从 Rewriter.tsx 抽出来）。
//
// ── 为什么要抽 ──
// 原来这两个函数是 Rewriter() 里的闭包（那个函数 802 行），直接读写 textarea 的
// selectionStart/selectionEnd。**闭包里的偏移计算测不了**，而本项目对编辑器的
// 契约恰恰是「一切建在纯文本的偏移上」（见「编辑器坚持纯文本的契约」那次定案），
// 偏移算错不会报错，只会表现为「光标莫名其妙跑了」。
//
// 抽出来之后组件那边只剩三件事：读选区 → 调这里 → 把结果写回去。

export type EditResult = { value: string; selStart: number; selEnd: number };

/**
 * 给选中的整行（或光标所在行）加前缀，如 `- ` / `> `。
 *
 * ── 修掉的缺陷（2026-08-30）──
 * 原来收尾是这么写的：
 *
 *     ta.setSelectionRange(s + prefix.length, e + delta);
 *
 * 起点**无条件**加了 prefix.length —— 可是首行如果本来就有这个前缀，
 * 它压根没被改动。举例：`- 甲\n乙`，光标在「甲」上（位置 2），再按一次项目符号：
 * 首行不变所以 delta=0，于是 setSelectionRange(4, 2) —— **起点大于终点**。
 * 浏览器把它塌成 4，光标从「甲」上跳到了换行符之后，也就是下一行去了。
 *
 * 现在起点按**首行实际加了多少**来移，并且钉死 selStart ≤ selEnd。
 *
 * 【顺带记一笔，没改】这个函数只加不删：已经有前缀的行再按一次什么也不会发生。
 * 常见的工具条是切换（再按一次去掉）。那是产品口径，不在这次修复范围内。
 */
/**
 * 块级行标记。**一行只能有一个**——这是 markdown-lite 的语法，也是这里换标记的依据。
 *
 * 【必须和渲染器认得的保持一致】这几条正则是照着 lib/studio/markdown.ts 的
 * mdLiteToHtml 抄的（小标题 `#{2,3}\s+`、无序 `[-*]\s+`、有序 `\d+[.)]\s+`、引用 `>\s*`）。
 * 对不上的后果是「工具条以为换掉了、渲染器仍按老标记解析」，
 * tests/studio/md-lite-edit.test.ts 里有一条守卫拿真实渲染结果比对。
 */
const BLOCK_MARK = /^(?:#{2,3}\s+|[-*]\s+|\d+[.)]\s+|>\s*)/;

/**
 * 给选中的整行（或光标所在行）换上块级前缀，如 `- ` / `## ` / `> `。
 *
 * ── 修掉的缺陷之一：起点无条件位移（2026-08-30）──
 * 原来收尾是 `setSelectionRange(s + prefix.length, e + delta)`，起点**无条件**加
 * prefix.length，可首行本来就有这个前缀时它压根没动。`- 甲\n乙` 光标在位置 2 再按一次 →
 * (4, 2) **起点大于终点**，浏览器塌成 4，光标跳到了下一行。
 * 现在起点按首行**实际**变化了多少来移，并钉死 selStart ≤ selEnd。
 *
 * ── 修掉的缺陷之二：只判「有没有一模一样的前缀」（2026-08-30）──
 * 原来是 `l.startsWith(prefix) ? l : prefix + l`。于是在 AI 稿里极常见的这几行上：
 *   · `### 三级标题` 点「小标题」→ `## ### 三级标题` → 渲染成 `<h2>### 三级标题</h2>`
 *   · `* 文字` 点「列表」→ `- * 文字` → `<li>* 文字</li>`
 *   · `1. 文字` 点「列表」→ `- 1. 文字` → `<li>1. 文字</li>`
 * 标记被当成正文显示出来了。根因是**块级标记一行只能有一个**，加之前得先把旧的摘掉。
 */
export function applyLinePrefix(text: string, s: number, e: number, prefix: string): EditResult {
  // 【为什么要夹 s-1 ≥ 0】lastIndexOf 的 fromIndex 传负数会被当成 0，
  // 于是「光标在开头、且正文以换行开头」时会返回 0，行首被算成 1 —— 差一格。
  const lineStart = s > 0 ? text.lastIndexOf('\n', s - 1) + 1 : 0;
  const nl = text.indexOf('\n', e);
  const lineEnd = nl === -1 ? text.length : nl;

  const lines = text.slice(lineStart, lineEnd).split('\n');
  // 【空行只在跨行选中时跳过】选了一大段时，中间的空行不该都变成 `- `（那是段落分隔）；
  // 但光标单独停在一个空行上点「列表」，就该起一个空列表项让他接着打字——所有编辑器都这样。
  const multi = lines.length > 1;
  const marked = lines.map((l) => (!multi || l.trim() ? prefix + l.replace(BLOCK_MARK, '') : l));
  const block = lines.join('\n');
  const next = marked.join('\n');

  // 首行到底变了多少（换标记时可能是**负数**，比如 `### ` 换成 `## `），决定起点怎么挪
  const headDelta = marked[0].length - lines[0].length;
  const delta = next.length - block.length;
  // 夹在行首之后：headDelta 为负时可能把起点推到上一行去
  const selStart = Math.max(lineStart, s + headDelta);
  return {
    value: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selStart,
    selEnd: Math.max(selStart, e + delta),
  };
}

/** 用记号包住选区（`**加粗**`）。没选中就插入一对记号并把光标放中间。 */
export function wrapSelection(text: string, s: number, e: number, mark: string): EditResult {
  const picked = text.slice(s, e);
  return {
    value: `${text.slice(0, s)}${mark}${picked}${mark}${text.slice(e)}`,
    selStart: s + mark.length,
    selEnd: s + mark.length + picked.length,
  };
}
