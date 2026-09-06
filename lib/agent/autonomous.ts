import { parseJson } from '../json';
import type { AuthMode } from './tools';

// ── 自主智能体：配置形数据 ────────────────────────────────────────────────────
//
// 【两种智能体的分界不是「大小」而是「谁决定怎么做」】
//   流水线（pipeline）  —— 一串定死的步骤，跑法完全可预期，模板作者定死一切
//   自主（autonomous）  —— 给它目标和授权范围，它自己安排怎么做
//
// 自主智能体**仍然是纯数据**：一段人设 + 一份工具白名单 + 一个预算 + 一个缺省授权档。
// 没有代码、没有自由脚本步——「市场只卖数据形单位」那条红线在这里同样成立，
// 分享出去的智能体不可能携带任意执行。

export const AGENT_MODES = ['pipeline', 'autonomous'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export function isAutonomous(mode: string | null | undefined): boolean {
  return mode === 'autonomous';
}

export type AgentConfig = {
  /** 写给模型的人设补充（拼在系统提示词后面） */
  systemPrompt: string;
  /**
   * 这个智能体能用哪些工具。
   *
   * 【只能收窄不能放宽】派它的时候会与「当前用户自己有权用的工具」求交集
   *（见 resolveAgentTools）——装了别人分享的智能体，不可能因此突破自己的权限
   * 或工作区开关。空数组 = 不限制（仍受用户自己的权限约束）。
   */
  tools: string[];
  /** 这次最多烧几次模型调用。不填按套餐档。 */
  callBudget?: number;
  /** 缺省授权档。**仍然要过 startAgentRun 的那几道闸**（对外 API 强制逐步确认；子运行不得宽于父）。 */
  defaultAuthMode?: AuthMode;
  /**
   * 这个 bot 能跑的技能，每条带一句「什么时候用」（2026-09-05，学 Grok Bot 的 Skills 页签）。
   * 只是**路由提示**：真正能不能跑仍看 run_skill 在不在白名单里、技能有没有装。
   * 未安装的技能会在提示里标「未装」，让 bot 告诉用户去技能中心装，而不是假装跑了。
   */
  skills?: BotSkillRef[];
  /**
   * 建议的定时（Grok Bot 的 Routines）。**默认关**——装 bot 时问一次要不要开，
   * 开了才建 TaskPreset + ScheduledAgent；这里只是建议，不是已经生效的定时。
   */
  routines?: BotRoutine[];
};

export type BotSkillRef = {
  /** ContentSkill.slug */
  slug: string;
  /** 什么时候用它（用户会怎么开口） */
  when: string;
};

export type BotRoutine = {
  /** 一键任务卡的标题 */
  title: string;
  /** 到点派出去的那句话 */
  goal: string;
  /** 北京时间几点（整点） */
  atHour: number;
  /** 0=周日…6=周六；空/缺省 = 每天 */
  weekdays?: number[];
};

export const BOT_SKILLS_MAX = 12;
export const BOT_ROUTINES_MAX = 3;

function parseSkills(raw: unknown): BotSkillRef[] {
  if (!Array.isArray(raw)) return [];
  const out: BotSkillRef[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const slug = typeof o.slug === 'string' ? o.slug.trim().slice(0, 60) : '';
    const when = typeof o.when === 'string' ? o.when.trim().slice(0, 160) : '';
    if (!slug || !when) continue; // 没写「什么时候用」的不收：那正是这个字段存在的理由
    out.push({ slug, when });
    if (out.length >= BOT_SKILLS_MAX) break;
  }
  return out;
}

function parseRoutines(raw: unknown): BotRoutine[] {
  if (!Array.isArray(raw)) return [];
  const out: BotRoutine[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 60) : '';
    const goal = typeof o.goal === 'string' ? o.goal.trim().slice(0, 2000) : '';
    const atHour = typeof o.atHour === 'number' && Number.isInteger(o.atHour) && o.atHour >= 0 && o.atHour <= 23 ? o.atHour : -1;
    if (!title || !goal || atHour < 0) continue;
    const weekdays = Array.isArray(o.weekdays)
      ? [...new Set(o.weekdays.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6))]
      : [];
    out.push({ title, goal, atHour, ...(weekdays.length ? { weekdays } : {}) });
    if (out.length >= BOT_ROUTINES_MAX) break;
  }
  return out;
}

const EMPTY: AgentConfig = { systemPrompt: '', tools: [] };

/** 解析模板上那段配置。坏 JSON 不炸页面：当成空配置处理（= 不限制、按套餐档）。 */
export function parseAgentConfig(raw: string | null | undefined): AgentConfig {
  if (!raw) return EMPTY;
  const o = parseJson<Partial<AgentConfig>>(raw, {});
  return {
    systemPrompt: typeof o.systemPrompt === 'string' ? o.systemPrompt.slice(0, 4000) : '',
    tools: Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === 'string') : [],
    callBudget: typeof o.callBudget === 'number' && o.callBudget > 0 ? Math.floor(o.callBudget) : undefined,
    defaultAuthMode:
      o.defaultAuthMode === 'preauthorized' || o.defaultAuthMode === 'unattended' || o.defaultAuthMode === 'confirm_each'
        ? o.defaultAuthMode
        : undefined,
    // 两个可选块：坏形状整段丢，不让一条写坏的技能引用拖垮整个配置
    ...(parseSkills(o.skills).length ? { skills: parseSkills(o.skills) } : {}),
    ...(parseRoutines(o.routines).length ? { routines: parseRoutines(o.routines) } : {}),
  };
}

/**
 * 这个自主智能体这次真正能用的工具。
 *
 * **交集，永远是交集**：模板说它要用什么，用户的角色与工作区开关说他允许什么，
 * 取交集才是这次能用的。反过来（以模板为准）意味着「装一个智能体就能越权」——
 * 而智能体是**可以从市场装别人的**。
 */
export function resolveAgentTools(config: AgentConfig, allowedNames: readonly string[]): string[] {
  const allowed = new Set(allowedNames);
  if (config.tools.length === 0) return [...allowed]; // 没写白名单 = 不额外收窄
  return config.tools.filter((t) => allowed.has(t));
}

/**
 * 子运行的授权档：**继承但不得超过父**。
 *
 * 顺序即宽松度：confirm_each < preauthorized < unattended。
 * 父是「每一步都问我」的话，它派出去的子任务也必须每一步都问——
 * 否则「派个智能体」就成了绕过自己那道确认闸的捷径。
 */
const LOOSENESS: Record<AuthMode, number> = { confirm_each: 0, preauthorized: 1, unattended: 2 };

export function capAuthMode(parent: string, wanted: string | undefined): AuthMode {
  const p = (LOOSENESS[parent as AuthMode] ?? 0) as number;
  const w = (LOOSENESS[(wanted ?? 'confirm_each') as AuthMode] ?? 0) as number;
  const level = Math.min(p, w);
  return (Object.keys(LOOSENESS) as AuthMode[]).find((k) => LOOSENESS[k] === level) ?? 'confirm_each';
}

/**
 * 子运行的预授权白名单：**父的白名单 ∩ 子智能体能用的工具**。
 *
 * 【为什么绝不能重新按子模板全勾】那就成了一条洗白名单的三步链路：
 * 模型起草一个宽白名单的智能体 → 用户在预授权的父运行里让它派这个智能体 →
 * 子运行按子模板重新全勾。用户从头到尾没看过那份白名单。
 */
export function capPreauthorized(parentTools: readonly string[], childTools: readonly string[]): string[] {
  const child = new Set(childTools);
  return parentTools.filter((t) => child.has(t));
}
