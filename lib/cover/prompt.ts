import { llmComplete } from '../llm/gateway';
import { parseJson } from '../json';
import { coverStyle, styleDescription, coverFont, decorPrompts } from './styles';
import { coverSpec, type CoverSpec } from './specs';
import { COVER_TITLE_HARD_MAX, COVER_SUBTITLE_HARD_MAX, COVER_EXTRA_HARD_MAX } from './rules';

// AI 封面的提示词管线（域14）。两步：
//   ① deriveCoverMeta —— 读草稿正文，抽出封面要素（主标题/副标题/配色倾向）。这一步是文本调用
//      （llmComplete），只在用户**没有**手填/带入封面大字时才跑：封面工位里大字默认来自采纳的标题或
//      标题矩阵的封面建议，那时这一步整个跳过（省一次调用、省一个配额名额）。
//   ② buildCoverPrompt —— 把要素 + 规格（比例）+ 风格 + 字体倾向 + 装饰 + 参考图意图 + 备注，拼成给
//      图像模型的中文提示词。
//
// 拆两步的理由：图像模型不擅长“从长正文里提炼一句抓眼标题”，文本模型擅长；反过来排版审美归图像模型。
// 各干各擅长的，比让一个模型端到端硬做稳。

export type CoverMeta = {
  /** 封面主标题：最大最醒目，一眼能读到。 */
  mainTitle: string;
  /** 副标题/点缀短语，可空。 */
  subTitle?: string;
  /** 配色倾向的一句话描述（可空，空则由风格决定）。 */
  palette?: string;
};

/** 统一的清洗口径：去首尾空白、压缩空白、截硬上限。手填与模型抽取走同一个函数。 */
export function cleanCoverText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

/**
 * 从草稿正文抽封面要素。`instruction` 是**渲染后的技能模板**（已把 {{content}}/{{title}} 填好），
 * 由调用方传入——这样“技能=提示词模板”这条不变式对图像技能同样成立：模板驱动这一步的抽取口径。
 *
 * 口径：走 generation 路由 + json 模式。失败/空标题时回落到 fallbackTitle（草稿标题），
 * 绝不让封面因为抽取这步没返回就整条失败——大不了主标题用草稿标题，仍能出图。
 */
export async function deriveCoverMeta(
  tenantId: string | null,
  instruction: string,
  fallbackTitle: string,
): Promise<{ meta: CoverMeta; mocked: boolean }> {
  const res = await llmComplete(
    tenantId,
    'generation',
    [
      {
        role: 'system',
        content:
          '你是小红书封面文案策划。只输出一个 JSON 对象，字段：' +
          'mainTitle（封面主标题，≤14字，抓眼、口语、有信息量或悬念），' +
          'subTitle（副标题或点缀短语，≤12字，可为空字符串），' +
          'palette（配色倾向的一句话，可为空字符串）。' +
          '不要解释、不要 markdown 代码块。',
      },
      { role: 'user', content: instruction },
    ],
    { temperature: 0.6, json: true },
  );

  const raw = parseJson<Partial<CoverMeta>>(res.text, {});
  const meta: CoverMeta = {
    mainTitle: cleanCoverText(raw.mainTitle, COVER_TITLE_HARD_MAX) || fallbackTitle.trim().slice(0, COVER_TITLE_HARD_MAX),
    subTitle: cleanCoverText(raw.subTitle, COVER_SUBTITLE_HARD_MAX),
    palette: cleanCoverText(raw.palette, 60),
  };
  return { meta, mocked: res.mocked };
}

/**
 * 会被**画到图上、随封面对外发布**的文字。合规红线闸检的就是这一串（不是整条图像提示词——
 * 提示词里的“风格/布局”不发布，标题副标题才发布）。见 lib/cover/run.ts。
 */
export function onImageText(meta: CoverMeta): string {
  return [meta.mainTitle, meta.subTitle].filter(Boolean).join(' ');
}

