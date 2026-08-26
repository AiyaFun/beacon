import type { WorkflowStep } from './steps';

// 内置工作流模板。三条现实中最常跑的流水线，装上即用。
//
// 【为什么内置的第一条不是「全自动一条龙」】把选题→初稿→技能→封面→配图→发布六步全串上，
// 一次点击就是六次付费调用，而中间任何一步不满意都得整条重来。所以内置模板刻意做小：
// 一条 3-4 步、跑完就有可用产物，用户自己想串更长的，模板市场里可以自建。

export type BuiltinWorkflow = {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  /**
   * 职责说明：**写给模型看的**「什么时候该派我上」。
   *
   * 内置模板必须自带它。用户改不了内置模板（要改先复制成自建的），
   * 所以留空就等于「AI 永远派不了任何一个内置智能体」——开箱即用的那三条全成了摆设。
   * 写法要点：说**触发场景**（用户可能怎么开口），不要夸能力。
   */
  persona: string;
  /**
   * 跑之前得先有什么。空 = 装上就能直接跑。
   *
   * 【为什么需要它】「小红书日更三件套」的第一步是**从最高分选题写初稿**，
   * 而新账号一条选题都没有——用户装上、点「跑一遍」，第一步就撞
   * 「没有可用选题」。三条内置模板里有两条是这样。
   * 那句失败信息虽然指了路，但用户是在**花了一次点击之后**才知道的；
   * 而这件事在他点之前就该写在卡片上。
   */
  requires?: string;
  steps: WorkflowStep[];
};

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  {
    slug: 'daily-xhs',
    name: '小红书日更三件套',
    description: '从最高分选题写初稿 → 小红书风格改写 → 出封面。跑完就有一篇能发的笔记。',
    persona: '要发小红书笔记时派我。用户说「今天的小红书」「写篇小红书」「日更一条」都算。我会挑分最高的选题起稿、按小红书的调性改写、再出一张 3:4 封面。**要求先有一条可用选题**——没有的话让用户先跑一轮选题推荐，或改派「选题 → 图文组图」。',
    requires: '先得有一条可用选题（去「选题引擎」跑一轮推荐或采纳一条）。没有的话用「选题 → 图文组图」，那条自己会先跑选题。',
    emoji: '📕',
    category: 'daily',
    steps: [
      { kind: 'draft', platform: 'xiaohongshu' },
      // slug 必须是**真实存在的内置技能**（prisma/system-data.ts 的 BUILTIN_SKILLS）。
      // 这里曾经写成 'xhs-note'——库里根本没有这条，于是内置的第一条模板第二步
      // 每次都停在「找不到技能」，而模板本身看起来一切正常。
      // tests/workflow/market.test.ts 有守卫逐条核对，别再凭印象写 slug。
      { kind: 'skill', slug: 'xhs-format' },
      { kind: 'cover', specKey: 'xhs-3-4' },
    ],
  },
  {
    slug: 'wechat-longform',
    name: '公众号长文流水线',
    description: '写初稿 → 公众号排版 → 出头图，然后建一份公众号发布计划（发不发你自己决定）。',
    persona: '要出公众号长文时派我。用户说「写篇公众号」「长文」「推文准备一下」都算。我会起稿、按公众号排版、出头图，最后建好发布计划——真正发出去仍然要用户自己点。**要求先有一条可用选题**。',
    requires: '先得有一条可用选题（去「选题引擎」跑一轮推荐或采纳一条）。没有的话用「选题 → 图文组图」，那条自己会先跑选题。',
    emoji: '📰',
    category: 'daily',
    steps: [
      { kind: 'draft', platform: 'wechat' },
      { kind: 'skill', slug: 'wechat-format' },
      { kind: 'cover', specKey: 'wechat-235-1' },
      { kind: 'publish', platforms: ['wechat'] },
    ],
  },
  {
    slug: 'topic-to-carousel',
    name: '选题 → 图文组图',
    description: '先跑一轮选题推荐，再按最高分那条写稿，最后拆出一组风格统一的配图。',
    persona: '没想好写什么、要连选题一起搞定时派我。用户说「不知道写啥」「来一组图文」「帮我从头做一条」都算。我会先跑一轮选题推荐再起稿配图。',
    emoji: '🖼️',
    category: 'weekly',
    steps: [
      { kind: 'topic', count: 6 },
      { kind: 'draft', platform: 'xiaohongshu' },
      { kind: 'illustration', count: 4 },
    ],
  },
];
