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

// content 保持可以是纯字符串：绝大多数调用是纯文本，不该被多模态改造拖累可读性。
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

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
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly mocked: boolean;
  // timeoutMs：单次请求的超时预算。缺省 = provider 自己的默认值（30s）。
  // 存在的理由见 lib/topic/scoring.ts 的重试：第一次已经等掉 30s 了，重试再给 30s
  // 等于把最坏墙钟翻倍（真机实测 60.6s）；重试该给一个更紧的预算。
  complete(messages: ChatMessage[], opts?: { temperature?: number; json?: boolean; timeoutMs?: number }): Promise<LlmResult>;
  stream(messages: ChatMessage[], opts?: { temperature?: number }): AsyncIterable<string>;
}
