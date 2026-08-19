// AI 味词库：中文大模型写作的**稳定指纹**词表（与敏感词库是两回事，别混）。
//
// ─────────────── 为什么单开一份，不塞进 SensitiveWord ───────────────
// 敏感词库回答的是「这句话能不能发」（法律/平台风险，命中有 block/warn 语义、要能被运营热更）。
// 这份词库回答的是「这句话像不像人写的」——它没有合规语义，命中不该拦任何东西，
// 只该被展示成「这里有股 AI 腔，考虑换个说法」。两者混在一张表里，迟早有人把套话当违规拦掉。
//
// 放在代码里而不是库里，还有一个实际理由：它需要跟着模型的文风漂移持续调整，
// 走代码评审比走后台改词更能留下「为什么加这个词」的记录。
//
// ─────────────── 一条纪律：不要把平台真实用语当 AI 味 ───────────────
// 「码住」「建议收藏」「姐妹们」在小红书是真人天天在用的话，不是 AI 腔。
// 收词标准是「人很少这么说、但模型极爱这么写」，不是「看起来俗」。宁可漏，不可错杀——
// 错杀会让用户把自己真实的口头禅改掉，那是在帮倒忙。

export type AiFlavorCategory = 'opener' | 'transition' | 'jargon' | 'closing' | 'officialese' | 'declare';

export const AI_FLAVOR_CATEGORY_LABEL: Record<AiFlavorCategory, string> = {
  opener: '开场套话',
  transition: '过渡套话',
  jargon: '空心黑话',
  closing: '结尾套话',
  officialese: '公文腔',
  declare: '结构宣告',
};

export type AiFlavorEntry = {
  word: string;
  category: AiFlavorCategory;
  // 权重：3=几乎只有模型这么写，命中一次就该改；2=人也会写但密度一高就露馅；1=轻微，只在扎堆时计分
  weight: 1 | 2 | 3;
  suggestion: string;
};

// 按类别分组维护，导出时展平——加词时能一眼看出这类已经收了什么。
const OPENER: AiFlavorEntry[] = [
  { word: '在这个信息爆炸的时代', category: 'opener', weight: 3, suggestion: '删掉，直接说事' },
  { word: '在当今社会', category: 'opener', weight: 3, suggestion: '删掉' },
  { word: '在当今这个', category: 'opener', weight: 3, suggestion: '删掉' },
  { word: '随着社会的发展', category: 'opener', weight: 3, suggestion: '删掉' },
  { word: '随着时代的发展', category: 'opener', weight: 3, suggestion: '删掉' },
  { word: '随着科技的不断进步', category: 'opener', weight: 3, suggestion: '删掉' },
  { word: '众所周知', category: 'opener', weight: 3, suggestion: '删掉；真众所周知就不用说了' },
  { word: '不可否认', category: 'opener', weight: 2, suggestion: '删掉' },
  { word: '毋庸置疑', category: 'opener', weight: 3, suggestion: '删掉' },
  { word: '相信很多人都', category: 'opener', weight: 2, suggestion: '换成一个具体的人或场景' },
  { word: '相信大家都', category: 'opener', weight: 2, suggestion: '换成一个具体的人或场景' },
  { word: '相信不少人', category: 'opener', weight: 2, suggestion: '换成一个具体的人或场景' },
  { word: '想必大家都', category: 'opener', weight: 2, suggestion: '换成一个具体的人或场景' },
  { word: '说到这里', category: 'opener', weight: 1, suggestion: '多半可以直接删' },
  { word: '提到这个话题', category: 'opener', weight: 2, suggestion: '直接进话题' },
  { word: '你是否也曾', category: 'opener', weight: 2, suggestion: '换成你自己真实经历过的那一次' },
  { word: '你有没有发现', category: 'opener', weight: 1, suggestion: '用具体细节代替提问式开场' },
  { word: '近年来', category: 'opener', weight: 1, suggestion: '给个具体时间（去年 / 今年三月）' },
  { word: '如今', category: 'opener', weight: 1, suggestion: '给个具体时间' },
];

