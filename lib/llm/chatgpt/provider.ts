import type { ChatMessage, ContentPart, LlmProvider, LlmResult, ToolDef, ToolCall } from '../types';
import { messageText } from '../types';
import { stripJsonFences, stripThinking } from '../openai-compatible';
import { CHATGPT_CODEX_BASE, ChatgptAuthError, chatgptTokensNeedRefresh, refreshChatgptTokens, type ChatgptTokens } from './auth';

// ChatGPT 订阅渠道的执行层（2026-09-15）：把我们的 ChatMessage/ToolDef 翻成 Responses API 的形状，
// 发给 chatgpt.com/backend-api/codex/responses，再把 SSE 收回来拼成 LlmResult。
//
// 【与 OpenAI 兼容渠道的三处硬差别】
//   ① 协议是 Responses 不是 chat/completions：system 进 `instructions`，历史是 input items，
//      工具结果是 function_call_output（按 call_id 对上）；
//   ② 只接受 stream:true + store:false（Codex 后端硬性要求），所以非流式的 complete() 也要收完整条 SSE；
//   ③ 推理模型 + store:false：下一轮回灌工具结果时必须把上一轮的 reasoning 项原样带回，否则 400。
//      加密的 reasoning 项挂在 ToolCall.reasoning 上跟着对话走（lib/llm/types.ts）。
// 请求头/字段与 Codex CLI、pi-mono（OpenClaw）对齐：OpenAI-Beta: responses=experimental、chatgpt-account-id、originator。

import { DEFAULT_CHATGPT_MODEL, type ReasoningEffort } from './types';

// 常量与类型住在 ./types（客户端也引；这个文件经 ./auth 带着 node:fs，不能进浏览器包）
export { DEFAULT_CHATGPT_MODEL, CHATGPT_REASONING_EFFORTS, type ReasoningEffort } from './types';
const DEFAULT_TIMEOUT_MS = 90_000;
const JSON_NUDGE = '只输出合法的 JSON 本身，不要用 markdown 代码块（```）包裹，也不要任何解释性文字。';
const USAGE_LIMIT_RE = /usage_limit|usage limit|quota|rate_limit|too many requests|billing/i;

type ResponsesItem = Record<string, unknown>;

/** 把系统消息拼成 instructions（Codex 后端要求非空），其余翻成 input items。 */
export function toResponsesInput(messages: ChatMessage[], opts?: { json?: boolean }): { instructions: string; input: ResponsesItem[] } {
  const systems: string[] = [];
  const input: ResponsesItem[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(messageText(m.content));
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = messageText(m.content);
      if (text.trim()) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      if (m.toolCalls && m.toolCalls.length > 0) {
        // 推理项必须排在它对应的 function_call 之前（Responses API 的顺序要求）
        for (const c of m.toolCalls) {
          if (c.reasoning) {
            try { input.push(JSON.parse(c.reasoning) as ResponsesItem); } catch { /* 坏掉的推理项不如不带 */ }
          }
        }
        for (const c of m.toolCalls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments || '{}' });
      }
      continue;
    }
    input.push({ type: 'message', role: 'user', content: userParts(m.content) });
  }
  if (opts?.json) systems.push(JSON_NUDGE);
  const instructions = systems.join('\n\n').trim() || '你是一个乐于助人的助手。';
  return { instructions, input };
}

function userParts(content: string | ContentPart[]): ResponsesItem[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  const out: ResponsesItem[] = [];
  for (const p of content) {
    if (p.type === 'text') out.push({ type: 'input_text', text: p.text });
    else if (p.type === 'image_url') out.push({ type: 'input_image', image_url: p.image_url.url, detail: 'auto' });
    // video_url 是方舟私有口径，ChatGPT 不认，丢掉
  }
  return out.length ? out : [{ type: 'input_text', text: '' }];
}