export type BuildCoverPromptInput = {
  meta: CoverMeta;
  /** 比例规格（默认小红书 3:4）。传 key 或整个 spec 都行。 */
  spec?: CoverSpec | string;
  styleKey?: string;
  /**
   * 自定义风格（「我的风格库」里存的）：给了就**顶替**内置风格那一段。
   * 用户自己写的一句话描述直接进提示词——不替他"AI 扩写"一遍：扩写要花钱、会走样，
   * 而且他明明已经说清楚要什么了。
   */
  customStyle?: { name: string; description: string };
  /** 字体倾向 key（见 styles.ts COVER_FONTS），缺省随风格。 */
  fontKey?: string;
  /** 装饰点缀 keys（见 styles.ts COVER_DECORS）。 */
  decors?: string[];
  /** 用户给 AI 的补充要求（不发布、不进红线，截 300 字）。 */
  extra?: string;
  /** 主体（人像/产品）参考图张数：>0 → 加「主体保真」段。 */
  subjectCount?: number;
  /** 背景/氛围参考图张数：>0 → 加「背景取材」段。 */
  backgroundCount?: number;
  /**
   * 兼容旧调用：有任意参考图 → 视为主体保真（等价于 subjectCount>0）。
   * 新代码请分开传 subjectCount / backgroundCount。
   */
  hasReference?: boolean;
  /** 文字留白版：不在图上写字，只出背景与构图、预留标题区，用户自己叠字（兜住中文上字糊字的风险）。 */
  textless?: boolean;
};

/** 拼出给图像模型的中文提示词。 */
export function buildCoverPrompt(input: BuildCoverPromptInput): string {
  const style = coverStyle(input.styleKey);
  const spec = typeof input.spec === 'string' || input.spec == null ? coverSpec(input.spec ?? undefined) : input.spec;
  const font = coverFont(input.fontKey);
  const { meta } = input;
  const subjectCount = input.subjectCount ?? (input.hasReference ? 1 : 0);
  const backgroundCount = input.backgroundCount ?? 0;

  const lines: string[] = [
    `制作一张${spec.label.replace(/\s.*$/, '')}封面图，比例 ${spec.ratio}，画面高级、抓眼、信息层级分明。`,
  ];

  if (input.customStyle) {
    lines.push(`【风格】${input.customStyle.name}`);
    lines.push(input.customStyle.description);
  } else {
    lines.push(`【风格】${style.name}`);
    lines.push(styleDescription(style));
  }
  if (meta.palette) lines.push(`【配色倾向】${meta.palette}`);

  if (input.textless) {
    // 留白版：明确不上字，给用户留出叠字的干净区域
    lines.push(
      '【文字】这一版**不要在图上写任何文字**；在画面上半部预留一块干净、对比得当的区域，方便后期叠加标题。',
    );
  } else {
    lines.push(`【主标题】${meta.mainTitle}（最大最醒目，位于视觉中心偏上，一眼能读到）`);
    if (meta.subTitle) lines.push(`【副标题】${meta.subTitle}（比主标题小，作为补充或点缀）`);
    if (font.prompt) lines.push(`【字体倾向】${font.prompt}`);
    lines.push(
      '【文字要求】所有文字用简体中文；字形清晰、笔画完整、**无错字无多余乱码**；' +
        '主副标题层级分明；文字与背景对比充分、易读；文字不贴边、不被裁切。',
    );
  }

  const decors = decorPrompts(input.decors);
  if (decors.length) lines.push(`【装饰】${decors.join('；')}。装饰只做点缀，不抢主体与文字。`);

  lines.push('【布局】构图简洁，信息不堆砌；四周留足安全边距；主体与文字互不遮挡。');

  if (subjectCount > 0) {
    lines.push(
      '【主体保真】参考图中的第一张是主体（人物/产品）：必须**保留其相貌、发型、服装与关键特征**，' +
        '只更换背景与排版风格，不改变主体身份、不换脸、不改变体型。',
    );
  }
  if (backgroundCount > 0) {
    lines.push(
      `【背景取材】其余 ${backgroundCount} 张参考图是背景/氛围：从中选取或融合场景与色调作为画面背景，` +
        '过渡自然、不生硬拼贴；主体优先，背景不喧宾夺主。',
    );
  }

  const extra = cleanCoverText(input.extra, COVER_EXTRA_HARD_MAX);
  if (extra) lines.push(`【补充要求】${extra}`);

  lines.push('【禁止】不要二维码；不要与主题无关的杂乱元素；不要残缺或重叠到无法辨认的文字。');
  return lines.join('\n');
}