const TRANSITION: AiFlavorEntry[] = [
  { word: '值得注意的是', category: 'transition', weight: 3, suggestion: '删掉，把后面那句直接说出来' },
  { word: '需要指出的是', category: 'transition', weight: 3, suggestion: '删掉' },
  { word: '需要强调的是', category: 'transition', weight: 3, suggestion: '删掉' },
  { word: '不难看出', category: 'transition', weight: 3, suggestion: '删掉' },
  { word: '由此可见', category: 'transition', weight: 3, suggestion: '删掉' },
  { word: '综上所述', category: 'transition', weight: 3, suggestion: '删掉' },
  { word: '总而言之', category: 'transition', weight: 3, suggestion: '换成一句你自己的结论' },
  { word: '总的来说', category: 'transition', weight: 2, suggestion: '换成一句你自己的结论' },
  { word: '归根结底', category: 'transition', weight: 2, suggestion: '换成一句你自己的结论' },
  { word: '换句话说', category: 'transition', weight: 2, suggestion: '一次说清就不用换句话说' },
  { word: '也就是说', category: 'transition', weight: 1, suggestion: '一次说清就不用重述' },
  { word: '与此同时', category: 'transition', weight: 2, suggestion: '换成「同时」或直接分句' },
  { word: '更重要的是', category: 'transition', weight: 1, suggestion: '扎堆出现时删掉一半' },
  { word: '事实上', category: 'transition', weight: 1, suggestion: '扎堆出现时删掉一半' },
  { word: '一方面', category: 'transition', weight: 1, suggestion: '双面论述连用会很像论文' },
  { word: '另一方面', category: 'transition', weight: 1, suggestion: '双面论述连用会很像论文' },
  { word: '因此', category: 'transition', weight: 1, suggestion: '口语里更常说「所以」' },
  { word: '此外', category: 'transition', weight: 1, suggestion: '口语里更常说「另外」或直接分段' },
  { word: '然而', category: 'transition', weight: 1, suggestion: '口语里更常说「但是」「可是」' },
];

const JARGON: AiFlavorEntry[] = [
  { word: '赋能', category: 'jargon', weight: 3, suggestion: '说清到底帮了什么忙' },
  { word: '抓手', category: 'jargon', weight: 3, suggestion: '说清具体做哪件事' },
  { word: '闭环', category: 'jargon', weight: 2, suggestion: '说清哪一步接哪一步' },
  { word: '顶层设计', category: 'jargon', weight: 3, suggestion: '说清谁定的什么规矩' },
  { word: '底层逻辑', category: 'jargon', weight: 2, suggestion: '直接把那个道理说出来' },
  { word: '方法论', category: 'jargon', weight: 1, suggestion: '多数时候「做法」就够了' },
  { word: '生态位', category: 'jargon', weight: 3, suggestion: '说清跟谁抢、抢什么' },
  { word: '差异化竞争', category: 'jargon', weight: 2, suggestion: '说清你哪里不一样' },
  { word: '深度赋能', category: 'jargon', weight: 3, suggestion: '删掉' },
  { word: '全方位', category: 'jargon', weight: 2, suggestion: '列出到底是哪几方面' },
  { word: '多维度', category: 'jargon', weight: 2, suggestion: '列出到底是哪几个维度' },
  { word: '深层次', category: 'jargon', weight: 2, suggestion: '说清深在哪' },
  { word: '系统性地', category: 'jargon', weight: 2, suggestion: '删掉这个副词' },
  { word: '有效地', category: 'jargon', weight: 1, suggestion: '删掉这个副词' },
  { word: '极大地', category: 'jargon', weight: 2, suggestion: '给个具体数字' },
  { word: '显著提升', category: 'jargon', weight: 2, suggestion: '给个具体数字' },
  { word: '大幅提升', category: 'jargon', weight: 1, suggestion: '给个具体数字' },
  { word: '核心要义', category: 'jargon', weight: 3, suggestion: '直接说那件事' },
  { word: '深度剖析', category: 'jargon', weight: 2, suggestion: '删掉，让内容自己证明深度' },
  { word: '一一为你揭晓', category: 'jargon', weight: 3, suggestion: '删掉' },
  { word: '干货满满', category: 'jargon', weight: 1, suggestion: '让读者自己下这个判断' },
];

const CLOSING: AiFlavorEntry[] = [
  { word: '让我们一起', category: 'closing', weight: 3, suggestion: '换成对读者说的一句具体的话' },
  { word: '让我们共同', category: 'closing', weight: 3, suggestion: '换成对读者说的一句具体的话' },
  { word: '希望这篇文章对你有帮助', category: 'closing', weight: 3, suggestion: '换成一句只有你会说的收尾' },
  { word: '希望对你有所帮助', category: 'closing', weight: 3, suggestion: '换成一句只有你会说的收尾' },
  { word: '希望能够帮助到你', category: 'closing', weight: 3, suggestion: '换成一句只有你会说的收尾' },
  { word: '与君共勉', category: 'closing', weight: 3, suggestion: '换成一句只有你会说的收尾' },
  { word: '共勉', category: 'closing', weight: 2, suggestion: '换成一句只有你会说的收尾' },
  { word: '最后送给大家一句话', category: 'closing', weight: 3, suggestion: '删掉这句铺垫' },
  { word: '愿你我', category: 'closing', weight: 2, suggestion: '换个说法' },
  { word: '未来可期', category: 'closing', weight: 3, suggestion: '删掉' },
  { word: '值得每个人深思', category: 'closing', weight: 3, suggestion: '删掉；让读者自己深思' },
  { word: '你怎么看？欢迎在评论区留言', category: 'closing', weight: 2, suggestion: '换成一个具体到能回答的问题' },
];

