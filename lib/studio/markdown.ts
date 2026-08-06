// 轻结构 Markdown（markdown-lite）。
//
// 【为什么是 markdown 而不是富文本编辑器】草稿正文必须保持**纯文本**：
// 合规命中靠字符偏移高亮、算法教练/人味体检算句长方差与段落数、去 AI 味比对原句样本、
// 版本 diff 学偏好、docx/pptx 导出校验 AIGC 标识——这些全部建立在「content 是一段纯文本」上。
// 存 HTML 意味着以上每一处都要先 html→text 再算（偏移对不上），或者全部重写。
// markdown 记号本身就是普通字符，存进去什么都不用改，只在**出口**（预览 / 复制富文本）才渲染成 HTML。
//
// 【为什么按平台开关】记号只对文章型平台有意义。抖音口播稿里的 `**` 粘出去就是两个星号，
// 小红书的编辑器也不认——给这些平台开 markdown 是在制造脏字符。

/**
 * 支持轻结构的平台。
 * 口径 = PLATFORMS 里 kind 为 'article' 的那些（当前只有公众号）。
 * 硬编码平台 key 而不是读 kind：这张表表达的是「这个平台的编辑器认不认排版」，
 * 和内容形态（短视频/图文/长文）不是同一件事，将来可能分叉。
 */
const MARKDOWN_PLATFORMS = new Set<string>(['wechat']);

export function supportsMarkdown(platform: string | undefined | null): boolean {
  return !!platform && MARKDOWN_PLATFORMS.has(platform);
}

/** 正文里有没有轻结构记号。用来在不支持的平台上提醒「这些符号会被原样发出去」。 */
export function hasMarkdownMarkers(text: string): boolean {
  const body = text ?? '';
  if (/\*\*[^\n*]+\*\*/.test(body)) return true;
  return body.split('\n').some((line) => /^\s*(#{2,3}\s+\S|[-*]\s+\S|>\s*\S|\d+[.)]\s+\S)/.test(line));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 行内记号：**先转义再套标签**。转义之后正文里已经不可能存在 < >，
// 后面插入的每一个尖括号都是本函数自己生成的——这条顺序就是这个渲染器的全部安全性来源，
// 不要为了「支持一点内联 HTML」把它倒过来。
function inline(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * markdown-lite → HTML。只认 5 种记号：## / ### 小标题、**加粗**、- 无序列表、
 * 1. 有序列表、> 引用；空行分段，其余按段落。
 * 产出**由构造保证安全**（见 inline 的注释），可直接进预览与剪贴板富文本。
 */
export function mdLiteToHtml(text: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }

    const h = /^(#{2,3})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }

    const q = /^>\s*(.+)$/.exec(line);
    if (q) {
      closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }

    const ul = /^[-*]\s+(.+)$/.exec(line);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = /^\d+[.)]\s+(.+)$/.exec(line);
    if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  return out.join('');
}

/**
 * markdown-lite → 纯文本（剪贴板的 text/plain 分支、以及给不支持排版的地方用）。
 * 只是把记号剥掉，不做任何重排——剥完还是同一段话。
 */
export function mdLiteToPlain(text: string): string {
  return (text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(#{2,3})\s+/, '')
        .replace(/^\s*>\s*/, '')
        .replace(/^\s*[-*]\s+/, '· ')
        .replace(/^\s*(\d+)[.)]\s+/, '$1. ')
        .replace(/\*\*(.+?)\*\*/g, '$1'),
    )
    .join('\n');
}
