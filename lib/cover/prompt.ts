import { llmComplete } from '../llm/gateway';
import { parseJson } from '../json';
import { coverStyle } from './styles';

// 小红书 AI 封面的提示词管线（域14）。两步：
//   ① deriveCoverMeta —— 读草稿正文，抽出封面要素（主标题/副标题/配色倾向/关键词）。这一步是文本
//      调用（llmComplete），是「在小红书上直接生成对应封面」里“直接”二字的来源：用户不必自己想标题。
//   ② buildCoverPrompt —— 把要素 + 风格预设 + 参考图意图，拼成给图像模型的中文提示词。
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

const EMPTY_META: CoverMeta = { mainTitle: '', subTitle: '', palette: '' };

/**
 * 从草稿正文抽封面要素。`instruction` 是**渲染后的技能模板**（已把 {{content}}/{{title}} 填好），
 * 由 runSkill 传入——这样“技能=提示词模板”这条不变式对图像技能同样成立：模板驱动这一步的抽取口径。
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
  const clean = (v: unknown, max: number): string =>
    typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
  const meta: CoverMeta = {
    mainTitle: clean(raw.mainTitle, 24) || fallbackTitle.trim().slice(0, 24),
    subTitle: clean(raw.subTitle, 20),
    palette: clean(raw.palette, 60),
  };
  return { meta, mocked: res.mocked };
}

/**
 * 会被**画到图上、随封面对外发布**的文字。合规红线闸检的就是这一串（不是整条图像提示词——
 * 提示词里的“风格/布局”不发布，标题副标题才发布）。见 lib/skills/index.ts 的图像分支。
 */
export function onImageText(meta: CoverMeta): string {
  return [meta.mainTitle, meta.subTitle].filter(Boolean).join(' ');
}

export type BuildCoverPromptInput = {
  meta: CoverMeta;
  styleKey?: string;
  /** 有参考图 → 加“主体保真”约束（保留人物/产品相貌，只换背景与排版）。 */
  hasReference?: boolean;
  /** 文字留白版：不在图上写字，只出背景与构图、预留标题区，用户自己叠字（兜住中文上字糊字的风险）。 */
  textless?: boolean;
};

/** 拼出给图像模型的中文提示词。 */
export function buildCoverPrompt(input: BuildCoverPromptInput): string {
  const style = coverStyle(input.styleKey);
  const { meta } = input;
  const lines: string[] = ['制作一张小红书竖版封面图，比例 3:4，画面高级、抓眼、信息层级分明。'];

  lines.push(`【风格】${style.prompt}`);
  if (meta.palette) lines.push(`【配色倾向】${meta.palette}`);

  if (input.textless) {
    // 留白版：明确不上字，给用户留出叠字的干净区域
    lines.push(
      '【文字】这一版**不要在图上写任何文字**；在画面上半部预留一块干净、对比得当的区域，方便后期叠加标题。',
    );
  } else {
    lines.push(`【主标题】${meta.mainTitle}（最大最醒目，位于视觉中心偏上，一眼能读到）`);
    if (meta.subTitle) lines.push(`【副标题】${meta.subTitle}（比主标题小，作为补充或点缀）`);
    lines.push(
      '【文字要求】所有文字用简体中文；字形清晰、笔画完整、**无错字无多余乱码**；' +
        '主副标题层级分明；文字与背景对比充分、易读；文字不贴边、不被裁切。',
    );
  }

  lines.push('【布局】构图简洁，信息不堆砌；四周留足安全边距；主体与文字互不遮挡。');

  if (input.hasReference) {
    lines.push(
      '【主体保真】必须**保留参考图中人物/主体的相貌、发型、服装与关键特征**，只更换背景与排版风格，不改变主体身份、不换脸。',
    );
  }

  lines.push('【禁止】不要二维码；不要与主题无关的杂乱元素；不要残缺或重叠到无法辨认的文字。');
  return lines.join('\n');
}
