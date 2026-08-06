// 本地交付物「技能」注册表。
//
// 一个技能 = 规划（模型产结构化大纲，任意模型）+ 渲染（确定性代码产文件字节，零模型）。
// Anthropic Agent Skills 把这两件事焊死在它的容器里，所以只能整包用、且只能用它家 Key；
// 拆开注册在这里之后，加一种格式 = 加一条记录，不用改导出动作。
//
// 新增格式的清单（照抄 pptx 那条即可）：
//   1. render：把 Deck 渲染成字节，**AIGC 显式标识必须由渲染器自己写入**，不依赖模型听话；
//   2. labelVerifiable：本格式能否用 verifyAigcLabelInFile 真校验（OOXML 可以，PDF 不行）；
//   3. 若 labelVerifiable=false，就别把它放进导出白名单——见 actions.ts 的服务端硬闸。

import { planDeck, type Deck } from './outline';
import { buildPptxLocal } from './pptx';
import { buildCards, numberCards, CARD_THEMES, type Card, type CardThemeKey } from './card';
import { buildDocxLocal } from '../llm/skills';

export type FileSkillId = 'docx' | 'pptx';
export type LocalSkillId = FileSkillId | 'card';

type SkillBase = {
  /** 界面上的中文名 */
  label: string;
  /** 是否需要先把正文规划成分页大纲（docx 是线性文档，不需要） */
  needsOutline: boolean;
  /**
   * 产物里的 AIGC 显式标识能否**从字节校验**。
   * OOXML 可以（解 zip 读 XML）；图片不行（那是像素，验它要 OCR）——
   * 后者只能靠「标识由渲染代码强制写入」保证，别把两者混为一谈。
   */
  labelVerifiable: boolean;
};

/**
 * 两类产物，别硬塞进一个签名里：
 * - file：直接产出字节，服务端可以走 verifyAigcLabelInFile 的校验回环；
 * - ops：产出绘制指令，由浏览器 canvas 落成图片（服务器不装 chromium/字体）。
 */
export type LocalSkill =
  | (SkillBase & { id: FileSkillId; output: 'file'; render: (input: RenderInput) => Buffer })
  | (SkillBase & { id: 'card'; output: 'ops'; render: (input: RenderInput) => Card[] });

export type RenderInput = {
  title: string;
  /** 已过 ensureAigcLabel 的正文 */
  content: string;
  /** needsOutline 的技能才有 */
  deck?: Deck;
  /** AIGC 隐式标识的内容编号（第五条） */
  produceId: string;
  /** 署名（图文卡封面用账号名） */
  brand?: string;
  /** 图文卡模板 */
  theme?: CardThemeKey;
};

export const LOCAL_SKILLS: Record<LocalSkillId, LocalSkill> = {
  docx: {
    id: 'docx',
    output: 'file',
    label: 'Word',
    needsOutline: false,
    labelVerifiable: true,
    render: ({ title, content, produceId }) => buildDocxLocal(title, content, produceId),
  },
  pptx: {
    id: 'pptx',
    output: 'file',
    label: '演示文稿',
    needsOutline: true,
    labelVerifiable: true,
    render: ({ title, content, deck, produceId }) =>
      buildPptxLocal(deck ?? { title, slides: [{ title, bullets: [] }] }, produceId),
  },
  card: {
    id: 'card',
    output: 'ops',
    label: '图文卡',
    needsOutline: true,
    // 图片的显式标识验不了（像素），靠 card.ts 里「每张卡强制画上」保证；
    // 可字节校验的只有 PNG 的隐式标识（iTXt 分块，见 png-meta.ts）。
    labelVerifiable: false,
    render: ({ title, content, deck, brand, theme }) =>
      numberCards(buildCards(deck ?? { title, slides: [{ title, bullets: [content] }] }, { brand, theme })),
  },
};

/** 本地渲染一份交付物。needsOutline 的格式会先规划大纲（模型可用则用，不可用则退回按结构切页）。 */
export async function renderLocalDeliverable(params: {
  skillId: FileSkillId;
  tenantId: string | null;
  title: string;
  content: string;
  produceId: string;
}): Promise<{ data: Buffer; filename: string }> {
  const skill = LOCAL_SKILLS[params.skillId] as Extract<LocalSkill, { output: 'file' }>;
  const deck = skill.needsOutline
    ? await planDeck(params.tenantId, params.title, params.content)
    : undefined;
  const data = skill.render({
    title: params.title,
    content: params.content,
    deck,
    produceId: params.produceId,
  });
  return { data, filename: `${params.title}.${skill.id}` };
}

/**
 * 排出图文卡的绘制指令（落成 PNG 在浏览器，见 lib/deliverable/canvas.ts）。
 *
 * **四套模板一次性全排出来**：规划（可能要调模型）只跑一次，用户切模板就是客户端换一份指令重画，
 * 既不再花 token 也没有等待。指令是小 JSON，四份加起来也就几十 KB。
 */
export async function renderCards(params: {
  tenantId: string | null;
  title: string;
  content: string;
  produceId: string;
  brand?: string;
}): Promise<Record<CardThemeKey, Card[]>> {
  // 取的就是 card 那条，收窄成 ops 分支（Record 的联合值类型不会自己收窄）
  const skill = LOCAL_SKILLS.card as Extract<LocalSkill, { output: 'ops' }>;
  const deck = await planDeck(params.tenantId, params.title, params.content);
  const out = {} as Record<CardThemeKey, Card[]>;
  for (const key of Object.keys(CARD_THEMES) as CardThemeKey[]) {
    out[key] = skill.render({ ...params, deck, theme: key });
  }
  return out;
}
