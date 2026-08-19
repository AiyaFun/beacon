// 多模态消息片段（OpenAI 兼容口径）。图片用 data: URI 内联，不外链——
// 截图属于用户后台私域数据，不该为了让模型能取而先把它挂到公网地址上。
//
// video_url 是火山方舟豆包视频理解的口径，与图片有一处**关键差别**：
// url 传公网地址时，是**方舟的服务器去拉取**它，不是我们。这决定了两件事：
//   ① 抖音/B站/小红书/视频号的播放地址（带签名 + 防盗链 + 时效）方舟一样取不到，
//      别指望「贴个作品链接就能分析」——那条路在 lib/video/analyze.ts 里被显式挡掉了；
//   ② 用户本地的文件走 data: URI 内联，和截图同一个理由：不为了让模型能取而先把
//      用户的素材挂到公网上。
// fps = 抽帧频率，取值 [0.2, 5]，越低越省 token（长视频靠它控成本）。
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string; fps?: number } };

// ── 工具调用（OpenAI function calling 口径）─────────────────────────────────
//
// 这套类型是「AI 全域调用系统」的地基：模型不再只吐文本，而是说「我要调用 create_draft，
// 参数是这些」，由 lib/agent/run.ts 决定**要不要真的执行**（写操作一律先问用户）。
//
// 为什么用 OpenAI 口径而不自定义：BYOK 白名单里的十几家（DeepSeek/Qwen/Kimi/GLM/豆包…）
// 全都实现了这套字段。自定义格式意味着每家写一个适配层，且模型没见过、命中率更差。

/** 工具定义。parameters 是 JSON Schema（模型据此产出参数）。 */
export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** 模型请求的一次调用。arguments 是**字符串化的 JSON**（模型可能吐坏，解析放在执行层做）。 */
export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

// content 保持可以是纯字符串：绝大多数调用是纯文本，不该被多模态改造拖累可读性。
//
// 两个为工具调用增加的角色：
//   assistant + toolCalls —— 模型说「我要调这些工具」（此时 content 常为空）；
//   tool + toolCallId     —— 我们把执行结果回灌给模型（必须与请求的 id 对上，否则多数端点 400）。
export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | ContentPart[]; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

/** 取消息的纯文本部分（Mock 路由、日志、长度估算用；图片片段忽略）。 */
export function messageText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n');
}

/** 这条消息里带图吗——用来判断该不该走视觉模型。 */
export function hasImage(messages: ChatMessage[]): boolean {
  return messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'image_url'));
}

/** 这条消息里带视频吗——用来判断该不该走视频模型（见 llmVideo）。 */
export function hasVideo(messages: ChatMessage[]): boolean {
  return messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'video_url'));
}

export type LlmResult = {
  text: string;
  provider: string;
  model: string;
  mocked: boolean;
  usage?: { promptTokens: number; completionTokens: number };
  /** 模型这一轮请求调用的工具（没请求时缺省）。 */
  toolCalls?: ToolCall[];
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly mocked: boolean;
  // timeoutMs：单次请求的超时预算。缺省 = provider 自己的默认值（30s）。
  // 存在的理由见 lib/topic/scoring.ts 的重试：第一次已经等掉 30s 了，重试再给 30s
  // 等于把最坏墙钟翻倍（真机实测 60.6s）；重试该给一个更紧的预算。
  complete(
    messages: ChatMessage[],
    opts?: { temperature?: number; json?: boolean; timeoutMs?: number; tools?: ToolDef[] },
  ): Promise<LlmResult>;
  stream(messages: ChatMessage[], opts?: { temperature?: number }): AsyncIterable<string>;
}
