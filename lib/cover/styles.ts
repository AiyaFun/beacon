// 小红书封面风格预设（域14 · AI 封面）。
//
// 每个风格 = 一段**结构化的画面描述**（配色 / 背景 / 文字样式 / 氛围），拼进图像提示词。
// 风格是数据不是代码：新增一档只在这里加一项，UI 的下拉、prompt 的拼装都从这份清单读，
// 不各写一份（跟技能清单、平台名映射同一个纪律）。
//
// ⚠️ 待真机校准：拿到 ARK Key 后逐档出一张对照，按真实观感微调措辞——尤其中文上字质量。

export type CoverStyle = {
  key: string;
  name: string;
  /** 给用户看的一句话说明（UI 下拉的 title / 说明） */
  hint: string;
  /** 拼进图像提示词的画面描述（配色·背景·文字·氛围） */
  prompt: string;
};

export const COVER_STYLES: CoverStyle[] = [
  {
    key: 'tech-exec',
    name: '科技高管风',
    hint: '深色高级质感、金属光泽、冷静专业，适合职场/科技/干货',
    prompt:
      '整体风格：科技高管质感。背景用深色（近黑 / 深蓝黑）配细腻金属光泽与微光渐变；' +
      '主色高级克制（铂金、亮银、蓝宝石点缀）；构图干净留白充足，有专业、可信、冷静的氛围。',
  },
  {
    key: 'magazine',
    name: '杂志封面',
    hint: '大字标题、编排考究、时尚杂志感，适合观点/盘点/深度',
    prompt:
      '整体风格：时尚杂志封面。大号标题字占据视觉中心、编排考究有网格感；' +
      '配色对比强烈但不杂（一主色 + 一强调色）；留白与分栏克制，有高级刊物的编排秩序感。',
  },
  {
    key: 'minimal-ins',
    name: '极简 ins 风',
    hint: '大面积留白、莫兰迪低饱和、干净治愈，适合生活/好物/教程',
    prompt:
      '整体风格：极简 ins 风。大面积留白，莫兰迪低饱和配色（奶油、燕麦、雾霾蓝、藕粉任选其一为主）；' +
      '元素少而精、边距舒展，安静干净治愈的氛围；文字排布轻盈不拥挤。',
  },
  {
    key: 'note-handwrite',
    name: '便签手写风',
    hint: '手写体、便利贴/胶带贴纸、亲切随手记，适合清单/心得/避坑',
    prompt:
      '整体风格：便签手写风。像贴在桌面的便利贴或手账页，暖色纸张质感、手写体标题、' +
      '胶带 / 贴纸 / 小图标点缀；亲切、随手记、有生活温度，但版面依然清爽可读。',
  },
  {
    key: 'vibrant-trend',
    name: '高饱和潮流',
    hint: '高饱和撞色、大色块、年轻有活力，适合潮流/穿搭/娱乐',
    prompt:
      '整体风格：高饱和潮流风。高饱和撞色大色块、活泼的几何或涂鸦元素；' +
      '标题字醒目有冲击力；年轻、有活力、抓眼球，但主体与文字层级仍然分明。',
  },
  {
    key: 'warm-knowledge',
    name: '温柔知识卡',
    hint: '暖色柔和渐变、圆角卡片、条理清楚，适合科普/攻略/教程',
    prompt:
      '整体风格：温柔知识卡。暖色柔和渐变背景、圆角卡片承载文字、图标辅助分点；' +
      '条理清楚一眼看懂要点，温柔不刺眼，适合承载“干货 / 攻略 / 科普”的信息型封面。',
  },
];

export const DEFAULT_COVER_STYLE = COVER_STYLES[0].key;

export function coverStyle(key: string | undefined): CoverStyle {
  return COVER_STYLES.find((s) => s.key === key) ?? COVER_STYLES[0];
}

/** 给 UI 下拉用的精简列表（不含长 prompt）。 */
export const COVER_STYLE_OPTIONS = COVER_STYLES.map((s) => ({ key: s.key, name: s.name, hint: s.hint }));
