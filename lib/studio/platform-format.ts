import { PLATFORMS, platformName, type PlatformKey } from '../constants';
import { titleLengthRule } from './title';
import { stripStageLabels } from './two-stage';
import { stripMemoryTags } from '../memory/tags';

// 各平台的**成稿格式**（2026-09-15，用户：「点击起稿的内容效果没有很高，已经有对应的格式还有方案」）。
//
// 【此前的问题】初稿提示词里关于平台只有一句话（PLATFORM_STYLE 的一行形容），字数、标题、分段、
// 能不能用小标题/markdown/emoji、结尾怎么收，全靠模型自觉——于是每个平台出来的都是同一副
// 「### 小标题 + 📌【栏目】+ 分点 + 总结 + 欢迎评论区」的公众号腔，小红书编辑器里连 markdown 都不认。
// 平台的格式知识产品里本来就有（title.ts 的标题长度、humanize/score.ts 的口语平台判定、
// constants 的内容形态），只是从没一起喂给初稿。这里把它们拼成一份**可执行的格式说明**，
// 所有起稿入口（普通/流式/深度/工作流/派生）共用；改格式只改这一处。
//
// 【字数是方向性经验值，不是平台参数】口播稿按每分钟约 220 字折算；图文/文章按各平台常见完读长度。
// UI 与提示词里都不许说成「平台规定」（与 title.ts 同一约定）。

export type PlatformFormat = {
  /** 内容形态（与 constants.PLATFORMS.kind 一致） */
  kind: (typeof PLATFORMS)[PlatformKey]['kind'];
  /** 正文字数区间 */
  chars: [number, number];
  /** 第一行是不是标题（标题长度规则从 title.ts 取，不在这里另抄） */
  title: boolean;
  /** 允许小标题（用短句当小标题，仍然不用 markdown 的 #） */
  headings: boolean;
  /** emoji：none 一个不要 | sparse 一段最多一个、用来断句不是装饰 */
  emoji: 'none' | 'sparse';
  /** 单段字数上限 */
  paraMax: number;
  /** 话题标签怎么处理（空串 = 不要写） */
  hashtags: string;
  /** 结构与节奏（人话，给模型） */
  shape: string;
  /** 结尾怎么收 */
  ending: string;
  /** 语言（不写 = 跟人设/选题走） */
  language?: string;
};

