// HTML → 文章正文与元信息（纯函数，零依赖，可单测）。
//
// 【为什么不用 htmlToText】那个是「把所有标签抹平成一行」，用于给 LLM 一坨文本。
// 剪藏要的是**正文**：导航、侧栏、页脚、推荐位、评论区都不能算进去，否则
//   · 摘要会去总结「关注我们 / 相关阅读 / 版权声明」；
//   · 段落结构全丢，AI 拆要点时看不出层次。
//
// 【取正文的三级策略】
//   ① 站点专属容器（公众号 #js_content 这类）——最准，命中即用；
//   ② 语义容器（<article> / <main> / [role=main]）；
//   ③ 兜底：去掉噪声标签后取**文本量最大的那个 <div>**（正文通常就是页面上最长的一块）。
// 三级都拿不到就返回空，让调用方明说「没解析出正文」，而不是把导航栏当文章存下来。

export type ExtractedArticle = {
  title: string;
  author: string;
  siteName: string;
  publishedAt: string; // 原样字符串，解析不出就空
  text: string; // 保留段落换行的正文
  chars: number;
};

// 整块删掉（连内容一起）的噪声标签
const DROP_BLOCKS = ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'svg', 'button', 'select'];

// 站点专属正文容器：命中即认。key 只用于注释可读性。
const SITE_CONTAINERS: { name: string; re: RegExp }[] = [
  // 微信公众号：正文恒在 #js_content。这是本项目最常见的来源，单独排第一位。
  { name: 'wechat', re: /<div[^>]*id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div[^>]*id=["']js_(?:pc_qr_code|profile)|$)/i },
  { name: 'zhihu', re: /<div[^>]*class=["'][^"']*RichText[^"']*["'][^>]*>([\s\S]*)<\/div>/i },
  { name: 'generic-article-body', re: /<div[^>]*class=["'][^"']*(?:article-content|post-content|entry-content|article_content|content-article)[^"']*["'][^>]*>([\s\S]*)<\/div>/i },
];

const SEMANTIC = [
  /<article[^>]*>([\s\S]*?)<\/article>/i,
  /<main[^>]*>([\s\S]*?)<\/main>/i,
  /<div[^>]*role=["']main["'][^>]*>([\s\S]*)<\/div>/i,
];

function stripNoise(html: string): string {
  let out = html;
  for (const tag of DROP_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    out = out.replace(new RegExp(`<${tag}[^>]*/?>`, 'gi'), ' ');
  }
  return out;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&'); // 放最后，否则 &amp;lt; 会被二次解码
}

/** 块级标签转换成换行，保住段落结构（摘要与要点全靠它看层次）。 */
function blocksToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote|figcaption)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '· ')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function metaContent(html: string, keys: string[]): string {
  for (const k of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i');
    const m = re.exec(html);
    if (m?.[1]?.trim()) return decodeEntities(m[1].trim());
    // content 在前、property 在后的写法也认
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, 'i');
    const m2 = re2.exec(html);
    if (m2?.[1]?.trim()) return decodeEntities(m2[1].trim());
  }
  return '';
}

/** 兜底：噪声清干净后，取文本量最大的 div —— 正文通常就是页面上最长的那一块。 */
function biggestBlock(html: string): string {
  let best = '';
  let bestLen = 0;
  const re = /<div[^>]*>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = blocksToText(m[1]);
    if (t.length > bestLen) {
      bestLen = t.length;
      best = m[1];
    }
  }
  return bestLen > 0 ? best : '';
}

export function extractArticle(html: string, opts: { maxChars?: number } = {}): ExtractedArticle {
  const maxChars = opts.maxChars ?? 20_000;

  const title =
    metaContent(html, ['og:title', 'twitter:title']) ||
    decodeEntities((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '')).trim() ||
    decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')).trim();

  const author =
    metaContent(html, ['author', 'article:author', 'og:article:author']) ||
    // 公众号：作者名在 #js_name（号名）或 rich_media_meta_nickname
    decodeEntities((/<a[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '')).trim();

  const siteName = metaContent(html, ['og:site_name', 'application-name']);
  const publishedAt = metaContent(html, ['article:published_time', 'og:article:published_time', 'pubdate', 'publishdate']);

  // 正文：三级策略，逐级降级。**信任度随策略递减**——
  // 站点专属容器命中就照单全收：一篇 60 字的短文也是正文，不能因为「短」就退回整页，
  // 那样换来的是把导航、二维码、版权声明一起当成文章存下来（更糟，且用户看不出来）。
  const cleaned = stripNoise(html);
  let body = '';
  let strategy: 'site' | 'semantic' | 'biggest' | 'none' = 'none';
  for (const c of SITE_CONTAINERS) {
    const m = c.re.exec(cleaned);
    if (m?.[1] && blocksToText(m[1]).length > 0) { body = m[1]; strategy = 'site'; break; }
  }
  if (!body) {
    for (const re of SEMANTIC) {
      const m = re.exec(cleaned);
      if (m?.[1] && blocksToText(m[1]).length > 40) { body = m[1]; strategy = 'semantic'; break; }
    }
  }
  if (!body) {
    body = biggestBlock(cleaned);
    if (body) strategy = 'biggest';
  }

  let text = blocksToText(body);
  // 只有最不可信的那一级（挑最大块）才允许退回整页：那一级本来就是猜的，猜出个空壳没意义
  if (strategy !== 'site' && text.length < 120) {
    const whole = blocksToText(cleaned);
    if (whole.length > text.length) text = whole;
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（原文过长，已截断）`;

  return {
    title: title.slice(0, 200),
    author: author.slice(0, 80),
    siteName: siteName.slice(0, 80),
    publishedAt: publishedAt.slice(0, 40),
    text,
    chars: text.length,
  };
}
