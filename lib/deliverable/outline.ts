// 交付物大纲：把一篇成稿变成「按页组织的结构」。
//
// 这是「技能本地化」的规划半边（渲染半边见 pptx.ts）。两条产出路径，**优先级刻意如此**：
//   ① 稿子自带 Markdown 结构（有标题层级/列表）→ 直接按它切页。确定性、零 token、尊重用户原结构。
//   ② 稿子是一整坨无结构长文 → 才请模型切页。走项目现有的 OpenAI 兼容网关（lib/llm/gateway），
//      **任意模型都行**（DeepSeek/通义/豆包/Claude 皆可），不再绑死 Anthropic 官方 Key。
//   ③ 模型不可用/返回垃圾 → 落回按段落机械切页。导出永远不失败。
//
// 模型在这里只被允许「说什么」，不被允许决定「排成什么样」——版式全在渲染器里写死。
// 这既是可复现性的来源，也是合规的来源（AIGC 标识由渲染器写，不看模型脸色）。

import { llmComplete } from '../llm/gateway';
import { stripJsonFences } from '../llm/openai-compatible';

export type DeckSlide = { title: string; bullets: string[] };
export type Deck = { title: string; slides: DeckSlide[] };

const MAX_BULLETS_PER_SLIDE = 6; // 再多一页就塞不下了（正文框高 3886200 EMU / 20pt 行高）
const MAX_BULLET_CHARS = 120;
const MAX_SLIDES = 30; // 上限兜底：万字长文别产出 200 页

/** 稿子结构够不够「自己就能切页」——两页以上正文才算数。 */
function isUsable(deck: Deck): boolean {
  return deck.slides.length >= 3; // 封面 + 至少两页正文
}

/**
 * 产出大纲。tenantId 传 null 表示不走模型（纯本地，测试与无网环境用）。
 *
 * 注意这里**不主动追加 AIGC 标识**：显式标识由渲染器强制写进每页页脚，
 * 在大纲层再塞一条只会变成正文里的一个要点，重复且可被用户误删。
 */
export async function planDeck(
  tenantId: string | null,
  title: string,
  content: string,
  opts?: { useLlm?: boolean },
): Promise<Deck> {
  const structured = outlineFromMarkdown(title, content);
  // 用户自己写了结构 → 用户说了算，不烧 token
  if (isUsable(structured) || opts?.useLlm === false) return structured;

  try {
    const r = await llmComplete(
      tenantId,
      'generation',
      [
        { role: 'system', content: DECK_SYSTEM },
        { role: 'user', content: buildDeckPrompt(title, content) },
      ],
      { json: true, temperature: 0.3 },
    );
    const parsed = parseDeckJson(r.text, title);
    if (parsed && isUsable(parsed)) return parsed;
  } catch {
    // 配额超限/供应商故障都不该让导出失败——降级到机械切页，用户至少拿得到文件
  }
  return isUsable(structured) ? structured : chunkFallback(title, content);
}

const DECK_SYSTEM =
  '你是演示文稿结构编辑。只做「把已有文稿拆成页」这一件事：不新增事实、不润色观点、不加结论。' +
  '只输出 JSON，不要任何解释文字。';

export function buildDeckPrompt(title: string, content: string): string {
  return [
    `标题：${title}`,
    '',
    '把下面的文稿拆成演示文稿大纲，输出 JSON：',
    '{"slides":[{"title":"页标题","bullets":["要点一","要点二"]}]}',
    '',
    '要求：',
    '- 4~8 页；每页 2~5 个要点，每个要点不超过 30 字',
    '- 要点必须是文稿里已有的信息的压缩，不能新增事实或数据',
    '- 页标题用文稿自己的说法，不要「引言/正文/总结」这种空壳标题',
    '- 不要生成封面页（渲染器会自动加）',
    '',
    '---',
    content.slice(0, 8000),
  ].join('\n');
}

