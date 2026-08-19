// 封面风格预设（域14 · AI 封面）。
//
// 每个风格 = 一段**结构化的画面描述**，按【布局】【文字样式】【核心特效】【氛围】【禁止】五块拼进图像提示词
// （分块结构借鉴 xhs-cover-skill 开源仓库「一风格一 JSON」的写法，措辞自写）。
// 风格是数据不是代码：新增一档只在这里加一项，UI 的风格网格、prompt 的拼装、按赛道推荐都从这份清单读，
// 不各写一份（跟技能清单、平台名映射同一个纪律）。
//
// `recommendFor` 是按人设赛道推荐的关键词：人设的 niche / tone 命中即排前并标「按你的赛道推荐」。
// 命中不了就按清单顺序，第一档兜底。
//
// ⚠️ 待真机校准：拿到 ARK Key 后逐档出一张对照，按真实观感微调措辞——尤其中文上字质量与档位间区分度。
// client-safe 纯数据，不许引 prisma。

export type CoverStyle = {
  key: string;
  name: string;
  /** 给用户看的一句话说明（UI 卡片上的「适合谁」） */
  hint: string;
  /** 布局：主体在哪、字在哪、留白怎么留 */
  layout: string;
  /** 文字样式：字重、颜色、装饰 */
  text: string;
  /** 核心特效 / 元素 */
  effect: string;
  /** 氛围 */
  mood: string;
  /** 这一档特别要禁的（通用禁止项在 prompt.ts 里统一加） */
  forbid?: string;
  /** 按赛道推荐的关键词（匹配人设 niche / tone / identity 的子串） */
  recommendFor: string[];
  /** 是否更适合有人像出镜（UI 提示用） */
  portraitFriendly?: boolean;
};

