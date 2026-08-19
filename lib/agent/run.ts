import { prisma } from '../db';
import { parseJson, toJson } from '../json';
import { llmComplete } from '../llm/gateway';
import { readPersona, personaPromptBlock } from '../persona';
import { buildMemoryContext } from '../memory/core';
import { can } from '../rbac';
import { createLogger } from '../logger';
import type { ChatMessage, ToolCall } from '../llm/types';
import { AGENT_TOOLS, toolByName, toolsForRole, needsConfirm, resultForModel, type ToolContext } from './tools';

const log = createLogger({ module: 'agent' });

// ── AI 全域调用执行器 ────────────────────────────────────────────────────────
//
// 一次运行 = 「模型想 → 要调工具 → （写操作先问人）→ 执行 → 把结果回灌给模型 → 再想」的循环。
//
// 【三条不许动的规矩】
// 1. **写操作与花钱操作一律先问人**。模型说要建草稿/采数据/烧额度时，执行器停下来，
//    把「它打算做什么、参数是什么」原样展示，用户点了确认才动手。拒绝也要如实回灌给模型
//    （告诉它「用户不同意」），否则它会以为执行了、接着往下编。
// 2. **Mock 模型下直接拒绝整个执行**。Mock 会编出一段像模像样的「我已经帮你建好了」——
//    在纯聊天里那只是示例文案（带 Mock 标），在这里却是**谎报执行结果**。没有真模型就明说没有。
// 3. **步数封顶**。模型有可能在两个工具之间来回打转，封顶是防止它把额度烧光的唯一护栏。

/** 一次运行最多让模型说几轮话。到顶即停，如实告诉用户没做完。 */
export const MAX_STEPS = 12;
/** 一轮里最多处理几个工具调用（模型偶尔会一口气要十几个）。 */
export const MAX_CALLS_PER_TURN = 5;
/** 存进库的对话上限，防止一次长运行把行撑到几 MB。 */
const MAX_MESSAGES_CHARS = 200_000;

export type AgentStepView = {
  seq: number;
  kind: string;
  tool: string;
  label: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
};

export type PendingView = {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  /** 这一步会花钱吗（界面上要说清楚） */
  costly: boolean;
};

export type AgentTurn = {
  runId: string;
  status: 'running' | 'awaiting_confirm' | 'done' | 'failed' | 'cancelled';
  steps: AgentStepView[];
  answer?: string;
  error?: string;
  pending?: PendingView;
};

function systemPrompt(personaBlock: string, memoryBlock: string, toolNames: string[]): string {
  return [
    '你是「烽火台」内容创作 SaaS 里的 AI 助手，除了回答问题，你还能**直接操作这个系统**。',
    '',
    '可用工具：' + toolNames.join('、') + '。',
    '',
    '工作方式：',
    '- 需要系统里的真实数据时，**必须先调工具查**，不许凭印象编。查不到就说查不到。',
    '- 写操作（建草稿、加对标、采数据、生成选题）会先弹给用户确认，用户同意后才真正执行。',
    '- 用户拒绝某一步时，不要重复请求同一个操作，换个思路或直接告诉他你的建议。',
    '- 工具返回里标了「示例数据」的内容，转述时必须一并说明它是示例，不能当成真实数据下结论。',
    '- 全部做完后，用中文简短说清楚你做了什么、结果如何。别复述 JSON。',
    '',
    personaBlock,
    memoryBlock ? '\n' + memoryBlock : '',
  ].join('\n');
}

async function loadContext(ctx: ToolContext): Promise<{ persona: string; memory: string }> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: ctx.accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');
  const memory = await buildMemoryContext(ctx.workspaceId, ctx.accountId).catch(() => '');
  return { persona: personaPromptBlock(persona), memory };
}

type RunRow = {
  id: string;
  workspaceId: string;
  accountId: string | null;
  memberId: string;
  status: string;
  messages: string;
  pending: string | null;
  steps: number;
};

async function appendStep(
  runId: string,
  seq: number,
  step: { kind: string; tool?: string; args?: unknown; result?: string; ok?: boolean },
): Promise<void> {
  await prisma.agentStep.create({
    data: {
      runId,
      seq,
      kind: step.kind,
      tool: step.tool ?? '',
      args: toJson(step.args ?? {}),
      result: (step.result ?? '').slice(0, 4000),
      ok: step.ok ?? true,
    },
  });
}