const OFFICIALESE: AiFlavorEntry[] = [
  { word: '进一步', category: 'officialese', weight: 1, suggestion: '删掉' },
  { word: '切实', category: 'officialese', weight: 2, suggestion: '删掉' },
  { word: '扎实推进', category: 'officialese', weight: 3, suggestion: '说清做了什么' },
  { word: '持续发力', category: 'officialese', weight: 3, suggestion: '说清做了什么' },
  { word: '保驾护航', category: 'officialese', weight: 3, suggestion: '说清帮了什么' },
  { word: '助力', category: 'officialese', weight: 2, suggestion: '换成「帮」' },
  { word: '加持', category: 'officialese', weight: 2, suggestion: '说清加了什么' },
  { word: '背书', category: 'officialese', weight: 1, suggestion: '说清谁替你担保了什么' },
  { word: '强强联合', category: 'officialese', weight: 3, suggestion: '删掉' },
  { word: '打造', category: 'officialese', weight: 1, suggestion: '换成「做」' },
  { word: '精心打造', category: 'officialese', weight: 3, suggestion: '换成「做」' },
  { word: '倾力', category: 'officialese', weight: 2, suggestion: '删掉' },
  { word: '重磅', category: 'officialese', weight: 1, suggestion: '删掉' },
];

const DECLARE: AiFlavorEntry[] = [
  { word: '接下来我将', category: 'declare', weight: 3, suggestion: '删掉，直接开始讲' },
  { word: '接下来我们来看', category: 'declare', weight: 3, suggestion: '删掉，直接开始讲' },
  { word: '下面我们来看', category: 'declare', weight: 3, suggestion: '删掉，直接开始讲' },
  { word: '让我们深入探讨', category: 'declare', weight: 3, suggestion: '删掉，直接开始讲' },
  { word: '我们不妨来', category: 'declare', weight: 2, suggestion: '删掉，直接开始讲' },
  { word: '本文将从', category: 'declare', weight: 3, suggestion: '删掉；读者不关心你的目录' },
  { word: '本文将为你', category: 'declare', weight: 3, suggestion: '删掉' },
  { word: '在开始之前', category: 'declare', weight: 2, suggestion: '删掉' },
  { word: '话不多说', category: 'declare', weight: 1, suggestion: '真不多说就直接开始' },
];

// 模糊量词：JARGON 里「极大地 / 显著提升 / 大幅提升」的同族补漏。
// 共同特征是**说了等于没说、也没法核验**——「有所提升」提了多少、「不少用户」到底几个人，
// 读者读完得不到任何新信息，所以 suggestion 一律是「给个数字」。
//
// 这一族没有 weight 3：这些话真人也在写（写周报、写产品更新都会用），
// 问题出在「不给数字」而不是「只有模型这么说」。按文件开头那条纪律，拿不准就往低了给。
//
// 为什么单列一个数组、而且排在展平顺序的最末（不是紧跟 JARGON）：
// aiFlavorBanBlock 是按数组顺序截前 60 条的，而 weight≥2 的词早就超过 60 了。
// 把这十几条插进 JARGON 后面，会把后面 CLOSING/OFFICIALESE 那批 weight 3 的词
// （「希望这篇文章对你有帮助」「未来可期」「扎实推进」…）整体挤出给 LLM 的禁用词表——
// 那批是「几乎只有模型这么写」，比这批更该禁。排在最末：内联高亮和人味分照常吃到，
// 禁用词表一个字不变。tests/humanize/lexicon.test.ts 有守卫钉住这件事。
const VAGUE_QUANTIFIER: AiFlavorEntry[] = [
  { word: '有所提升', category: 'jargon', weight: 2, suggestion: '给个具体数字（从多少到多少）' },
  { word: '有所改善', category: 'jargon', weight: 2, suggestion: '给个具体数字（从多少到多少）' },
  { word: '明显提升', category: 'jargon', weight: 2, suggestion: '给个具体数字' },
  { word: '明显改善', category: 'jargon', weight: 2, suggestion: '给个具体数字' },
  { word: '显著改善', category: 'jargon', weight: 2, suggestion: '给个具体数字' },
  { word: '显著降低', category: 'jargon', weight: 2, suggestion: '给个具体数字（降了多少）' },
  { word: '大幅下降', category: 'jargon', weight: 1, suggestion: '给个具体数字（降了多少）' },
  { word: '大大提高', category: 'jargon', weight: 2, suggestion: '给个具体数字' },
  { word: '大大缩短', category: 'jargon', weight: 2, suggestion: '给个具体数字（从几分钟到几分钟）' },
  { word: '效果很好', category: 'jargon', weight: 2, suggestion: '说清好在哪、好多少' },
  { word: '效果显著', category: 'jargon', weight: 2, suggestion: '说清好在哪、好多少' },
  { word: '好评如潮', category: 'jargon', weight: 2, suggestion: '引一条真实评价，或给个评分和条数' },
  { word: '相当可观', category: 'jargon', weight: 2, suggestion: '给个具体数字' },
  { word: '不少用户', category: 'jargon', weight: 2, suggestion: '给个人数或占比；只有一个人就直接说是谁' },
  { word: '数不胜数', category: 'jargon', weight: 2, suggestion: '给个数量，或干脆只举一个例子' },
  { word: '层出不穷', category: 'jargon', weight: 2, suggestion: '给个数量或频率（今年出了几个）' },
  { word: '一定程度上', category: 'jargon', weight: 2, suggestion: '说清是哪一部分，说不清就删掉这个限定' },
  { word: '某种程度上', category: 'jargon', weight: 2, suggestion: '说清是哪一部分，说不清就删掉这个限定' },
];

