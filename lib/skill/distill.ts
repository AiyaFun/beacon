// 流程技能：把一次跑通的任务提炼成可复用的做法（2026-08-29）。
//
// 灵感来自 Hermes Agent 的「把干完的任务提炼成技能文件」。原料一直都在——
// AgentRun.messages 存着完整的工具调用轨迹，只是以前没人用。
//
// ── 三条设计上的硬规矩，每一条都对应一种「照着直觉写就会出事」 ──
//
// ① **步骤只从真实轨迹里取，绝不让模型编。**
//    直觉写法是把 messages 丢给模型说「总结成步骤」，然后照它说的存。但模型会补全、
//    会想当然——它可能写出一个这次压根没调过的工具。那份「步骤」将来会被当成执行指引，
//    等于让模型给自己造出一条没人授权过的路径。所以：工具序列由代码从 toolCalls 里读出，
//    模型只负责给每一步写人话解释和技能名。模型编的名字最多难看，编的步骤会出事。
//
// ② **绝不扩权。** toolAllowlist = 这次实际用过的工具，天然是来源运行权限的子集。
//    重放时**再与当前用户的权限求一次交集**——技能不能成为提权通道：
//    不能靠「存一个技能」让自己用上本来没权限的工具，也不能靠「用别人存的技能」越权。
//
// ③ **重放不另起执行引擎。** 步骤拼进 agentSystemPrompt，照常走 startAgentRun。
//    自己写一套步骤执行器，等于把乐观锁迁移、授权三档、预算闸、确认闸全部重做一遍——
//    必漏，而且漏在安全边界上。
import { prisma } from '../db';
import { llmComplete } from '../llm/gateway';
import { messageText, type ChatMessage } from '../llm/types';
import { startAgentRun, availableTools, type AgentTurn } from '../agent/run';
import type { ToolContext } from '../agent/tools';
import { notify } from '../notify';

export type ProcedureStep = { tool: string; why: string };

/** 一次运行里**实际**调过哪些工具，按首次出现排序、去重。 */
export function toolTraceOf(messages: ChatMessage[]): string[] {
  const seen: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const c of m.toolCalls) if (c.name && !seen.includes(c.name)) seen.push(c.name);
  }
  return seen;
}

const NAME_MAX = 40;
const DESC_MAX = 120;

/** 模型只被允许改写这三样文字；工具序列不经它手。 */
type Annotation = { name: string; description: string; steps: { tool: string; why: string }[] };

function safeParse(raw: string): Annotation | null {
  try {
    const j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Annotation;
    if (typeof j?.name !== 'string' || typeof j?.description !== 'string') return null;
    return j;
  } catch { return null; }
}

/**
 * 从一次已完成的运行提炼流程技能。
 * 只认 done 的运行：失败/中止的做法不值得复用，存下来只会误导。
 */