export const PLATFORM_FORMAT: Record<PlatformKey, PlatformFormat> = {
  douyin: {
    kind: 'short_video', chars: [150, 450], title: false, headings: false, emoji: 'none', paraMax: 60, hashtags: '',
    shape: '口播稿：第一句就抛结果或冲突（前 3 秒决定划不划走），一件事讲透，全程口语短句、能一口气念出来；段落就是气口，每段一两句。',
    ending: '最后一句给一个让人想在评论里接话的点（具体的问题或一个反常识的判断），不要「点赞关注」三连式收尾。',
  },
  xiaohongshu: {
    kind: 'image_text', chars: [300, 800], title: true, headings: false, emoji: 'sparse', paraMax: 80, hashtags: '结尾另起一行放 3-6 个 #话题#，用空格分开',
    shape: '图文笔记：第一人称、真实体验感，分段短（每段一两句），关键信息前置；可以用「1.」「2.」这样的序号分点，但不要小标题、不要栏目名。',
    ending: '结尾一个具体到能回答的问题——问的是读者自己的处境，不是问他对这件事怎么看；不要「欢迎评论区留言」。',
  },
  wechat: {
    kind: 'article', chars: [800, 2000], title: true, headings: true, emoji: 'none', paraMax: 150, hashtags: '',
    shape: '公众号文章：观点先行，一个论点一层地推进，可以用 3-5 个短句小标题分层（小标题就是一句话，不加 #、不加编号、不加装饰符号）；有信息增量，保留专业度。',
    ending: '结尾一句立得住的判断或一句金句，不要「总结」、不要「以上就是」。',
  },
  bilibili: {
    kind: 'long_video', chars: [600, 1500], title: true, headings: true, emoji: 'none', paraMax: 120, hashtags: '',
    shape: '中长视频脚本：分章节推进（章节名就是一句短句），每章有信息增量，人格化叙述，适度玩梗但不失干货；写的是口播文本，不写分镜。',
    ending: '结尾回到开头抛的问题给出结论，最后一句留一个下期或评论区的钩子。',
  },
  shipinhao: {
    kind: 'short_video', chars: [200, 500], title: false, headings: false, emoji: 'none', paraMax: 60, hashtags: '',
    shape: '视频号口播稿：开头点明「对谁有用」，说人话不玩梗，观点完整、能被人复述给朋友；1-3 分钟。',
    ending: '结尾给一句值得转给朋友看的话，不要「点赞关注」。',
  },
  x: {
    kind: 'short_text', chars: [40, 280], title: false, headings: false, emoji: 'none', paraMax: 280, hashtags: '最多 1-2 个，放在结尾',
    shape: '推文：首句即观点，凝练犀利；超过 280 字符就拆成 thread（每条一段、各自成立、用空行分开），最多 6 条。',
    ending: '最后一条给结论或一个反问，不要「转发扩散」。',
  },
  youtube: {
    kind: 'long_video', chars: [800, 2000], title: true, headings: true, emoji: 'none', paraMax: 120, hashtags: '',
    shape: '长视频脚本：intro（30 秒内说清看完能得到什么）→ body（按章节推进，章节名一句话）→ outro；强调价值主张。',
    ending: 'outro 一句引导订阅即可，不要重复三次。',
  },
  tiktok: {
    kind: 'short_video', chars: [80, 300], title: false, headings: false, emoji: 'none', paraMax: 50, hashtags: '结尾 3-5 个 #tags',
    shape: '英文短视频口播稿：1 秒内给视觉钩子，句子短、主谓宾直给（观众多为非母语），全程不留可跳过的空段。',
    ending: '结尾给一句让人想转发的话，不是「follow for more」。',
    language: '英文',
  },
  weibo: {
    kind: 'short_text', chars: [100, 400], title: false, headings: false, emoji: 'sparse', paraMax: 120, hashtags: '1-2 个 #话题#，放句中或结尾',
    shape: '微博：第一句就是观点或事实，两三段说完；可以带情绪但要有具体所指。',
    ending: '结尾一句态度鲜明的话或一个能接话的问题。',
  },
  zhihu: {
    kind: 'article', chars: [800, 2500], title: true, headings: true, emoji: 'none', paraMax: 160, hashtags: '',
    shape: '知乎回答/文章：先给结论再展开，每个论点要有论据（经历、数据、案例，只用上下文里有的）；可以用短句小标题分层，不加 #。',
    ending: '结尾回扣结论，不要「以上」「希望对你有帮助」。',
  },
  toutiao: {
    kind: 'article', chars: [800, 1800], title: true, headings: true, emoji: 'none', paraMax: 120, hashtags: '',
    shape: '头条文章：事实 + 观点，段落短、信息密度高，可以用短句小标题分层，不加 #。',
    ending: '结尾给一句判断，不要「总结」。',
  },
  baijiahao: {
    kind: 'article', chars: [800, 1800], title: true, headings: true, emoji: 'none', paraMax: 120, hashtags: '',
    shape: '百家号文章：事实 + 观点，段落短、信息密度高，可以用短句小标题分层，不加 #。',
    ending: '结尾给一句判断，不要「总结」。',
  },
  kuaishou: {
    kind: 'short_video', chars: [150, 450], title: false, headings: false, emoji: 'none', paraMax: 60, hashtags: '',
    shape: '快手口播稿：直接、实在、像跟老铁说话，第一句就说事，一件事讲透，全程口语短句。',
    ending: '最后一句留一个让人想评论的点，不要「双击关注」式收尾。',
  },
};