// 空心黑话/模糊量词这一类**必须逐条保持词级**，一条能横跨整句的词条会把同句里别的命中吃掉。
// 编辑器的内联标注是「按起点贪心、互不重叠」合并的（app/(app)/studio/Rewriter.tsx 的
// `if (m.start < cursor) continue`）：句级区间先占位，同句的合规命中——包括 tier=block 的
// 禁用词——就再也画不出来，用户会以为这句没有合规问题。宁可漏掉一个套话，也不能让合规标注消失。
// 上限取 6 个汉字：短语与半句话的分界，既有的黑话最长也就到这（「一一为你揭晓」）。
// 开场/结尾套话是整句模板（「你怎么看？欢迎在评论区留言」），本来就长，不受这条约束——
// 它们出现在句首句尾，跟句中的合规词很少同区间。
export const JARGON_MAX_WORD_LEN = 6;

export const AI_FLAVOR_LEXICON: AiFlavorEntry[] = [
  ...OPENER, ...TRANSITION, ...JARGON, ...CLOSING, ...OFFICIALESE, ...DECLARE, ...VAGUE_QUANTIFIER,
];

export type AiFlavorHit = {
  word: string;
  category: AiFlavorCategory;
  weight: 1 | 2 | 3;
  suggestion: string;
  start: number;
  end: number;
};

// 扫描套话命中（带位置，供编辑器高亮）。
//
// 长词优先：先扫「随着社会的发展」再扫「随着」，命中区间重叠时只保留更长的那条——
// 否则同一处会同时报两条，用户以为有两个问题。
export function scanAiFlavor(text: string): AiFlavorHit[] {
  const body = text ?? '';
  if (!body) return [];
  const sorted = [...AI_FLAVOR_LEXICON].sort((a, b) => b.word.length - a.word.length);
  const taken: Array<[number, number]> = [];
  const hits: AiFlavorHit[] = [];
  const overlaps = (s: number, e: number) => taken.some(([ts, te]) => s < te && ts < e);

  for (const entry of sorted) {
    let from = 0;
    for (;;) {
      const idx = body.indexOf(entry.word, from);
      if (idx < 0) break;
      const end = idx + entry.word.length;
      if (!overlaps(idx, end)) {
        taken.push([idx, end]);
        hits.push({ ...entry, start: idx, end });
      }
      from = idx + 1;
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// 给 LLM 的负面清单：只列权重 3 与 2 的词（权重 1 的词人也常用，写进禁令会把稿子改得别扭）。
// 截断到 60 条以内——prompt 里的禁令一长，模型的注意力反而会被这张表本身占满。
export function aiFlavorBanBlock(limit = 60): string {
  const words = AI_FLAVOR_LEXICON.filter((e) => e.weight >= 2).map((e) => e.word).slice(0, limit);
  return [
    '【禁用词表：以下是大模型写作的典型套话，一个都不要出现】',
    words.join('、'),
    '需要表达这些意思时，用具体的人、事、数字、时间来代替；说不出具体的就删掉整句，不要换个同义的套话。',
  ].join('\n');
}