/** 解析模型返回的大纲 JSON。任何一点不合规就返回 null（由调用方降级），不做「尽量抢救」。 */
export function parseDeckJson(raw: string, title: string): Deck | null {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonFences(raw));
  } catch {
    return null;
  }
  const list = (data as { slides?: unknown })?.slides;
  if (!Array.isArray(list)) return null;
  const slides: DeckSlide[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const t = typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '';
    const rawBullets = (item as { bullets?: unknown }).bullets;
    const bullets = Array.isArray(rawBullets)
      ? rawBullets.filter((b): b is string => typeof b === 'string').map(trimBullet).filter(Boolean)
      : [];
    if (!t.trim() && !bullets.length) continue;
    slides.push({ title: t.trim(), bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE) });
  }
  if (!slides.length) return null;
  return { title, slides: [cover(title), ...slides].slice(0, MAX_SLIDES) };
}

// ── 路径①：按 Markdown 结构切页 ──

const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^\s*(?:[-*+•]|\d+[.、)])\s+(.+)$/;

/**
 * 按 Markdown 结构切页：标题起新页，列表项与段落都变成要点。
 * 一页要点超过 MAX_BULLETS_PER_SLIDE 就开「（续）」页，绝不让文字溢出版心。
 */
export function outlineFromMarkdown(title: string, content: string): Deck {
  const slides: DeckSlide[] = [];
  let current: DeckSlide | null = null;

  const push = (text: string) => {
    if (!text) return;
    if (!current) current = { title: '', bullets: [] };
    if (current.bullets.length >= MAX_BULLETS_PER_SLIDE) {
      const base = current.title.replace(/（续）$/, '');
      slides.push(current);
      current = { title: `${base}（续）`, bullets: [] };
    }
    current.bullets.push(text);
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const h = HEADING.exec(line);
    if (h) {
      if (current) slides.push(current);
      current = { title: stripInline(h[2]), bullets: [] };
      continue;
    }
    const b = BULLET.exec(line);
    push(trimBullet(b ? b[1] : line));
  }
  if (current) slides.push(current);

  const body = slides.filter((s) => s.title || s.bullets.length).slice(0, MAX_SLIDES - 1);
  // 文稿开头的 `# 大标题` 是文章标题，不是一页内容——它和封面重复，去掉。
  // （实测：不去的话第 2 页就是一张只有标题、正文空白的重复页）
  if (body[0] && !body[0].bullets.length && sameTitle(body[0].title, title)) body.shift();
  return { title, slides: [cover(title), ...body] };
}

// ── 路径③：机械切页兜底 ──

/** 既无结构又没模型时：按段落顺序装页，保证导出永远有产出。 */
function chunkFallback(title: string, content: string): Deck {
  const paras = content
    .split(/\n+/)
    .map((p) => trimBullet(p.trim()))
    .filter(Boolean);
  const slides: DeckSlide[] = [];
  for (let i = 0; i < paras.length && slides.length < MAX_SLIDES - 1; i += MAX_BULLETS_PER_SLIDE) {
    slides.push({
      title: slides.length === 0 ? '要点' : `要点（${slides.length + 1}）`,
      bullets: paras.slice(i, i + MAX_BULLETS_PER_SLIDE),
    });
  }
  return { title, slides: [cover(title), ...slides] };
}

// 标题相同与否忽略空白差异（模型/用户常在标题里多打一个空格）
function sameTitle(a: string, b: string): boolean {
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

function cover(title: string): DeckSlide {
  return { title: title.trim() || '未命名', bullets: [] };
}

// 去掉 Markdown 行内标记：**粗体**、`代码`、[文字](链接) 只保留文字。
// 演示文稿里这些符号既不会被渲染成样式，又会念出来很怪。
function stripInline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .trim();
}

function trimBullet(s: string): string {
  const t = stripInline(s);
  return t.length > MAX_BULLET_CHARS ? `${t.slice(0, MAX_BULLET_CHARS - 1)}…` : t;
}