export const COVER_STYLES: CoverStyle[] = [
  {
    key: 'warm-knowledge',
    name: '温柔知识卡',
    hint: '暖色柔和渐变、圆角卡片、条理清楚——科普 / 攻略 / 教程 / 育儿',
    layout: '暖色柔和渐变背景，画面中上部一块圆角卡片承载标题，卡片下方可用 2-3 个小图标点出要点；四周留白舒展。',
    text: '标题用圆润偏粗的黑体，深棕或深灰色，字距略宽；副标题小一号，用柔和的强调色。',
    effect: '轻微纸张质感与柔光，圆角与阴影都很轻，不抢字。',
    mood: '温柔、可信、一眼看懂要点，是「干货 / 攻略 / 科普」的信息型封面。',
    recommendFor: ['育儿', '母婴', '教育', '知识', '科普', '学习', '攻略', '教程', '亲子', '心理'],
  },
  {
    key: 'minimal-ins',
    name: '极简 ins 风',
    hint: '大面积留白、莫兰迪低饱和、干净治愈——生活 / 好物 / 家居 / 穿搭',
    layout: '大面积留白，主体或产品偏一侧，标题放在留白区，元素少而精、边距舒展。',
    text: '细体或中等字重的无衬线字，低饱和深色，字号克制、排布轻盈不拥挤。',
    effect: '莫兰迪低饱和配色（奶油、燕麦、雾霾蓝、藕粉任选其一为主），柔和自然光。',
    mood: '安静、干净、治愈，有生活审美感。',
    recommendFor: ['生活', '好物', '家居', '穿搭', '美妆', '护肤', '咖啡', '手作', '治愈', '日常'],
  },
  {
    key: 'magazine',
    name: '杂志封面',
    hint: '大字标题、编排考究、时尚刊物感——观点 / 盘点 / 深度 / 个人品牌',
    layout: '大号标题占据视觉中心偏上，副标题与小栏目字沿网格分布，人像若有则居中偏下、与标题有前后层次。',
    text: '粗黑体或高对比衬线体大标题，配一行细小的英文或编号点缀，一主色 + 一强调色。',
    effect: '有杂志刊头的编排秩序感，可有细线分栏与小标签。',
    mood: '高级、有态度、像一本刊物的封面。',
    recommendFor: ['观点', '盘点', '深度', '品牌', '创业', '商业', '时尚', '访谈', '个人品牌', '博主'],
    portraitFriendly: true,
  },
  {
    key: 'big-text-bg',
    name: '背景大字',
    hint: '超大字铺满背景、人物在前景压住字——人像出镜、口播、观点输出',
    layout: '标题以超大字号铺满背景（可局部被人物遮挡），人物在前景中下部，字与人前后层叠。',
    text: '超粗黑体、单一高饱和主色（橙 / 黄 / 红任选其一）或白字，字形完整、笔画粗壮。',
    effect: '人物边缘可有细描边或轻投影，与背景大字分离。',
    mood: '有冲击力、抓眼、口播感强。',
    forbid: '不要把大字放到完全看不清的位置；人物遮挡不能超过字的一半。',
    recommendFor: ['口播', '观点', '职场', '认知', '成长', '搞钱', '副业', '励志'],
    portraitFriendly: true,
  },
  {
    key: 'workplace-clean',
    name: '职场干净大字',
    hint: '白 / 奶黄大字 + 红色虚线或下划线装饰、办公场景——职场 / 效率 / 求职',
    layout: '人物或办公场景占画面下半，标题在上半部横排两到三行，关键词下面画一条红色手绘下划线或虚线框。',
    text: '白色或奶黄色粗黑体大字，关键词用红色或亮黄强调；副标题小一号白字。',
    effect: '轻微暗角让字更清楚，红色虚线 / 圈划作装饰。',
    mood: '专业、利落、可信。',
    recommendFor: ['职场', '效率', '求职', '面试', '简历', '管理', '办公', '打工', 'HR', '沟通'],
    portraitFriendly: true,
  },
  {
    key: 'tech-exec',
    name: '科技高管风',
    hint: '深色高级质感、金属光泽、冷静专业——科技 / AI / 金融 / 商业',
    layout: '深色背景，标题居中偏上，主体或抽象几何在下方，构图干净留白充足。',
    text: '银白或铂金色现代无衬线粗体，字距略宽；副标题小号浅灰。',
    effect: '近黑 / 深蓝黑背景配细腻金属光泽与微光渐变，蓝宝石色点缀。',
    mood: '专业、可信、冷静，有高管演讲 PPT 的高级感。',
    recommendFor: ['科技', 'AI', '人工智能', '金融', '投资', '商业', '数码', '程序', '互联网', '效率工具'],
  },
  {
    key: 'dark-glow',
    name: '深色发光',
    hint: '深底 + 黄色 / 霓虹发光大字，夜晚氛围——干货 / 揭秘 / 数码 / 游戏',
    layout: '深色（近黑 / 墨蓝）背景，发光标题居中或偏上，主体在下方或一侧。',
    text: '亮黄或霓虹色粗黑体，带柔和外发光；副标题白色细字。',
    effect: '文字外发光、局部光斑，背景保持干净。',
    mood: '有分量、神秘、像夜里点亮的招牌。',
    recommendFor: ['数码', '游戏', '揭秘', '干货', '科技', '电影', '夜', '摄影', '汽车'],
  },
  {
    key: 'neon-contrast',
    name: '霓虹撞色',
    hint: '荧光粉绿撞色、Y2K 潮流——潮流 / 娱乐 / 音乐 / 年轻向',
    layout: '大色块切分画面，标题斜排或错位排布，人物或主体贴纸化放在色块交界处。',
    text: '粗圆体或综艺体，荧光粉、荧光绿、亮蓝撞色，字有粗描边。',
    effect: 'Y2K 元素：星形、波浪线、像素点、光栅感，但控制数量。',
    mood: '年轻、张扬、有活力，抓眼球但主体与文字层级仍分明。',
    recommendFor: ['潮流', '娱乐', '音乐', '穿搭', '街拍', '综艺', '追星', '二次元', 'vlog', '大学生'],
    portraitFriendly: true,
  },
  {
    key: 'vibrant-trend',
    name: '高饱和潮流',
    hint: '高饱和撞色大色块、几何涂鸦——穿搭 / 娱乐 / 运动 / 活动预告',
    layout: '大色块背景，标题醒目居中偏上，主体在下方或一侧，几何或涂鸦元素点缀边角。',
    text: '粗黑体大标题，白字加色块底或深色字配亮色块。',
    effect: '高饱和撞色、活泼的几何 / 涂鸦元素。',
    mood: '年轻、有活力、抓眼球。',
    recommendFor: ['运动', '健身', '活动', '穿搭', '娱乐', '旅行', '美食', '探店'],
    portraitFriendly: true,
  },
  {
    key: 'note-handwrite',
    name: '便签手写风',
    hint: '手写体、便利贴 / 胶带贴纸、亲切随手记——清单 / 心得 / 避坑 / 日常',
    layout: '像贴在桌面的便利贴或手账页，标题在便签中央，四周有胶带、贴纸、小图标点缀。',
    text: '手写体标题，深色墨迹感，重点词可用荧光笔划过。',
    effect: '暖色纸张质感、胶带 / 贴纸 / 小涂鸦点缀。',
    mood: '亲切、随手记、有生活温度，版面依然清爽可读。',
    recommendFor: ['清单', '心得', '避坑', '日常', '手账', '读书', '学习', '记录', '整理'],
  },
  {
    key: 'split-tags',
    name: '分屏标签',
    hint: '上图下色块、标签式排版、黄蓝配色——测评 / 对比 / 教程步骤',
    layout: '画面上 60% 是主体或场景图，下 40% 是纯色块，标题写在色块里，旁边有 1-2 个圆角标签写关键词。',
    text: '色块里用粗黑体白字或深字，标签字小而粗。',
    effect: '黄 / 蓝或黑 / 黄等两色配，边界干脆。',
    mood: '清楚、条理、像信息卡。',
    recommendFor: ['测评', '对比', '教程', '步骤', '数码', '好物', '装修', '汽车'],
  },
  {
    key: 'cozy-home',
    name: '温馨居家',
    hint: '暖黄渐变字、椭圆高亮圈、家的场景——家居 / 收纳 / 美食 / 生活方式',
    layout: '居家或厨房场景为底，标题居中偏上，关键词用椭圆手绘圈高亮。',
    text: '黄白渐变或奶白色粗圆体，关键词圈上一层椭圆高亮。',
    effect: '暖光、浅景深、柔和阴影。',
    mood: '温暖、放松、有生活气。',
    recommendFor: ['家居', '收纳', '美食', '烘焙', '生活方式', '租房', '装修', '宠物', '早餐'],
  },
  {
    key: 'store-banner',
    name: '探店横幅',
    hint: '门店 / 场景照 + 横向色带标题、地址小字——探店 / 旅行 / 本地生活',
    layout: '门店或场景照铺满，画面中部或下部横一条色带，标题写在色带上，色带下方一行小字放地点 / 副标。',
    text: '色带上用粗黑体白字或深字，小字用细体。',
    effect: '色带用亮黄 / 红 / 白任选其一，色带边缘干净。',
    mood: '真实、可信、有现场感。',
    recommendFor: ['探店', '旅行', '本地', '美食', '咖啡', '打卡', '露营', '酒店', '景点'],
  },
  {
    key: 'checklist',
    name: '干货清单',
    hint: '编号清单式排版、大标题 + 3-5 条要点——盘点 / 合集 / 方法论',
    layout: '标题在上三分之一，下方竖排 3-5 条编号要点（每条一句短语），主体或图标在一侧。',
    text: '标题粗黑体，要点用中等字重、前置数字编号或勾选框。',
    effect: '浅底深字或深底浅字，编号用强调色。',
    mood: '有料、值得收藏。',
    forbid: '要点每条不超过 8 个字，不要写成段落。',
    recommendFor: ['盘点', '合集', '方法', '清单', '总结', '工具', '资源', '技巧'],
  },
  {
    key: 'collage-retro',
    name: '复古拼贴',
    hint: '撕纸边、胶带、复古滤镜、拼贴排版——摄影 / 旅行 / 情绪 / 电影',
    layout: '主体照片带撕纸边斜贴在画面上，标题在拼贴的空白区，小图或票根元素点缀。',
    text: '打字机体或复古衬线体标题，深色或做旧红。',
    effect: '复古颗粒滤镜、胶带、纸张与票根拼贴。',
    mood: '有故事感、怀旧、文艺。',
    recommendFor: ['摄影', '旅行', '情绪', '电影', '文艺', '音乐', '书', '胶片', '日记'],
    portraitFriendly: true,
  },
  {
    key: 'sticker-energy',
    name: '贴纸活力',
    hint: '人物抠图贴纸化、闪电星星装饰、粗描边——表情丰富的人像、搞笑、活动',
    layout: '人物抠图后加白色粗描边贴纸化放在画面一侧，标题在另一侧，闪电 / 星星 / 感叹号贴纸点缀。',
    text: '粗圆体或综艺体，亮色描边字。',
    effect: '贴纸风元素、少量动态线条。',
    mood: '活泼、有梗、表情包感。',
    recommendFor: ['搞笑', '段子', '活动', '直播', '带货', '综艺', '大学生', '校园'],
    portraitFriendly: true,
  },
];