export async function distillProcedure(
  ctx: ToolContext,
  runId: string,
): Promise<{ ok: boolean; skillId?: string; error?: string }> {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, workspaceId: ctx.workspaceId },
    select: { id: true, goal: true, status: true, messages: true },
  });
  if (!run) return { ok: false, error: '找不到这次运行' };
  if (run.status !== 'done') return { ok: false, error: '只有跑完的任务才能存成技能' };

  let messages: ChatMessage[] = [];
  try { messages = JSON.parse(run.messages) as ChatMessage[]; } catch { /* 坏数据当空轨迹 */ }

  // 【规矩①】工具序列由代码读出，不经模型
  const trace = toolTraceOf(messages);
  if (trace.length === 0) return { ok: false, error: '这次没调用任何工具，没有做法可提炼' };

  // 末尾那段答复足够模型看懂这次干了什么，不必把整段轨迹喂进去（省 token 也少泄露）
  const tail = messages.filter((m) => m.role === 'assistant').slice(-2).map((m) => messageText(m.content)).join('\n').slice(0, 1500);

  const prompt = [
    '把下面这次已完成的任务，提炼成一个可复用技能的名字和说明。',
    '',
    `原始目标：${run.goal}`,
    `实际用过的工具（按顺序）：${trace.join(' → ')}`,
    `最后的答复节选：${tail || '（无）'}`,
    '',
    '只输出 JSON，不要任何解释：',
    '{"name":"技能名（不超过 12 字，动宾结构，像「采一轮竞对并出简报」）",',
    ' "description":"一句话说清它适合什么场景（不超过 40 字）",',
    ` "steps":[${trace.map((t) => `{"tool":"${t}","why":"这一步为了什么（不超过 20 字）"}`).join(',')}]}`,
    '',
    'steps 里的 tool 必须原样保留、顺序不变，你只填 why。',
  ].join('\n');

  let ann: Annotation | null = null;
  try {
    const r = await llmComplete(ctx.tenantId, 'agent', [{ role: 'user', content: prompt }], { json: true, temperature: 0.3 });
    // 示例模型编不出真东西，宁可退回机械命名也不存一份假的
    if (!r.mocked) ann = safeParse(r.text ?? '');
  } catch { /* 模型不可用不该让这个功能整个失败，下面有兜底 */ }

  // 【规矩①】不管模型说了什么，步骤一律以真实轨迹为准；它只贡献 why
  const whyOf = new Map((ann?.steps ?? []).map((s) => [s.tool, String(s.why ?? '').slice(0, 30)]));
  const steps: ProcedureStep[] = trace.map((tool) => ({ tool, why: whyOf.get(tool) ?? '' }));

  const name = (ann?.name?.trim() || run.goal.trim()).slice(0, NAME_MAX);
  const description = (ann?.description?.trim() || `复用这次的做法：${trace.join(' → ')}`).slice(0, DESC_MAX);

  const skill = await prisma.procedureSkill.create({
    data: {
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      name,
      description,
      goal: run.goal.slice(0, 2000),
      steps: JSON.stringify(steps),
      // 【规矩②】实际用过的工具，天然是来源运行权限的子集
      toolAllowlist: JSON.stringify(trace),
      sourceRunId: run.id,
      createdBy: ctx.memberId,
    },
    select: { id: true },
  });
  return { ok: true, skillId: skill.id };
}

/** 把步骤渲染成给模型看的指引。它是**建议不是命令**——现场情况变了模型该自己调整。 */
export function renderGuidance(name: string, steps: readonly ProcedureStep[]): string {
  return [
    `下面是上次做成这件事的做法（技能「${name}」），照它走通常最快：`,
    ...steps.map((s, i) => `${i + 1}. 用 ${s.tool}${s.why ? `——${s.why}` : ''}`),
    '如果这次的情况跟上次不同，按实际情况调整，不要硬套。',
  ].join('\n');
}

/**
 * 用一个流程技能起一次运行。
 * 【规矩③】走 startAgentRun，不另起执行引擎——所有既有闸门原样生效。
 */
export async function replayProcedure(
  ctx: ToolContext,
  skillId: string,
  role: string,
  disabledTools: readonly string[] = [],
): Promise<{ ok: boolean; turn?: AgentTurn; error?: string }> {
  const skill = await prisma.procedureSkill.findFirst({
    where: { id: skillId, workspaceId: ctx.workspaceId },
    select: { id: true, name: true, goal: true, steps: true, toolAllowlist: true },
  });
  if (!skill) return { ok: false, error: '找不到这个技能' };

  let steps: ProcedureStep[] = [];
  let wanted: string[] = [];
  try { steps = JSON.parse(skill.steps) as ProcedureStep[]; } catch { /* 空步骤仍可跑，只是没指引 */ }
  try { wanted = JSON.parse(skill.toolAllowlist) as string[]; } catch { /* 同上 */ }

  // 【规矩②】重放时再与当前用户的权限求一次交集。
  // 存技能的人可能是管理员、用的人可能是成员；也可能这个工具后来被工作区关掉了。
  const mine = new Set(availableTools(role, disabledTools).map((t) => t.name));
  const allow = wanted.filter((t) => mine.has(t));
  if (wanted.length > 0 && allow.length === 0) {
    return { ok: false, error: '这个技能用到的工具你都没有权限，跑不了' };
  }

  const turn = await startAgentRun(ctx, skill.goal, {
    origin: 'manual',
    toolAllowlist: allow,
    agentSystemPrompt: renderGuidance(skill.name, steps),
  });
  await prisma.procedureSkill.update({ where: { id: skill.id }, data: { usedCount: { increment: 1 } } });
  return { ok: true, turn };
}

