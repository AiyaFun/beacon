// LLM 成本估算（USD/1M tokens）。用于单租户单位经济与毛利护栏。
// 生产按实际供应商价目维护；未知模型用保守默认。

type Price = { in: number; out: number };

const PRICES: Record<string, Price> = {
  // 国产便宜档（打分/精排/复检用）
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'qwen-plus': { in: 0.4, out: 1.2 },
  'glm-4-flash': { in: 0.1, out: 0.1 },
  // 生成用强模型
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  // Mock 免费
  'beacon-mock-v1': { in: 0, out: 0 },
};

const DEFAULT: Price = { in: 0.5, out: 1.5 };

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number, mocked: boolean): number {
  if (mocked) return 0;
  const p = PRICES[model] ?? DEFAULT;
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

// 图像按**张**计费，与 token 无关，单开一个估算。即梦 Seedream 4.0 约 ¥0.2/张 ≈ $0.03。
// 保守取一个偏高的默认，宁可把毛利算得紧一点也不要低估图像成本（它比一次文本调用贵一到两个量级）。
const IMAGE_PRICE_PER_CALL_USD: Record<string, number> = {
  'doubao-seedream-4-0-250828': 0.03,
  'doubao-seedream-3-0-t2i-250415': 0.03,
};
const DEFAULT_IMAGE_PRICE_USD = 0.04;

/** 单次图像生成的估算成本（USD/张）。未知模型用保守默认。 */
export function estimateImageCostUsd(model: string): number {
  return IMAGE_PRICE_PER_CALL_USD[model] ?? DEFAULT_IMAGE_PRICE_USD;
}