async function viewOf(runId: string): Promise<AgentTurn> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { agentSteps: { orderBy: { seq: 'asc' } } },
  });
  if (!run) throw new Error('运行记录不存在');
  const pendingCall = run.pending ? parseJson<ToolCall | null>(run.pending, null) : null;
  const pendingTool = pendingCall ? toolByName(pendingCall.name) : null;
  return {
    runId: run.id,
    status: run.status as AgentTurn['status'],
    answer: run.answer ?? undefined,
    error: run.error ?? undefined,
    steps: run.agentSteps.map((s) => ({
      seq: s.seq,
      kind: s.kind,
      tool: s.tool,
      label: toolByName(s.tool)?.label ?? s.tool,
      args: parseJson<Record<string, unknown>>(s.args, {}),
      result: s.result,
      ok: s.ok,
    })),
    pending:
      pendingCall && pendingTool
        ? {
            tool: pendingCall.name,
            label: pendingTool.label,
            args: parseJson<Record<string, unknown>>(pendingCall.arguments, {}),
            costly: pendingTool.costly === true,
          }
        : undefined,
  };
}

/** 开始一次运行：建库记录 → 进循环。 */
export async function startAgentRun(ctx: ToolContext, goal: string): Promise<AgentTurn> {
  const trimmed = goal.trim().slice(0, 2000);
  if (!trimmed) throw new Error('先说说你想让我做什么');

  const tools = toolsForRole(ctx.role);
  if (tools.length === 0) {
    throw new Error('你的角色没有任何可执行的权限，AI 助手无法代你操作系统');
  }
  const { persona, memory } = await loadContext(ctx);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(persona, memory, tools.map((t) => `${t.name}(${t.label})`)) },
    { role: 'user', content: trimmed },
  ];

  const run = await prisma.agentRun.create({
    data: {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      memberId: ctx.memberId,
      goal: trimmed,
      status: 'running',
      messages: toJson(messages),
    },
  });
  return loop(ctx, run.id);
}

/** 用户对当前 pending 的写操作做出决定。approve=false 表示拒绝（照样把结果回灌给模型）。 */
export async function decidePendingCall(ctx: ToolContext, runId: string, approve: boolean): Promise<AgentTurn> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, workspaceId: ctx.workspaceId } });
  if (!run) throw new Error('运行记录不存在');
  if (run.status !== 'awaiting_confirm' || !run.pending) return viewOf(runId);
  // 只有发起人能确认：别人替他点确认，等于用他的权限做他没同意的事。
  if (run.memberId !== ctx.memberId) throw new Error('只有发起这次执行的人能确认或拒绝');

  const call = parseJson<ToolCall | null>(run.pending, null);
  if (!call) {
    await prisma.agentRun.update({ where: { id: runId }, data: { pending: null, status: 'running' } });
    return loop(ctx, runId);
  }

  const messages = parseJson<ChatMessage[]>(run.messages, []);
  let seq = run.steps;

  if (!approve) {
    messages.push({ role: 'tool', toolCallId: call.id, content: toJson({ ok: false, error: '用户拒绝了这次操作' }) });
    await appendStep(runId, ++seq, { kind: 'rejected', tool: call.name, args: parseJson(call.arguments, {}), result: '用户拒绝执行', ok: false });
  } else {
    const { message, ok } = await executeCall(ctx, call);
    messages.push({ role: 'tool', toolCallId: call.id, content: message });
    await appendStep(runId, ++seq, { kind: 'tool_result', tool: call.name, args: parseJson(call.arguments, {}), result: message, ok });
  }

  await prisma.agentRun.update({
    where: { id: runId },
    data: { messages: capMessages(messages), pending: null, status: 'running', steps: seq },
  });
  return loop(ctx, runId);
}

export async function cancelAgentRun(ctx: ToolContext, runId: string): Promise<AgentTurn> {
  await prisma.agentRun.updateMany({
    where: { id: runId, workspaceId: ctx.workspaceId, status: { in: ['running', 'awaiting_confirm'] } },
    data: { status: 'cancelled', pending: null },
  });
  return viewOf(runId);
}

export async function getAgentRunView(ctx: ToolContext, runId: string): Promise<AgentTurn> {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, workspaceId: ctx.workspaceId } });
  if (!run) throw new Error('运行记录不存在');
  return viewOf(runId);
}

function capMessages(messages: ChatMessage[]): string {
  let json = toJson(messages);
  // 超长时从**中间**丢：系统提示（第一条）与最近几轮都要留，丢中段影响最小。
  while (json.length > MAX_MESSAGES_CHARS && messages.length > 6) {
    messages.splice(1, 2);
    json = toJson(messages);
  }
  return json;
}

/** 真正执行一次工具调用。权限在这里**再查一次**——列表给了什么不算数，执行时的判定才算。 */
async function executeCall(ctx: ToolContext, call: ToolCall): Promise<{ message: string; ok: boolean }> {
  const tool = toolByName(call.name);
  if (!tool) {
    return { message: toJson({ ok: false, error: `没有名为 ${call.name} 的工具` }), ok: false };
  }
  if (!can(ctx.role, tool.action)) {
    return { message: toJson({ ok: false, error: '发起人的角色没有这个权限，操作未执行' }), ok: false };
  }
  const args = parseJson<Record<string, unknown>>(call.arguments, {});
  try {
    const result = await tool.run(ctx, args);
    return { message: resultForModel(result), ok: result.ok };
  } catch (err) {
    // 工具自己炸了不能把整次运行带走：如实回灌错误，让模型换个做法或告诉用户。
    log.warn('工具执行失败', { tool: call.name, error: (err as Error).message });
    return { message: toJson({ ok: false, error: (err as Error).message.slice(0, 300) }), ok: false };
  }
}

