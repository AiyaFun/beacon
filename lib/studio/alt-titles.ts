// 从技能产出里把「备选标题：」那一块解析出来。
//
// 【为什么要有】xhs-format 的模板明确要求「最后以『备选标题：』开头另起三行，给 3 个备选标题」，
// 模型也照做了——但产出是一整块纯文本，用户想用其中一条只能自己选中、复制、再粘到别处。
// 明明已经生成好的三条标题，因为没被解析出来就等于没有。
//
// 口径刻意保守：只认「备选标题」这个显式小标题之后的行，且只取像标题的行（去掉编号/引号后
// 非空、不超过 40 字、不含冒号结尾这类小标题特征）。宁可少认，不要把正文最后几行错当标题。

const HEAD_RE = /^[\s\-*>#]*备选标题[：:]\s*$/;
/** 「备选标题：xxx」同一行也给一条的写法 */
const HEAD_INLINE_RE = /^[\s\-*>#]*备选标题[：:]\s*(.+)$/;
/** 行首的编号 / 项目符号 / 引号 */
const BULLET_RE = /^[\s]*(?:[-*·•]|\(?\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/;
const QUOTE_RE = /^["'「『“”]+|["'」』“”]+$/g;

const MAX_TITLE_CHARS = 40;
const MAX_TITLES = 5;

function clean(raw: string): string {
  return raw.replace(BULLET_RE, '').replace(QUOTE_RE, '').trim();
}

function looksLikeTitle(line: string): boolean {
  if (!line) return false;
  if ([...line].length > MAX_TITLE_CHARS) return false;
  if (/[：:]\s*$/.test(line)) return false; // 「标签：」这类小标题
  if (/^#/.test(line)) return false; // 话题标签行
  return true;
}

/**
 * 返回解析到的备选标题（0-5 条）。没有「备选标题」这个小标题就返回空数组——
 * 不去猜「最后三行大概是标题吧」，猜错会给用户一个把正文当标题用的按钮。
 */
export function parseAltTitles(output: string): string[] {
  const lines = (output ?? '').split('\n');
  const out: string[] = [];
  let started = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!started) {
      if (HEAD_RE.test(line)) {
        started = true;
        continue;
      }
      const inline = HEAD_INLINE_RE.exec(line);
      if (inline) {
        started = true;
        const first = clean(inline[1]);
        if (looksLikeTitle(first)) out.push(first);
      }
      continue;
    }
    if (!line) {
      // 空行：已经收到过标题就当块结束；还没收到就继续找（模型有时会先空一行）
      if (out.length > 0) break;
      continue;
    }
    const c = clean(line);
    if (!looksLikeTitle(c)) break;
    out.push(c);
    if (out.length >= MAX_TITLES) break;
  }

  // 去重后返回（模型偶尔会把同一条写两遍）
  return [...new Set(out)];
}
