// 源码锚点工具（2026-08-30）。
//
// ── 为什么需要它 ──
// 这个项目里大量守卫是「读源码文本、在某个锚点附近断言」。写法一直是：
//
//     const i = src.indexOf("name: 'run_shell',");
//     expect(src.slice(Math.max(0, i - 300), i)).toContain('write: true');
//
// **锚点找不到时 `indexOf` 返回 -1**，于是 `Math.max(0, -301)` = 0，
// `slice(0, -1)` = **整个文件少一个字符** —— 里面当然有 `write: true`。**绿。**
//
// 也就是说：这道守卫在它最该报警的那一刻（工具被删了 / 改名了 / 搬走了）
// 反而变绿。这是本项目「假绿的第八种形状」，2026-08-30 拆 tools.ts 时
// 被搬家当场撞出来（run_shell 搬到 tools-local.ts，这条守卫一声不吭）。
//
// ── 解法：让 -1 在结构上不可能出现 ──
// 下面这几个函数找不到锚点就**抛**，错误信息里带上锚点原文。
// 断言写在哪一段上，就用哪个函数，不要再自己算下标。

/** 锚点位置。找不到就抛——不返回 -1。 */
export function at(src: string, needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i < 0) {
    throw new Error(
      `锚点没找到：${JSON.stringify(needle)}。\n`
      + '要么它被改名/删了/搬到别的文件去了（那正是这道守卫该报的事），'
      + '要么这条断言该跟着改。**不要**把它退回 indexOf —— -1 会切出整个文件，让守卫恒绿。',
    );
  }
  return i;
}

/** 锚点**前面**那一段。用于「这一行上方 N 个字符里必须有 X」。 */
export function before(src: string, needle: string, chars = 300): string {
  const i = at(src, needle);
  return src.slice(Math.max(0, i - chars), i);
}

/** 锚点**后面**那一段（含锚点本身）。 */
export function after(src: string, needle: string, chars = 300): string {
  const i = at(src, needle);
  return src.slice(i, i + chars);
}

/**
 * 两个锚点**之间**那一段。
 *
 * 【end 从 start **结束之后**开始找，不是从 start 开头】
 * 2026-08-30 踩到：`between(src, 'export async function actBackfill', 'export async function')`
 * 从起点下标开始找终点，而 `export async function` 恰好是起点串的前缀——
 * 在起点处就匹配上了，切出**空串**。空串让后面每一条 toContain 都红，
 * 报的却是「代码里没有这个」，而真相是「切错了」。
 * 从 `i + start.length` 开始找，这类前缀重叠就不可能发生。
 */
export function between(src: string, start: string, end: string): string {
  const i = at(src, start);
  const j = at(src, end, i + start.length);
  return src.slice(i, j);
}

/**
 * 断言 a 出现在 b **之前**。
 *
 * 【为什么不直接 expect(i).toBeLessThan(j)】两个锚点都没找到时 i 和 j 都是 -1，
 * `-1 < -1` 是 false 所以这条会红——但**理由完全是错的**，
 * 报出来的是「顺序不对」，而真相是「这两段代码都不在了」。
 * 走 at() 抛出的信息里有锚点原文，一眼看得出是哪一个没了。
 */
export function orderedBefore(src: string, first: string, second: string): void {
  const i = at(src, first);
  const j = at(src, second);
  if (i >= j) {
    throw new Error(
      `顺序反了：${JSON.stringify(first)} 应该出现在 ${JSON.stringify(second)} 之前，实际在之后。`,
    );
  }
}
