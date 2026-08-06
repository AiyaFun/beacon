// 图文卡排版（小红书 3:4）——「技能本地化」的第三种渲染器。
//
// 与 pptx/docx 的区别只在**产物形态**：那两个产出的是字节，这个产出的是**绘制指令**，
// 由浏览器 canvas 落成 PNG（服务器不装 chromium、不装字体、不引原生依赖）。
// 规划仍然共用 outline.ts 的 Deck —— 一份大纲，三种渲染，这正是注册表想要的样子。
//
// 为什么排版留在服务端（而不是客户端边画边排）：
// - 换行/分页/字号是**纯函数**，能单测；画布只负责按指令描图，测不到的部分尽可能少；
// - AIGC 显式标识由这里强制写进每张卡的指令流，客户端删不掉也漏不了（第四条对图片同样适用）。
//
// 已知取舍：字宽是**按字符估算**的（中文全角、西文约 0.55 字宽），不是 canvas 的真实 measureText。
// 代价是极端字符组合下右边可能多留一点白；换来的是排版可在 Node 里单测、且不同机器结果一致。

import { AIGC_LABEL, hasAigcLabel } from '../compliance/aigc';
import type { Deck } from './outline';

// 小红书竖版图 3:4。1080×1440 是平台推荐尺寸，再大只是徒增体积。
export const CARD_W = 1080;
export const CARD_H = 1440;

const PAD = 88;
const CONTENT_W = CARD_W - PAD * 2;

// ── 模板 ──
//
// 模板 = 一组颜色 + 封面构图 + 标题装饰。版面骨架（边距、字号刻度、分页规则）四套共用，
// 因为那部分是「放得下、看得清」的物理约束，不该跟着风格变。
// 加一套模板 = 加一条配置，不改任何排版逻辑。

export type CardThemeKey = 'plain' | 'magazine' | 'night' | 'note';

export type CardTheme = {
  key: CardThemeKey;
  name: string;
  bg: string;
  ink: string;
  muted: string;
  accent: string;
  hair: string;
  /** 页标题的装饰：细线 / 左侧竖条 / 不加 */
  titleRule: 'hair' | 'bar' | 'none';
  cover: {
    /** bar=细红杠+深色字；block=整页主色+反白字；plate=浅色纸片+深色字 */
    style: 'bar' | 'block' | 'plate';
    bg: string;
    ink: string;
    muted: string;
  };
};

export const CARD_THEMES: Record<CardThemeKey, CardTheme> = {
  // 现状那套：白底黑字，配色与 pptx 主题同源，导出物之间看起来是一家人
  plain: {
    key: 'plain', name: '极简白',
    bg: '#FFFFFF', ink: '#1F2933', muted: '#7F8C8D', accent: '#C0392B', hair: '#E8ECF0',
    titleRule: 'hair',
    cover: { style: 'bar', bg: '#FFFFFF', ink: '#1F2933', muted: '#7F8C8D' },
  },
  // 封面整块红底反白字——小红书信息流里最抓眼的一种，正文回到白底保证可读
  magazine: {
    key: 'magazine', name: '杂志红',
    bg: '#FFFFFF', ink: '#1A1A1A', muted: '#8A8A8A', accent: '#D7263D', hair: '#F0E3E5',
    titleRule: 'bar',
    cover: { style: 'block', bg: '#D7263D', ink: '#FFFFFF', muted: '#FFD9DE' },
  },
  // 深底浅字 + 琥珀强调，适合技术/干货；夜间刷手机时不刺眼
  night: {
    key: 'night', name: '深色夜间',
    bg: '#14181D', ink: '#F2F5F7', muted: '#8A949E', accent: '#F0A500', hair: '#262C33',
    titleRule: 'hair',
    cover: { style: 'bar', bg: '#14181D', ink: '#F2F5F7', muted: '#8A949E' },
  },
  // 米黄纸感、弱化标题装饰，手账/便签风，适合随笔与清单
  note: {
    key: 'note', name: '便签黄',
    bg: '#FDF6E3', ink: '#3A3226', muted: '#9A8F7A', accent: '#E0A800', hair: '#EADFC4',
    titleRule: 'none',
    cover: { style: 'plate', bg: '#FDF6E3', ink: '#3A3226', muted: '#9A8F7A' },
  },
};

export const CARD_THEME_LIST = Object.values(CARD_THEMES).map((t) => ({ key: t.key, name: t.name }));

export const DEFAULT_CARD_THEME: CardThemeKey = 'plain';

export type CardOp =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | {
      kind: 'text';
      x: number;
      y: number; // 文本**顶边**（客户端固定 textBaseline='top'，免得各浏览器基线不一致）
      text: string;
      size: number;
      color: string;
      bold?: boolean;
      align?: 'left' | 'center' | 'right';
    };

