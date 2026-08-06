import { platformName } from '../constants';

// 技能运行参数（参数卡）：**这一次**想要什么。
//
// 与账号长期上下文（context）严格分开，理由见 lib/skills/render.ts：
// context 是「这个账号一直是什么样」，brief 是「这一次想要什么」。混成一个，
// 用户改一次篇幅就会把账号长期设定一起冲掉。
//
// 放在 lib 而不是 studio/actions.ts：那是个 'use server' 文件，里面的每个导出
// 都必须是 async 函数（Next 的硬约束），同步纯函数塞进去会在 build 时炸。

export type SkillBrief = {
  /** 目标平台（默认取草稿平台）。技能本身也有 platform，跨平台运行时以这里为准 */
  platform?: string;
  /** 篇幅档：short=更短 / keep=不限 / long=更充分 */
  length?: 'short' | 'keep' | 'long';
  /** 语气微调：calm=更克制 / keep=保持 / punchy=更冲 */
  tone?: 'calm' | 'keep' | 'punchy';
  /** 本篇要重点引用的素材 id（素材库里选的，不选就按账号上下文里的整体素材来） */
  materialIds?: string[];
  /** 用户自己补的一句话要求 */
  extra?: string;
};

const LENGTH_HINT: Record<string, string> = {
  short: '比原文更短：砍掉铺垫与重复论证，只留最有信息量的部分。',
  long: '比原文更充分：把关键处展开讲透，补必要的步骤或例子（但不许编造事实）。',
};
const TONE_HINT: Record<string, string> = {
  calm: '语气更克制：少感叹号、少形容词，把话说准而不是说满。',
  punchy: '语气更冲：观点直给、句子更短，但不许夸大承诺或用绝对化用语。',
};

// 参数卡 → prompt 块。全部为空时返回空串（不注入任何噪声——与账号上下文各块同一约定）。
export function buildSkillBriefBlock(
  brief: SkillBrief | undefined,
  materials: { type: string; content: string }[],
): string {
  if (!brief) return '';
  const lines: string[] = [];
  if (brief.platform) lines.push(`- 目标平台：${platformName(brief.platform)}`);
  if (brief.length && LENGTH_HINT[brief.length]) lines.push(`- 篇幅：${LENGTH_HINT[brief.length]}`);
  if (brief.tone && TONE_HINT[brief.tone]) lines.push(`- 语气：${TONE_HINT[brief.tone]}`);
  if (materials.length) {
    lines.push('- 本篇必须用上这几条素材（用户点名指定，比账号素材库里其他条目优先）：');
    for (const m of materials) lines.push(`  · ${m.content.slice(0, 200)}`);
  }
  const extra = (brief.extra ?? '').trim();
  if (extra) lines.push(`- 用户补充要求：${extra.slice(0, 300)}`);
  if (lines.length === 0) return '';
  return ['【本次运行的额外要求】', ...lines].join('\n');
}
