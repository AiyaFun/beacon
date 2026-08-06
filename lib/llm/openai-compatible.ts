import type { ChatMessage, LlmProvider, LlmResult } from './types';

// 通用 OpenAI 兼容 provider：适配 DeepSeek / Qwen / Kimi / GLM / OpenAI / 任意兼容端点。
// 这是 BYOK（自定义接入不同 AI 接口）的执行层，也是平台默认模型（fromEnv）的执行层。

// ⚠️ 并非所有 OpenAI 兼容端点都支持 response_format:{type:'json_object'} 这个扩展字段。
// 实测：MiniMax(MiniMax-Text-01) 对该字段直接返回 400 "unknown response_format type 'json_object' (2013)"，
// DeepSeek/OpenAI 则原生支持。旧实现无脑发该字段 → MiniMax 上所有 json:true 调用（选题打分/
// 话题聚类/智囊团/人设）全部 400 → gateway 静默降级 Mock，用户拿到示例数据却看不出。
//
// 处理策略：首选带 response_format；若端点以 400 且**报文明确提到 response_format** 拒绝该字段，
// 则去掉 response_format 自动重试一次（改用系统提示约束"只输出纯 JSON"）。原生支持的端点行为不变；
// ⚠️ 只有在「去字段重试确实成功」后才把该端点记进 noNativeJson —— 否则一次与 response_format 无关的
// 瞬时 400 会把支持原生 json 的端点**永久毒化**降级（bug review 指出的坑）。重试仍失败 = 这个 400
// 多半不是 response_format 的锅，抛原始错误、不缓存。
const noNativeJson = new Set<string>();

// 单次请求默认超时预算。重试场景由调用方传更紧的值收敛最坏墙钟（见 lib/topic/scoring.ts）。
export const DEFAULT_TIMEOUT_MS = 30_000;

// 降级路径（无原生 json 模式）用的系统提示：parseJson 是严格 JSON.parse（lib/json.ts），
// 被 ``` 代码块或解释文字包裹就会兜底失败 → 必须让模型吐裸 JSON。
const JSON_NUDGE ='只输出合法的 JSON 本身，不要用 markdown 代码块（```）包裹，也不要任何解释性文字。';

/** 剥掉模型偶尔加的 ```json ... ``` 代码块围栏，返回可被严格 JSON.parse 的裸文本。 */
export function stripJsonFences(text: string): string {
  const t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fence ? fence[1] : t).trim();
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly mocked = false;
  private baseUrl: string;
  private apiKey: string;

  constructor(opts: { name: string; baseUrl: string; apiKey: string; model: string }) {
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  private get url(): string {
    return this.baseUrl.endsWith('/chat/completions') ? this.baseUrl : `${this.baseUrl}/chat/completions`;
  }

  private post(messages: ChatMessage[], temperature: number, nativeJson: boolean, timeoutMs?: number): Promise<Response> {
    const body: Record<string, unknown> = { model: this.model, messages, temperature };
    if (nativeJson) body.response_format = { type: 'json_object' };
    return fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      // 默认 30s 超时保护；调用方可给更紧的预算（重试场景，见 lib/topic/scoring.ts）
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  }

  async *stream(messages: ChatMessage[], opts?: { temperature?: number }): AsyncIterable<string> {
    const temperature = opts?.temperature ?? 0.7;
    const body: Record<string, unknown> = { model: this.model, messages, temperature, stream: true };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM stream 调用失败 ${res.status}: ${detail.slice(0, 200)}`);
    }
    if (!res.body) throw new Error('LLM stream: response body is null');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const chunk = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch { /* skip malformed SSE lines */ }
      }
    }
  }

  async complete(messages: ChatMessage[], opts?: { temperature?: number; json?: boolean; timeoutMs?: number }): Promise<LlmResult> {
    const temperature = opts?.temperature ?? 0.7;
    const wantJson = !!opts?.json;
    const capKey = `${this.baseUrl}::${this.model}`;
    // 该端点已知不支持原生 json 模式 → 直接走降级路径，不再撞一次 400
    const useNative = wantJson && !noNativeJson.has(capKey);

    // 降级路径补一条系统提示，最大化"裸 JSON"命中率
    const degradedMessages: ChatMessage[] = wantJson
      ? [{ role: 'system', content: JSON_NUDGE }, ...messages]
      : messages;

    let res = await this.post(useNative ? messages : degradedMessages, temperature, useNative, opts?.timeoutMs);

    // 端点以 400 且报文明确提到 response_format（如 MiniMax "unknown response_format type"）→ 去字段重试一次。
    // 判据必须含 "response_format" 字样：与该字段无关的通用参数错误（含裸错误码）不该触发降级重试。
    if (!res.ok && useNative && res.status === 400) {
      const detail = await res.text().catch(() => '');
      if (/response_format/i.test(detail)) {
        const retry = await this.post(degradedMessages, temperature, false, opts?.timeoutMs);
        if (retry.ok) {
          noNativeJson.add(capKey); // 仅在重试确实成功后才记忆，避免无关 400 永久毒化降级
          res = retry;
        } else {
          // 重试仍失败 = 这个 400 多半不是 response_format 的锅，抛原始错误、不缓存
          throw new Error(`LLM 调用失败 400: ${detail.slice(0, 200)}`);
        }
      } else {
        throw new Error(`LLM 调用失败 ${res.status}: ${detail.slice(0, 200)}`);
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM 调用失败 ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    let text = data.choices?.[0]?.message?.content ?? '';
    // json 模式下剥掉可能的代码块围栏，交给上层 parseJson（严格解析）时不至于兜底失败
    if (wantJson) text = stripJsonFences(text);
    return {
      text,
      provider: this.name,
      model: this.model,
      mocked: false,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
