import { prisma } from '../db';
import { parseAgentConfig, type BotSkillRef } from './autonomous';
import { renderLedgerBlock } from './ledger';
import { listInstalledSkills } from '../skills';

// ── bot 专属上下文块（2026-09-05）──────────────────────────────────────────
//
// 一次自主智能体运行开始时，除了通用系统提示与人设，再注两段只有这个 bot 才有的东西：
//   【你能用的技能】每条技能一句「什么时候用」——模型选剧本不再靠猜 description
//   【你的台账】这个 bot 自己的工作状态（盯单 / 上次做到哪 / 已见清单条数）
//
// 【为什么集中在 startAgentRun 拼，而不是 dispatch.ts / preset.ts / child-run.ts 各拼各的】
// 四个入口（群机器人、一键任务卡、子运行、页面直派）此前各自把 persona + systemPrompt 拼成
// agentSystemPrompt 传进来，再加一块就是四处都要改、漏一处那个入口的 bot 就没技能没台账，
// 而且失效得静悄悄。集中到 startAgentRun 只看 opts.agentTemplateId，四个入口零改动。

export type BotIdentity = { slug: string; agentConfigRaw: string | null };

export async function loadBotIdentity(templateId: string | undefined): Promise<BotIdentity | null> {
  if (!templateId) return null;
  const t = await prisma.workflowTemplate.findUnique({ where: { id: templateId }, select: { slug: true, agentConfig: true } });
  return t ? { slug: t.slug, agentConfigRaw: t.agentConfig } : null;
}

/**
 * 技能块。已装的给 id（run_skill 要 skill_id）；没装的标「未装」——
 * 让 bot 如实告诉用户去技能中心装，而不是编一个 id 去调然后撞「技能不存在」。
 */
export async function renderSkillsBlock(tenantId: string, skills: BotSkillRef[]): Promise<string> {
  if (skills.length === 0) return '';
  const installed = await listInstalledSkills(tenantId);
  const bySlug = new Map(installed.map((s) => [s.slug, s]));
  const lines = skills.map((ref) => {
    const s = bySlug.get(ref.slug);
    return s
      ? `- ${s.emoji} ${s.name}（skill_id=${s.id}）：${ref.when}`
      : `- 「${ref.slug}」（未装——用户要用时让他去技能中心装，别假装跑了）：${ref.when}`;
  });
  return ['【你能用的技能】用 run_skill 跑，作用在某一篇草稿上；下面每条后面是「什么时候用」：', ...lines].join('\n');
}

/** 拼给 startAgentRun 的那两段（都可能为空串；空的不注）。 */
export async function botContextBlocks(tenantId: string, workspaceId: string, bot: BotIdentity | null): Promise<string> {
  if (!bot) return '';
  const cfg = parseAgentConfig(bot.agentConfigRaw);
  const usesLedger = cfg.tools.some((t) => t === 'ledger_write' || t === 'mark_seen');
  const [skills, ledger] = await Promise.all([
    renderSkillsBlock(tenantId, cfg.skills ?? []).catch(() => ''),
    renderLedgerBlock(workspaceId, bot.slug).catch(() => ''),
  ]);
  // 【首次开场】（学 X Brief：装完第一句先问「盯谁」）带台账工具的 bot 台账还空着，
  // 就明说「空的」——模型才知道这是第一次，该先问用户要盯什么、再记进台账，而不是把全部竞对采一遍。
  // 定时跑到时没人在跟前：那就先干活，汇报末尾提醒用户来设盯单。
  const firstRun = usesLedger && !ledger
    ? '【你的台账】还是空的——这是你第一次跑。有人在对话里派你的话，先问清要盯哪些号/话题、写进台账「盯单」再动手；'
      + '如果是定时自动跑（没人回答你），就按现有监控先干，并在汇报末尾提醒用户来设盯单。'
    : '';
  return [skills, ledger || firstRun].filter(Boolean).map((b) => `\n\n${b}`).join('');
}
