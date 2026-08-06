// 版本对比：句级 diff。
//
// 【为什么按句而不是按字或按行】按字 diff 中文会碎成一地单字，看不出改了什么；
// 按行又太粗——一段话改了三个字，整段都标成「删了又加」。按句切正好是人读稿子的粒度：
// 「这句没动 / 这句换了说法 / 这句是新加的」。
//
// 纯函数、零依赖，服务端与浏览器都能跑（当前在浏览器里算，正文已经随页面下发过一次了）。

export type DiffOp = { type: 'same' | 'add' | 'del'; text: string };

// 句末标点 + 换行都算切点。换行单独成段是有意的：空行（段落分隔）会成为一个独立 token，
// 于是「只是多空了一行」不会被算成整段重写。
const BREAKS = '。！？!?；;\n';

export function splitForDiff(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of text ?? '') {
    buf += ch;
    if (BREAKS.includes(ch)) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

// LCS 表是 O(n·m)。稿子再长也就几百句，但版本里混进整篇日志之类的东西时得有个闸——
// 超限直接退化成「整篇替换」，是难看但正确的结果，好过把页面卡死。
const MAX_TOKENS = 1500;

export function diffSentences(before: string, after: string): DiffOp[] {
  const A = splitForDiff(before);
  const B = splitForDiff(after);
  if (A.length === 0 && B.length === 0) return [];
  if (A.length > MAX_TOKENS || B.length > MAX_TOKENS) {
    const ops: DiffOp[] = [];
    if (before) ops.push({ type: 'del', text: before });
    if (after) ops.push({ type: 'add', text: after });
    return ops;
  }

  const n = A.length;
  const m = B.length;
  // dp[i][j] = A[i..] 与 B[j..] 的最长公共子序列长度。用扁平 TypedArray 省内存与 GC。
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = A[i] === B[j]
        ? dp[at(i + 1, j + 1)] + 1
        : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const ops: DiffOp[] = [];
  // 相邻同类合并：不合并的话「删三句加三句」会渲染成六个色块，读起来比原文还累
  const push = (type: DiffOp['type'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]);
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      push('del', A[i]);
      i++;
    } else {
      push('add', B[j]);
      j++;
    }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('add', B[j++]);
  return ops;
}

export type DiffStats = { added: number; removed: number; kept: number; changedRatio: number };

/** 按**字符数**统计，不是按句数：改动量用字数说话才有体感（「动了 3 句」可能是 3 个字也可能是 300 字）。 */
export function diffStats(ops: DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  let kept = 0;
  for (const op of ops) {
    const n = op.text.replace(/\s/g, '').length;
    if (op.type === 'add') added += n;
    else if (op.type === 'del') removed += n;
    else kept += n;
  }
  const base = kept + removed;
  return {
    added,
    removed,
    kept,
    changedRatio: base > 0 ? Math.round(((added + removed) / (base + added)) * 100) : added > 0 ? 100 : 0,
  };
}