export const DEFAULT_COVER_STYLE = COVER_STYLES[0].key;

export function coverStyle(key: string | undefined): CoverStyle {
  return COVER_STYLES.find((s) => s.key === key) ?? COVER_STYLES[0];
}

/** 把五块画面描述拼成一段（进图像提示词的【风格】段）。 */
export function styleDescription(style: CoverStyle): string {
  const parts = [
    `【布局】${style.layout}`,
    `【文字样式】${style.text}`,
    `【核心特效】${style.effect}`,
    `【氛围】${style.mood}`,
  ];
  if (style.forbid) parts.push(`【本风格禁止】${style.forbid}`);
  return parts.join('\n');
}

/**
 * 按人设赛道推荐：把命中 recommendFor 的风格排到前面并标 recommended。
 * `text` 是人设的 niche / tone / identity 拼起来的一段；空则原序、无推荐。
 */
export function rankStylesForPersona(text: string): { style: CoverStyle; recommended: boolean }[] {
  const t = (text ?? '').trim();
  const scored = COVER_STYLES.map((style, i) => {
    const hits = t ? style.recommendFor.filter((k) => t.includes(k)).length : 0;
    return { style, recommended: hits > 0, hits, i };
  });
  scored.sort((a, b) => b.hits - a.hits || a.i - b.i);
  return scored.map(({ style, recommended }) => ({ style, recommended }));
}