// ── 自动建议：跑重复了就提醒他存成技能（2026-08-29 批五）───────────────────
//
// 【为什么补这一件】ProcedureSkill 的灵感本来就来自 Hermes 的「把干完的任务提炼成技能」，
// 但我们只做了一半：**得用户自己想起来去 /skills 点那个按钮**。
// 结果是这张表大概率一直是空的——不是功能不好用，是没人知道该在什么时候用它。
// Hermes 那边真正值钱的是「自动」那一步，这里补的就是它。
//
// 【为什么是「建议」不是「自动创建」】自动建表会有三个问题，每个都比省下的那一下点击贵：
//   ① 技能名和说明由模型写，没人看过就进了列表，脏了以后没人清；
//   ② 它带着一份工具白名单，等于一个可重放的执行路径——那种东西不该自己长出来；
//   ③ 用户不知道它哪儿来的，下次看到只会问「这是什么」。
// 所以只发一条通知，点进去还是走他自己确认的那条路。

/** 连着做过几次同样的事才提醒。2 次是巧合，3 次才是习惯。 */
export const SUGGEST_AFTER_RUNS = 3;
/** 只看最近这么多次运行——半年前做过三次同样的事，现在提醒他没有意义。 */
const LOOKBACK_RUNS = 40;

/** 一次运行的「做法指纹」= 用过的工具序列。同一串工具 = 同一种做法。 */
export function traceFingerprint(trace: readonly string[]): string {
  return trace.join('>');
}

/**
 * 扫一个工作区最近的运行，找出「做过 N 次以上、却还没存成技能」的做法。
 *
 * 【为什么按工具序列而不是按 goal 文本】用户每次说的话都不一样
 *（「看看昨天数据」「昨天数据怎么样」），但做法是同一条。
 * 按文本聚类要么聚不到一起，要么把不同的事聚成一堆；工具序列是**它实际做了什么**，
 * 这正是技能要复用的那个东西。
 */
export async function suggestProcedures(
  workspaceId: string,
): Promise<{ suggested: number }> {
  const runs = await prisma.agentRun.findMany({
    where: { workspaceId, status: 'done' },
    orderBy: { createdAt: 'desc' },
    take: LOOKBACK_RUNS,
    select: { id: true, goal: true, messages: true },
  });

  const groups = new Map<string, { runIds: string[]; goal: string; trace: string[] }>();
  for (const r of runs) {
    let msgs: ChatMessage[] = [];
    try { msgs = JSON.parse(r.messages) as ChatMessage[]; } catch { continue; }
    const trace = toolTraceOf(msgs);
    // 一步就做完的事不值得存成技能——那本来就是一次工具调用
    if (trace.length < 2) continue;
    const key = traceFingerprint(trace);
    const g = groups.get(key) ?? { runIds: [], goal: r.goal, trace };
    g.runIds.push(r.id);
    groups.set(key, g);
  }

  // 已经存过技能的做法不再提醒。**按工具白名单比，不按名字比**——
  // 用户可以把技能改名，改完还提醒他「你好像常做这件事」就很蠢
  const existing = await prisma.procedureSkill.findMany({
    where: { workspaceId },
    select: { toolAllowlist: true },
  });
  const known = new Set(
    existing.map((e) => {
      try { return traceFingerprint(JSON.parse(e.toolAllowlist) as string[]); } catch { return ''; }
    }),
  );

  let suggested = 0;
  for (const [key, g] of groups) {
    if (g.runIds.length < SUGGEST_AFTER_RUNS || known.has(key)) continue;
    await notify({
      workspaceId,
      kind: 'system',
      // 【refId 按做法指纹 + once】同一种做法只提醒一次；他要是不理会，下次也不该再刷屏。
      // **once 是必须的**：光有指纹不够——notify 从来不按 refId 合并（它是个裸 create），
      // 而这里的 refId 又没有天数分量，所以在补上 once 之前，
      // optimize_memory（每日 05:30）只要用户不去把它存成技能就**天天发**，一轮最多 3 条，
      // 而且这条路没有形态闸，SaaS 上照样发。正是注释自己写的「三天后就没人看通知」的成因。
      refId: `procedure-suggest:${key}`,
      once: true,
      title: '这件事你做过好几次了，要存成技能吗',
      body: `最近做了 ${g.runIds.length} 次「${g.goal.slice(0, 40)}」，每次都是同一串做法`
        + `（${g.trace.join(' → ')}）。存成技能以后一句话就能重放。`,
      link: '/runs',
    });
    suggested += 1;
    // 一轮最多提醒 3 条：一次弹七八条通知，用户只会全部划掉
    if (suggested >= 3) break;
  }
  return { suggested };
}