export type Card = { w: number; h: number; bg: string; ops: CardOp[] };

// 小红书单帖图片上限
const MAX_CARDS = 18;

/** 把大纲排成图文卡。第一张是封面，其余按小节分页。 */
export function buildCards(deck: Deck, opts?: { brand?: string; theme?: CardThemeKey }): Card[] {
  const theme = CARD_THEMES[opts?.theme ?? DEFAULT_CARD_THEME] ?? CARD_THEMES[DEFAULT_CARD_THEME];
  const cards: Card[] = [coverCard(theme, deck.title, opts?.brand)];
  const body = deck.slides.slice(1);

  for (const slide of body) {
    const bullets = slide.bullets.filter((b) => b.trim() && !hasAigcLabel(b));
    const lines = layoutBullets(bullets);
    if (!lines.length && !slide.title.trim()) continue;
    for (const chunk of paginate(lines)) {
      if (cards.length >= MAX_CARDS) return cards;
      cards.push(contentCard(theme, slide.title, chunk));
    }
  }
  // 只有封面时补一张正文卡，避免「导出了一张图，什么都没说」
  if (cards.length === 1 && body.length === 0) return cards;
  return cards;
}

// ── 封面 ──

function coverCard(theme: CardTheme, title: string, brand?: string): Card {
  const ops: CardOp[] = [];
  const c = theme.cover;

  if (c.style === 'block') {
    // 整页主色，标题反白：信息流里最跳的一种封面
    ops.push({ kind: 'rect', x: 0, y: 0, w: CARD_W, h: CARD_H, fill: c.bg });
    ops.push({ kind: 'rect', x: PAD, y: 300, w: 132, h: 18, fill: c.ink });
  } else if (c.style === 'plate') {
    // 纸片：比整页色块温和，手账风
    ops.push({ kind: 'rect', x: PAD - 24, y: 260, w: CONTENT_W + 48, h: 620, fill: '#FFFFFF' });
    ops.push({ kind: 'rect', x: PAD - 24, y: 260, w: 12, h: 620, fill: theme.accent });
  } else {
    ops.push({ kind: 'rect', x: PAD, y: 300, w: 132, h: 18, fill: theme.accent });
  }

  // 标题按长度降档，保证 4 行内放得下（96 → 80 → 64）
  const size = [96, 80, 64].find((s) => wrapText(title, s, CONTENT_W).length <= 4) ?? 64;
  const lines = wrapText(title, size, CONTENT_W).slice(0, 5);
  let y = 380;
  for (const line of lines) {
    ops.push({ kind: 'text', x: PAD, y, text: line, size, color: c.ink, bold: true });
    y += Math.round(size * 1.32);
  }

  if (brand?.trim()) {
    ops.push({ kind: 'text', x: PAD, y: y + 40, text: `@${brand.trim()}`, size: 34, color: c.muted });
  }
  return withFooter({ w: CARD_W, h: CARD_H, bg: c.bg, ops }, c.muted);
}

// ── 正文卡 ──

const BODY_SIZE = 40;
const BODY_LINE = 64;
const BULLET_GAP = 20; // 要点之间额外留白
const BODY_TOP = 300;
const BODY_BOTTOM = CARD_H - 190; // 下面留给页脚（标识 + 页码）

type BodyLine = { text: string; first: boolean; gapBefore: number };

function contentCard(theme: CardTheme, title: string, lines: BodyLine[]): Card {
  const ops: CardOp[] = [];
  const titleLines = wrapText(title, 52, CONTENT_W).slice(0, 2);
  const titleTop = PAD + 40;
  let y = titleTop;
  // 左侧竖条（杂志风）：标题多高，条就多高
  const titleX = theme.titleRule === 'bar' ? PAD + 32 : PAD;
  for (const line of titleLines) {
    ops.push({ kind: 'text', x: titleX, y, text: line, size: 52, color: theme.ink, bold: true });
    y += 72;
  }
  if (theme.titleRule === 'bar') {
    ops.push({ kind: 'rect', x: PAD, y: titleTop + 8, w: 12, h: 72 * titleLines.length - 24, fill: theme.accent });
  } else if (theme.titleRule === 'hair') {
    ops.push({ kind: 'rect', x: PAD, y: y + 12, w: CONTENT_W, h: 2, fill: theme.hair });
  }

  // 内容少时整块往下挪一点（挪三分之一的余量，不是居中）：
  // 卡片只有两三条要点时顶着上边排，下面一大片空白，看起来像没做完。
  const used = lines.reduce((sum, l) => sum + l.gapBefore + BODY_LINE, 0);
  let cursor = BODY_TOP + Math.max(0, Math.round((BODY_BOTTOM - BODY_TOP - used) / 3));
  for (const line of lines) {
    cursor += line.gapBefore;
    if (line.first) {
      // 圆点用色块画，不用字符——不同系统的「•」宽度差别很大，画出来会参差
      ops.push({ kind: 'rect', x: PAD, y: cursor + 16, w: 12, h: 12, fill: theme.accent });
    }
    ops.push({ kind: 'text', x: PAD + 36, y: cursor, text: line.text, size: BODY_SIZE, color: theme.ink });
    cursor += BODY_LINE;
  }
  return withFooter({ w: CARD_W, h: CARD_H, bg: theme.bg, ops }, theme.muted);
}