export function toResponsesTools(tools: ToolDef[] | undefined): ResponsesItem[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

type Parsed = {
  text: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
  reasoningItem?: string;
  /** image_generation 工具产出的图（base64） */
  images: string[];
};

function emptyParsed(): Parsed & { textFromDelta: boolean } {
  return { text: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, images: [], textFromDelta: false };
}

/** 一条 SSE 事件（data 里的 JSON）喂进来，累计到 acc 上。导出给测试与 stream() 共用。 */
export function feedResponsesEvent(acc: Parsed & { textFromDelta: boolean }, ev: Record<string, unknown>): string | null {
  const type = typeof ev.type === 'string' ? ev.type : '';
  if (type === 'response.output_text.delta') {
    const d = typeof ev.delta === 'string' ? ev.delta : '';
    if (d) { acc.text += d; acc.textFromDelta = true; return d; }
    return null;
  }
  if (type === 'response.output_item.done') {
    const item = (ev.item ?? {}) as Record<string, unknown>;
    if (item.type === 'function_call' && typeof item.name === 'string') {
      acc.toolCalls.push({
        id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${acc.toolCalls.length}`,
        name: item.name,
        arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
      });
    } else if (item.type === 'reasoning') {
      // 只带回续跑要的那几个字段；summary 置空（不把模型的思考摘要送进下一轮上下文）
      acc.reasoningItem = JSON.stringify({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: [] });
    } else if (item.type === 'image_generation_call') {
      if (typeof item.result === 'string' && item.result) acc.images.push(item.result);
    } else if (item.type === 'message' && !acc.textFromDelta && Array.isArray(item.content)) {
      for (const c of item.content as Record<string, unknown>[]) if (c.type === 'output_text' && typeof c.text === 'string') acc.text += c.text;
    }
    return null;
  }
  if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
    const resp = (ev.response ?? {}) as Record<string, unknown>;
    const usage = (resp.usage ?? {}) as Record<string, unknown>;
    acc.usage = {
      promptTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : acc.usage.promptTokens,
      completionTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : acc.usage.completionTokens,
    };
    return null;
  }
  if (type === 'response.failed' || type === 'error') {
    const err = ((ev.response as Record<string, unknown> | undefined)?.error ?? ev.error ?? ev) as Record<string, unknown>;
    const msg = typeof err.message === 'string' ? err.message : '模型返回了错误';
    throw new Error(USAGE_LIMIT_RE.test(msg) ? `ChatGPT 订阅的用量额度用完了（${msg.slice(0, 120)}）——等额度恢复，或在「接入与密钥」换一条渠道` : `ChatGPT 渠道出错：${msg.slice(0, 200)}`);
  }
  return null;
}

export class ChatgptSubscriptionProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly mocked = false;
  private tokens: ChatgptTokens;
  private readonly effort: ReasoningEffort;
  private readonly baseUrl: string;
  private readonly onTokens?: (t: ChatgptTokens) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    name: string;
    model?: string;
    tokens: ChatgptTokens;
    effort?: ReasoningEffort;
    baseUrl?: string;
    /** 刷新出新 token 后回写到库里；不给就只活在内存里（测试/一次性 ping） */
    onTokens?: (t: ChatgptTokens) => Promise<void>;
    fetchImpl?: typeof fetch;
  }) {
    this.name = opts.name;
    this.model = opts.model || DEFAULT_CHATGPT_MODEL;
    this.tokens = opts.tokens;
    this.effort = opts.effort ?? 'medium';
    this.baseUrl = (opts.baseUrl ?? CHATGPT_CODEX_BASE).replace(/\/$/, '');
    this.onTokens = opts.onTokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async refresh(): Promise<void> {
    this.tokens = await refreshChatgptTokens(this.tokens, this.fetchImpl);
    if (this.onTokens) await this.onTokens(this.tokens);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.tokens.access}`,
      'chatgpt-account-id': this.tokens.accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'beacon',
      accept: 'text/event-stream',
      'content-type': 'application/json',
    };
  }

  private body(messages: ChatMessage[], opts?: { json?: boolean; tools?: ToolDef[] }): Record<string, unknown> {
    const { instructions, input } = toResponsesInput(messages, { json: opts?.json });
    const tools = toResponsesTools(opts?.tools);
    return {
      model: this.model,
      instructions,
      input,
      ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      reasoning: { effort: this.effort, summary: 'auto' },
      // Codex 后端的硬要求；include 是为了拿到加密推理项，续跑工具调用时要原样带回
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    };
  }

  /** 发一次请求；401 刷新一次再试。返回的是 SSE 响应。 */
  private async request(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    if (chatgptTokensNeedRefresh(this.tokens)) {
      try { await this.refresh(); } catch (e) { if ((e as ChatgptAuthError).terminal) throw e; /* 非终态：拿旧 token 试一次 */ }
    }
    const send = () => this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await send();
    if (res.status === 401) {
      await this.refresh();
      res = await send();
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      let msg = detail;
      try { const j = JSON.parse(detail) as { error?: { message?: string } | string; detail?: string }; msg = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.detail ?? detail; } catch { /* 不是 JSON 就用原文 */ }
      if (res.status === 401) throw new ChatgptAuthError('ChatGPT 登录已失效，请到「接入与密钥」重新登录', true);
      if (res.status === 429 || USAGE_LIMIT_RE.test(msg)) {
        throw new Error(`ChatGPT 订阅的用量额度用完了（${msg.slice(0, 120) || 'HTTP 429'}）——等额度恢复，或在「接入与密钥」换一条渠道`);
      }
      throw new Error(`ChatGPT 渠道调用失败 ${res.status}: ${msg.slice(0, 200)}`);
    }
    if (!res.body) throw new Error('ChatGPT 渠道：响应没有正文');
    return res;
  }

  /** 逐条读 SSE，把 data 里的 JSON 交给 onEvent。 */
  private async *events(res: Response): AsyncGenerator<Record<string, unknown>> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { yield JSON.parse(payload) as Record<string, unknown>; } catch { /* 半截行 / 心跳，跳过 */ }
      }
    }
  }

  async *stream(messages: ChatMessage[], _opts?: { temperature?: number }): AsyncIterable<string> {
    const res = await this.request(this.body(messages), 120_000);
    const acc = emptyParsed();
    for await (const ev of this.events(res)) {
      const d = feedResponsesEvent(acc, ev);
      if (d) yield d;
    }
  }

  /**
   * 生图（2026-09-15，用户点名「生图等功能也要能走 ChatGPT」）：Responses API 的内置 image_generation 工具，
   * 图以 base64 回在 image_generation_call 项里。size 只认 1024x1024 / 1536x1024 / 1024x1536 / auto，
   * 调用方（lib/llm/image.ts）负责把方舟那套尺寸映射过来。参考图当 input_image 一起喂（图生图）。
   * ⚠️ 这条路出的图**没有**方舟那种服务端强制的显式水印；隐式标识仍由 lib/cover/run.ts 注入。
   */
  async generateImage(req: { prompt: string; size: string; referenceImages?: string[] }, timeoutMs = 120_000): Promise<string[]> {
    const content: Record<string, unknown>[] = [{ type: 'input_text', text: req.prompt }];
    for (const ref of req.referenceImages ?? []) content.push({ type: 'input_image', image_url: ref, detail: 'auto' });
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: '你是图像生成助手：按用户的描述生成一张图，不要解释，直接调用生图工具。',
      input: [{ type: 'message', role: 'user', content }],
      tools: [{ type: 'image_generation', size: req.size, quality: 'medium', output_format: 'png' }],
      tool_choice: { type: 'image_generation' },
      store: false,
      stream: true,
    };
    const res = await this.request(body, timeoutMs);
    const acc = emptyParsed();
    for await (const ev of this.events(res)) feedResponsesEvent(acc, ev);
    return acc.images;
  }

  async complete(
    messages: ChatMessage[],
    opts?: { temperature?: number; json?: boolean; timeoutMs?: number; tools?: ToolDef[] },
  ): Promise<LlmResult> {
    const res = await this.request(this.body(messages, { json: opts?.json, tools: opts?.tools }), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const acc = emptyParsed();
    for await (const ev of this.events(res)) feedResponsesEvent(acc, ev);
    let text = stripThinking(acc.text);
    if (opts?.json) text = stripJsonFences(text);
    // 推理项只挂在第一条调用上：回灌时 toResponsesInput 会把它放回 function_call 前面
    if (acc.toolCalls.length > 0 && acc.reasoningItem) acc.toolCalls[0] = { ...acc.toolCalls[0], reasoning: acc.reasoningItem };
    return {
      text,
      provider: this.name,
      model: this.model,
      mocked: false,
      usage: acc.usage,
      ...(acc.toolCalls.length > 0 ? { toolCalls: acc.toolCalls } : {}),
    };
  }
}