// ─────────────── 每个平台的「走向」（2026-09-17）───────────────
//
// 用户第二次反馈：「就地起稿得内容，还是不符合各个平台的意思」。上面的 shape 字段是**形容**
// （「口播稿：第一句就抛结果」），模型读完仍然按它熟悉的那一套写——于是十四个平台出来的是
// 同一篇稿子换了字数。这里给的是**从第一句到最后一句怎么走**：一条一条能对着写、也能对着看。
//
// ⚠️ 这是走向，不是模板。所以每条骨架的最后一句都写着「别把每段写成一样长」——
// 一份固定骨架加上均匀的段落，等于换了个模板，那还是 AI 味（见 humanize/structure.ts）。
//
// ⚠️ **骨架里一句示例句都不许写**。第一版写过「中间留一处反转（「看着是赚钱，其实是在卖时间」）」，
// 真机第一稿模型就把那句话一字不差抄进了正文——它跟那条选题毫无关系。
// 本项目在「MiniMax 会抄占位符」上栽过同一跤：**提示词里出现的句子，模型就当它是可用的成品**。
// 所以这里只描述动作（「把大家默认的解释推翻一次」），不给句子。
export const PLATFORM_SKELETON: Record<PlatformKey, string[]> = {
  douyin: [
    '第一句：把这条选题里最硬的那个结果、数字或冲突直接砸出来，不要交代背景',
    '接下来三五句：这件事到底是怎么回事，一句一个信息，说完一件再说下一件',
    '中间留一处反常识或反转：把大家默认的那个解释推翻一次，再给出你的解释',
    '最后一句：一个具体到能被人接话的问题，或一句敢下的判断',
    '全程「我」「你」，不说「我们」；句子短到能一口气念完',
  ],
  xiaohongshu: [
    '标题：一句话说清「谁能得到什么」，可以带一个数字',
    '开头两句：一个具体场景，或一个直接的结论——不要「最近发现」「今天来分享」',
    '中间三到四段：一段一件事，短句，关键的信息放在每段的第一句',
    '其中要有一段是你自己的判断或踩过的坑（只用素材里真有的）',
    '结尾：一个具体到能回答的问题',
    '最后一行：3-6 个 #话题#',
    '段落长短不要一样，允许有一段只有一句话',
  ],
  wechat: [
    '标题：一句话，讲清这篇要解决什么',
    '第一段（不超过三句）：一件具体的事，或一个反常识的判断',
    '主体两到四层：每层一个论点 + 一个证据（经历、数字、案例，只用上下文里有的）',
    '其中一层要承认复杂性或反面意见，别一路顺着说',
    '结尾：一句立得住的判断，不做总结',
  ],
  bilibili: [
    '标题：说清这期讲什么，带一点态度',
    '开场 20 秒：抛出问题或悬念，说清看完能得到什么',
    '主体分三到四章：每章一句话章节名 + 一个新信息，章节之间有推进关系',
    '中间插一句人格化的吐槽或玩梗，但不要连着玩',
    '结尾：回答开场那个问题，再留一个下期的钩子',
  ],
  shipinhao: [
    '第一句：点明「这条对谁有用」',
    '中间：一个观点讲完整，讲到能被人复述给同事',
    '不用梗、不用网络黑话——这里靠熟人转发',
    '结尾：一句值得转给朋友的话',
  ],
  x: [
    '第一条就是结论，一句话说完，不要铺垫',
    '要展开就拆成 thread：每条一段、各自成立、用空行分开，最多 6 条',
    '每条里只放一个意思，不要把三件事塞进一条',
    '最后一条给判断或一个反问',
  ],
  youtube: [
    'intro（30 秒内）：说清看完能得到什么，给一个具体的承诺',
    'body：按章节推进，每章一句话章节名 + 一个新信息',
    '每隔一章给一次「所以这意味着什么」，别只堆信息',
    'outro：回扣承诺，一句引导订阅',
  ],
  tiktok: [
    'First line: the hook — a number, a claim, or a visual cue in under 1 second',
    'Then 3-5 short beats, one idea each, subject-verb-object',
    'No filler sentences anyone could skip',
    'Last line: something people want to send to a friend',
    'Finish with 3-5 #tags',
  ],
  weibo: [
    '第一句就是观点或事实，不要铺垫',
    '两三段说完，每段一个意思',
    '可以带情绪，但情绪要有具体所指（对着某件事，不是对着空气）',
    '结尾：一句态度鲜明的话，或一个能接话的问题',
  ],
  zhihu: [
    '第一段先给结论（读者不会等你铺垫）',
    '然后一条一条给论据：每个论点配一个经历、数字或案例',
    '其中一条要回应最常见的反对意见',
    '结尾：回扣结论，不写「以上」「希望有帮助」',
  ],
  toutiao: [
    '标题：说清一件事，别卖关子',
    '第一段：把最硬的事实放出来（时间、地点、数字）',
    '主体：短段落推进，一段一个信息，事实与观点分开说',
    '结尾：一句判断',
  ],
  baijiahao: [
    '标题：说清一件事，别卖关子',
    '第一段：把最硬的事实放出来（时间、地点、数字）',
    '主体：短段落推进，一段一个信息，事实与观点分开说',
    '结尾：一句判断',
  ],
  kuaishou: [
    '第一句直接说事，像跟熟人开口那样',
    '中间：一件事讲透，用大白话，别绕',
    '有实在的细节（多少钱、几点、在哪），没有就别编',
    '结尾：一句让人想在评论里搭话的话',
  ],
};