// 要点 → 行（含挂行缩进标记与要点间距）
function layoutBullets(bullets: string[]): BodyLine[] {
  const out: BodyLine[] = [];
  for (const b of bullets) {
    const wrapped = wrapText(b, BODY_SIZE, CONTENT_W - 36);
    wrapped.forEach((text, i) => {
      out.push({ text, first: i === 0, gapBefore: i === 0 && out.length ? BULLET_GAP : 0 });
    });
  }
  return out;
}

// 按可用高度切页；一张卡放不下就翻到下一张（宁可多一张，不让文字压到页脚）
function paginate(lines: BodyLine[]): BodyLine[][] {
  const pages: BodyLine[][] = [];
  let cur: BodyLine[] = [];
  let used = BODY_TOP;
  for (const line of lines) {
    const next = used + line.gapBefore + BODY_LINE;
    if (next > BODY_BOTTOM && cur.length) {
      pages.push(cur);
      cur = [];
      used = BODY_TOP;
    }
    // 换页后这一行就是页首，前置间距归零
    const placed = cur.length === 0 ? { ...line, gapBefore: 0 } : line;
    cur.push(placed);
    used += placed.gapBefore + BODY_LINE;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

// ── 页脚：AIGC 显式标识 ──
//
// 第四条对图片同样要求「在适当位置添加显著的提示标识」。这里每张卡都画，
// 且由代码写死——用户单张转发、截图二次传播时标识都还在。
function withFooter(card: Card, muted: string): Card {
  card.ops.push({
    kind: 'text',
    x: PAD,
    y: CARD_H - 96,
    text: AIGC_LABEL,
    size: 26,
    color: muted,
  });
  return card;
}

/** 给整套卡片补页码（放在最后，页数此时才确定）。 */
export function numberCards(cards: Card[]): Card[] {
  if (cards.length <= 1) return cards;
  return cards.map((c, i) => ({
    ...c,
    ops: [
      ...c.ops,
      {
        kind: 'text' as const,
        x: CARD_W - PAD,
        y: CARD_H - 96,
        text: `${i + 1} / ${cards.length}`,
        size: 26,
        // 与该卡的 AIGC 标识同色：页脚两个元素跟着主题走，不写死
        color: footerColor(c),
        align: 'right' as const,
      },
    ],
  }));
}

// 页码要跟标识同色。标识那条 text 指令就是页脚色的唯一事实来源，从卡片里读回来即可。
function footerColor(card: Card): string {
  const label = card.ops.find((o) => o.kind === 'text' && o.text === AIGC_LABEL);
  return label && label.kind === 'text' ? label.color : '#7F8C8D';
}

// ── 换行 ──

// 中日韩字符、全角标点按一个字宽算；其余（西文、数字、半角标点）约 0.55。
// 这是估算，不是 measureText —— 取舍见文件头。
const FULL_WIDTH = /[\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += FULL_WIDTH.test(ch) ? size : size * 0.55;
  return w;
}

// 禁则处理（简版）：行首不出现这些收尾符号，把它们拽回上一行。
const NO_LINE_START = '，。、；：？！）】》」』…—·,.;:?!)]}>%';

/** 按可用宽度折行。中文逐字断行，西文单词尽量不拆。 */
export function wrapText(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    let width = 0;
    // 西文单词与连续数字视为一个不可拆单元
    const tokens = paragraph.match(/[A-Za-z0-9]+[.,%]?|[\s\S]/g) ?? [];
    for (const token of tokens) {
      const tw = textWidth(token, size);
      if (width + tw > maxWidth && line) {
        // 下一个字符是收尾标点时，它跟着上一行走，不做孤悬行首
        if (NO_LINE_START.includes(token) && line.length) {
          lines.push(line + token);
          line = '';
          width = 0;
          continue;
        }
        lines.push(line);
        line = '';
        width = 0;
      }
      if (token === ' ' && !line) continue; // 行首空格丢掉
      line += token;
      width += tw;
    }
    if (line) lines.push(line);
    if (!paragraph) lines.push('');
  }
  return lines.filter((l, i) => l !== '' || i > 0);
}
