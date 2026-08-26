// 派发卡上的授权分组。**纯数据、零依赖**——客户端组件要 import 它。
//
// 【为什么按后果分三组，而不是列 14 行工具名】
// 通用助手下会改数据或花钱的工具有十四个。把它们逐行摆出来让人勾，结果只会是两极：
// 多数人直接点「授权并开跑」（清单沦为橡皮图章），少数人被吓住全不勾
// （等于还是逐条确认，还多了一步）。两种都让这层设计形同虚设。
//
// 按**后果**分组就不一样了：「改我的内容」「花我的额度」「排任务与签合约」
// 这三句话，创作者一眼能判断自己愿不愿意。逐个工具仍然看得到，收在展开里。

export type AuthGroupKey = 'content' | 'spend' | 'commit';

export type AuthGroup = {
  key: AuthGroupKey;
  /** 组名，就是那句后果 */
  name: string;
  /** 一句话说清勾了它会发生什么 */
  hint: string;
  /** 缺省勾不勾 */
  defaultOn: boolean;
};

export const AUTH_GROUPS: AuthGroup[] = [
  {
    key: 'content',
    name: '改我的内容',
    hint: '建草稿、存新版本、加对标账号、收藏文章。改的都是你自己的内容，可以回退。',
    defaultOn: true,
  },
  {
    key: 'spend',
    name: '花我的额度',
    hint: '跑选题推荐、采数据、跑技能、出封面、开智囊团会诊。这些会消耗 AI 调用额度。',
    defaultOn: true,
  },
  {
    key: 'commit',
    // 这一组的共同点是**影响不止这一次任务**
    name: '排任务与签合约',
    hint: '建发布计划、写进长期记忆、配定时、拼新智能体。这些做完之后会一直生效，所以默认仍然逐个问你。',
    defaultOn: false,
  },
];

/**
 * 一个工具归哪一组。
 *
 * 【为什么是函数不是常量表】新加工具时忘了登记的话，落到 spend 组（默认勾上）就太松了。
 * 这里按「有没有 contract 标记 / 花不花钱」现算——**新工具自动落到正确的组**，
 * 不依赖任何人记得来这里补一行。
 */
export function groupOf(tool: { name: string; costly?: boolean; contract?: boolean }): AuthGroupKey {
  if (tool.contract) return 'commit';
  if (tool.costly) return 'spend';
  return 'content';
}

/** 勾了哪几组 → 具体授权哪些工具。 */
export function toolsForGroups(
  tools: readonly { name: string; costly?: boolean; contract?: boolean }[],
  groups: readonly AuthGroupKey[],
): string[] {
  return tools.filter((t) => groups.includes(groupOf(t))).map((t) => t.name);
}
