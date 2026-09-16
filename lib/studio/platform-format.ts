import { PLATFORMS, platformName, type PlatformKey } from '../constants';
import { titleLengthRule } from './title';
import { stripStageLabels } from './two-stage';

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
    ending: '结尾一个具体到能回答的问题（比如「你们午休一般去哪」），不要「欢迎评论区留言」。',
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
  return lines.join('\n');
}

/**
 * 成稿清洗（确定性兜底）：提示词明令禁止了，模型照样会输出 markdown 与字段标签。
 * 能在代码里确定解决的就不指望模型听话——用户拿到的应该是能直接粘出去的东西。
 *   · 「### 标题：」「**正文：**」这类字段标签 → stripStageLabels（two-stage 已有）
 *   · markdown 小标题「## xx」→ 只留文字（允许小标题的平台保留为独立一行；不允许的平台也只能保留文字，删掉会丢信息）
 *   · 「**加粗**」「__加粗__」→ 去掉星号
 *   · 分割线「---」「***」→ 删
 *   · 三个以上连续空行 → 两个
 * 不动列表序号、不动 #话题#（那是平台自己的语法，不是 markdown）。
 */
export function tidyDraft(content: string, _platform?: string): string {
  const base = stripStageLabels(content ?? '');
  const out = base
    .split('\n')
    .map((line) => {
      const heading = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
      if (heading) return heading[1];
      if (/^\s*([-*_]\s*){3,}$/.test(line)) return '';
      return line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}