/**
 * 「本次硬指标」：给 user 消息用的一行。system 里的格式块会被长上下文稀释，
 * 而 user 消息离生成最近——字数、标题、标签这三样最容易被忘的，在这里再钉一次。
 */
export function platformHardSpec(platform: string): string {
  const f = platformFormat(platform);
  const bits = [`正文 ${f.chars[0]}-${f.chars[1]} 字`];
  if (f.title) {
    const r = titleLengthRule(platform);
    bits.push(`第一行标题 ${r.min}-${r.max} 字`);
  } else {
    bits.push('不要标题行');
  }
  bits.push(f.emoji === 'none' ? '不用 emoji' : 'emoji 一段最多一个');
  bits.push(f.hashtags ? `话题标签：${f.hashtags}` : '不要话题标签');
  if (f.language) bits.push(`用${f.language}写`);
  return bits.join('；');
}

export function platformFormat(platform: string): PlatformFormat {
  return PLATFORM_FORMAT[platform as PlatformKey] ?? PLATFORM_FORMAT.wechat;
}

/**
 * 给模型看的格式说明块。每一条都是可执行、可检查的（字数/标题长度/分段/标签/结尾），
 * 不是「贴合平台调性」这种模型无从下手的话。
 */
export function platformFormatBlock(platform: string): string {
  const f = platformFormat(platform);
  const name = platformName(platform);
  const kindName: Record<PlatformFormat['kind'], string> = {
    short_video: '短视频口播稿', image_text: '图文笔记', article: '文章', long_video: '中长视频脚本', short_text: '短文',
  };
  const lines: string[] = [`【目标平台的格式（${name} · ${kindName[f.kind]}）】`];
  if (f.title) {
    const r = titleLengthRule(platform);
    lines.push(`- 第一行是标题：${r.min}-${r.max} 字${r.hardMax ? `（上限 ${r.hardMax} 字，超出会被截断）` : ''}，${r.note}；标题不加书名号、不加 #、不加 emoji，标题下面空一行再写正文`);
  } else {
    lines.push('- 不要写标题行，第一句就是正文（标题/文案发布时另填）');
  }
  lines.push(`- 正文 ${f.chars[0]}-${f.chars[1]} 字${f.language ? `，用${f.language}写` : ''}；每段不超过 ${f.paraMax} 字，段与段之间空一行`);
  lines.push(
    f.headings
      ? '- 可以用短句小标题分层，但小标题就是一行普通文字：不用 #、不用 **、不用【】、不用编号、不用 emoji'
      : '- 不要小标题、不要栏目名（【xx】）、不要 markdown（#、**、---）：这个平台的编辑器只认纯文本，这些符号会原样露出来',
  );
  lines.push(f.emoji === 'none' ? '- 不用 emoji' : '- emoji 适量：一段最多一个，用来断句不是装饰，不要每段开头都摆一个');
  lines.push(f.hashtags ? `- 话题标签：${f.hashtags}` : '- 不要写话题标签');
  lines.push(`- 结构：${f.shape}`);
  lines.push(`- 结尾：${f.ending}`);
  const skeleton = PLATFORM_SKELETON[platform as PlatformKey];
  if (skeleton) {
    lines.push(`【${name}的稿子怎么走（这是走向不是模板：照着这个顺序写，但别把每段写成一样长）】`);
    skeleton.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  return lines.join('\n');
}

/**
 * 成稿清洗（确定性兜底）：提示词明令禁止了，模型照样会输出 markdown 与字段标签。
 * 能在代码里确定解决的就不指望模型听话——用户拿到的应该是能直接粘出去的东西。
 *   · 「### 标题：」「**正文：**」这类字段标签 → stripStageLabels（two-stage 已有）
 *   · markdown 小标题「## xx」→ 只留文字（允许小标题的平台保留为独立一行）
 *   · 「**加粗**」「__加粗__」→ 去掉星号
 *   · 分割线「---」「***」→ 删
 *   · **「【栏目名】」式标签行**（2026-09-17）→ 允许小标题的平台去掉方括号留文字；
 *     不允许小标题的平台**整行删掉**——那一行本来就只是个模板标签，信息在它下面那段里
 *   · **口播稿里的 emoji**（2026-09-17）→ 全删。短视频/长视频脚本是念出来的，
 *     emoji 念不出来，留在稿子里只会被主播当成提示符念漏或念错
 *   · 三个以上连续空行 → 两个；行尾空白 → 去掉
 *
 * 不动列表序号、不动 #话题#（那是平台自己的语法，不是 markdown）、不动字数与标签数量
 * ——那几样改不对会丢信息，交给 format-check 报出来、由修复那一次调用去改。
 */
export function tidyDraft(content: string, platform?: string): string {
  const f = platformFormat(platform ?? 'wechat');
  const spoken = f.kind === 'short_video' || f.kind === 'long_video';
  // 记忆行标注（「[偏好记忆 · 1个月前] 喜欢短句」）：真机 2026-09-17 用 MiniMax 起稿，
  // 模型把注入的那一行**原样当成正文写了进去**。选题理由那边 2026-07-30 就栽过同一跤、
  // 也早就有 stripMemoryTags 了，只是起稿这条链路从来没接上（见 lib/memory/tags.ts 的长注释：
  // 这类约束靠提示词是概率性的，靠代码才是确定的）。
  const base = stripMemoryTags(stripStageLabels(content ?? ''));
  // 「第一行是标题」的平台上，标题本身常被模型写成「【1.2 元睡 2.5 小时】」。
  // 它是标题不是栏目标签，**不能当模板标签删掉**——删了整篇就没标题了。
  let seenContent = false;
  const out = base
    .split('\n')
    .map((line) => {
      const heading = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
      let l = heading ? heading[1] : line;
      if (/^\s*([-*_]\s*){3,}$/.test(l)) return '';
      l = l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
      // 「📌【目标客群：谁会来？】」这类整行标签
      const label = l.match(/^\s*(?:\p{Extended_Pictographic}\uFE0F?\s*)*【([^】\n]{1,40})】\s*[:：]?\s*$/u);
      if (label) {
        const isTitleLine = f.title && !seenContent;
        if (!isTitleLine && !f.headings) return '\u0000DROP';
        l = label[1];
      }
      if (spoken) l = stripEmoji(l);
      l = l.replace(/[ \t]+$/g, '');
      if (l.trim()) seenContent = true;
      return l;
    })
    .filter((l) => l !== '\u0000DROP')
    .join('\n');
  return mergeEmojiOnlyLines(out)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * emoji 独占一行 → 并回上一行。
 *
 * 真机 2026-09-17（MiniMax 写小红书）：每段结尾都另起一行摆一个「😲」「💡」「💰」。
 * 那不是分段，是模型的装饰习惯——它会让格式体检把这几行当成「伪小标题」，
 * 也会让稿子粘到小红书编辑器里多出一堆空行。emoji 本身留着（图文平台真人也用），
 * 只是让它回到上一句话后面；上面没有句子可并就整行删掉。
 */
function mergeEmojiOnlyLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const onlyEmoji = (l: string) => {
    const t = l.trim();
    if (!t) return false;
    return t.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\s]/gu, '').length === 0;
  };
  for (const line of lines) {
    if (!onlyEmoji(line)) { out.push(line); continue; }
    // 往回找最近一行有字的，把 emoji 贴在它后面
    let i = out.length - 1;
    while (i >= 0 && !out[i].trim()) i--;
    if (i >= 0) out[i] = `${out[i].trimEnd()} ${line.trim()}`;
    // 找不到就丢掉这一行（开头就摆一个 emoji 的情况）
  }
  return out.join('\n');
}

/** 去掉 emoji 与它留下的多余空格（口播稿专用，见 tidyDraft） */
function stripEmoji(line: string): string {
  return line
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .replace(/[ \t]{2,}/g, ' ');
}