/** 给 UI 用的精简列表（不含长描述）。 */
export const COVER_STYLE_OPTIONS = COVER_STYLES.map((s) => ({
  key: s.key,
  name: s.name,
  hint: s.hint,
  portraitFriendly: !!s.portraitFriendly,
}));

// ── 字体倾向 ────────────────────────────────────────────────────────────
// 图像模型不认字体文件，只认「什么样的字」。所以这里不是 7 种真字体（外部站的做法），
// 而是几档给模型的文字描述；也因此**不做预览**——预览一张真字体渲染图再让模型出别的字，是撒谎。

export type CoverFont = { key: string; name: string; prompt: string };

export const COVER_FONTS: CoverFont[] = [
  { key: 'auto', name: '随风格', prompt: '' },
  { key: 'bold-hei', name: '大粗黑体', prompt: '标题用超粗黑体（类似思源黑体 Heavy），笔画粗壮、边缘干净、字形方正' },
  { key: 'variety', name: '综艺体', prompt: '标题用综艺感的粗圆体，字形略胖、有弹性、带粗描边' },
  { key: 'song', name: '稳重宋体', prompt: '标题用粗宋体（衬线体），笔画有粗细对比、稳重考究' },
  { key: 'round', name: '圆体', prompt: '标题用圆头黑体，笔画圆润、亲切柔和' },
  { key: 'handwrite', name: '手写体', prompt: '标题用自然的手写体，有笔触起伏、像马克笔或钢笔写的' },
  { key: 'calligraphy', name: '书法体', prompt: '标题用毛笔书法体，笔锋有力、墨迹感，但字形必须清晰可辨' },
];

export const DEFAULT_COVER_FONT = COVER_FONTS[0].key;

export function coverFont(key: string | undefined): CoverFont {
  return COVER_FONTS.find((f) => f.key === key) ?? COVER_FONTS[0];
}

/** 装饰点缀（可多选）：每项一句进提示词。 */
export const COVER_DECORS: { key: string; name: string; prompt: string }[] = [
  { key: 'stickers', name: '贴纸', prompt: '加少量贴纸元素（星星、闪电、感叹号）点缀' },
  { key: 'underline', name: '手绘圈划', prompt: '关键词下方或周围加手绘下划线 / 椭圆圈划' },
  { key: 'tape', name: '胶带 / 便签', prompt: '加胶带、便签纸这类手账元素' },
  { key: 'arrow', name: '箭头指引', prompt: '用一个手绘箭头指向主体或关键词' },
  { key: 'frame', name: '边框', prompt: '给画面加一圈手绘或几何边框' },
];

export function decorPrompts(keys: string[] | undefined): string[] {
  const set = new Set(keys ?? []);
  return COVER_DECORS.filter((d) => set.has(d.key)).map((d) => d.prompt);
}
