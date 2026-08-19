import { describe, it, expect } from 'vitest';
import { looksNonChatModel, AUTH_ERROR_RE } from '@/lib/constants';

// 连通性测试的两个判据。
//
// 守的是这个洞：填了即梦（图像模型）的豆包渠道，chat ping 必然报错 → 曾被判 status='failed'
// → lib/llm/image.ts 的 resolveImageProvider 过滤 not:'failed' 把它排除 → 用户明明配了 Key，
// 封面却报「还没有可用的生图渠道」。判据错一点，症状就是「配了却用不了」且查不出原因。

describe('looksNonChatModel', () => {
  it('认出即梦 / 视频生成这类非对话模型', () => {
    for (const m of ['doubao-seedream-4-0-250828', 'doubao-seedream-5-0-260128', 'doubao-seededit-3-0', 'doubao-seedance-1-0-pro', 'gpt-image-1', '即梦4.0', 'wan-t2v-plus', 'foo-i2v']) {
      expect(looksNonChatModel(m), m).toBe(true);
    }
  });

  it('对话模型不误判（误判会让真正坏掉的 Key 被当成好的）', () => {
    for (const m of ['doubao-pro-32k', 'deepseek-chat', 'qwen-max', 'moonshot-v1-8k', 'glm-4', 'gpt-4o']) {
      expect(looksNonChatModel(m), m).toBe(false);
    }
  });

  it('空 / undefined 不炸', () => {
    expect(looksNonChatModel('')).toBe(false);
    expect(looksNonChatModel(undefined as unknown as string)).toBe(false);
  });
});

describe('AUTH_ERROR_RE', () => {
  it('认证类错误命中 → 判 failed（Key 真的坏了）', () => {
    for (const m of [
      'LLM 调用失败 401: {"error":"invalid api key"}',
      'LLM 调用失败 403: forbidden',
      'Unauthorized',
      'authentication error',
      '鉴权失败',
    ]) {
      expect(AUTH_ERROR_RE.test(m), m).toBe(true);
    }
  });

  it('模型不存在 / 参数不合法不算认证错（非对话模型时应放行为 ok）', () => {
    for (const m of [
      'LLM 调用失败 404: model not found',
      'LLM 调用失败 400: {"error":{"message":"the model does not support chat completions"}}',
      'fetch failed',
    ]) {
      expect(AUTH_ERROR_RE.test(m), m).toBe(false);
    }
  });
});