/** 主循环。每次进来都从库里读最新状态，所以「确认后继续」与「首次运行」走的是同一段代码。 */
async function loop(ctx: ToolContext, runId: string): Promise<AgentTurn> {
  for (;;) {
    const run = (await prisma.agentRun.findUnique({ where: { id: runId } })) as RunRow | null;
    if (!run) throw new Error('运行记录不存在');
    if (run.status !== 'running') return viewOf(runId);
    if (run.steps >= MAX_STEPS) {
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: 'failed', error: `已经跑到步数上限（${MAX_STEPS} 步）还没结束，先停下来。可以把要求拆小一点再来一次。` },
      });
      return viewOf(runId);
    }

    const messages = parseJson<ChatMessage[]>(run.messages, []);
    const tools = toolsForRole(ctx.role).map((t) => t.def);
    const result = await llmComplete(ctx.tenantId, 'chat', messages, { temperature: 0.3, tools });

    // Mock 兜底会编出「我已经帮你做好了」——在执行器里这是谎报，必须硬停。
    if (result.mocked) {
      await prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          error: result.degraded
            ? 'AI 模型这次调用失败了，执行已中止（不会拿示例内容冒充执行结果）。稍后重试，或到「接入与密钥」检查渠道。'
            : '还没有接入真实的 AI 模型，执行模式不可用（示例模型只会编造执行结果）。请先到「接入与密钥」配置 API Key。',
        },
      });
      return viewOf(runId);
    }

    const calls = (result.toolCalls ?? []).slice(0, MAX_CALLS_PER_TURN);
    let seq = run.steps;

    if (calls.length === 0) {
      const answer = result.text.trim();
      await appendStep(runId, ++seq, { kind: 'answer', result: answer.slice(0, 4000) });
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: 'done', answer, steps: seq, messages: capMessages([...messages, { role: 'assistant', content: answer }]) },
      });
      return viewOf(runId);
    }

    // 模型这一轮要调工具：先把它的「意图」原样记进对话（含 tool_calls），
    // 否则下一轮回灌 tool 结果时 id 对不上，多数端点直接 400。
    messages.push({ role: 'assistant', content: result.text ?? '', toolCalls: calls });

    let paused = false;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const tool = toolByName(call.name);
      await appendStep(runId, ++seq, { kind: 'tool_call', tool: call.name, args: parseJson(call.arguments, {}) });

      if (tool && needsConfirm(tool) && can(ctx.role, tool.action)) {
        // 停在这一步等人。**同一批里排在它后面的调用也一起等**——
        // 先斩后奏地把后面的读操作跑完，会让确认弹层出现在一堆已经发生的事之后。
        const remaining = calls.slice(i);
        await prisma.agentRun.update({
          where: { id: runId },
          data: {
            status: 'awaiting_confirm',
            pending: toJson(remaining[0]),
            messages: capMessages(messages),
            steps: seq,
          },
        });
        // 后面的调用这一轮不执行：模型会在确认后的下一轮重新决定要不要再调。
        // 代价是可能多一轮对话，换来的是「用户看到的每一步都还没发生」。
        if (remaining.length > 1) {
          for (const skipped of remaining.slice(1)) {
            messages.push({
              role: 'tool',
              toolCallId: skipped.id,
              content: toJson({ ok: false, error: '这一步先没执行：同一轮里前面有一步在等用户确认' }),
            });
          }
          await prisma.agentRun.update({ where: { id: runId }, data: { messages: capMessages(messages) } });
        }
        paused = true;
        break;
      }

      const { message, ok } = await executeCall(ctx, call);
      messages.push({ role: 'tool', toolCallId: call.id, content: message });
      await appendStep(runId, ++seq, { kind: 'tool_result', tool: call.name, args: parseJson(call.arguments, {}), result: message, ok });
    }

    if (paused) return viewOf(runId);
    await prisma.agentRun.update({ where: { id: runId }, data: { messages: capMessages(messages), steps: seq } });
  }
}

/** 给界面用：当前角色能调用哪些工具（不含权限外的）。 */
export function availableTools(role: string) {
  return toolsForRole(role).map((t) => ({
    name: t.name,
    label: t.label,
    write: t.write,
    costly: t.costly === true,
    description: t.def.description,
  }));
}

export { AGENT_TOOLS };
