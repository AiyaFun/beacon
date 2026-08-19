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
  steps: WorkflowStep[];
};

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  {
    slug: 'daily-xhs',
    name: '小红书日更三件套',
    description: '从最高分选题写初稿 → 小红书风格改写 → 出封面。跑完就有一篇能发的笔记。',
    emoji: '📕',
    category: 'daily',
    steps: [
      { kind: 'draft', platform: 'xiaohongshu' },
      { kind: 'skill', slug: 'xhs-note' },
      { kind: 'cover', specKey: 'xhs-3-4' },
    ],
  },
  {
    slug: 'wechat-longform',
    name: '公众号长文流水线',
    description: '写初稿 → 公众号排版 → 出头图，然后建一份公众号发布计划（发不发你自己决定）。',
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
    emoji: '🖼️',
    category: 'weekly',
    steps: [
      { kind: 'topic', count: 6 },
      { kind: 'draft', platform: 'xiaohongshu' },
      { kind: 'illustration', count: 4 },
    ],
  },
];
