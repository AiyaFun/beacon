import { describe, it, expect, vi, beforeEach } from 'vitest';
import { llmSemanticReview } from '@/lib/compliance/semantic';

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: vi.fn(),
}));

const { llmComplete } = await import('@/lib/llm/gateway');
const mockLlm = vi.mocked(llmComplete);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LLM 语义审核 (F6-3)', () => {
  it('短文本跳过 LLM 调用', async () => {
    const r = await llmSemanticReview('很短', 'douyin', 'tenant-1', []);
    expect(r.hits).toEqual([]);
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('解析 LLM 返回的语义命中', async () => {
    mockLlm.mockResolvedValueOnce({
      text: JSON.stringify([
        { snippet: '亲测有效', reason: '隐含疗效承诺', action: 'warn', suggestion: '使用后个人感受不错' },
        { snippet: '最后3名', reason: '虚假紧迫感', action: 'suggest', suggestion: '名额有限' },
      ]),
      mocked: false,
      provider: 'test',
      model: 'test',
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    const r = await llmSemanticReview(
      '这款产品亲测有效，最后3名优惠价，错过不再有',
      'douyin',
      'tenant-1',
      [],
    );

    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]).toEqual({
      snippet: '亲测有效',
      reason: '隐含疗效承诺',
      action: 'warn',
      suggestion: '使用后个人感受不错',
    });
    expect(r.hits[1].action).toBe('suggest');
    expect(r.mocked).toBe(false);
  });

  it('DFA 已捕获的词会传入 prompt 避免重复', async () => {
    mockLlm.mockResolvedValueOnce({
      text: '[]',
      mocked: true,
      provider: 'mock',
      model: 'mock',
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    await llmSemanticReview(
      '这是最好的产品，全网第一',
      'douyin',
      'tenant-1',
      [
        { word: '最好', tier: 'legal', action: 'block', start: 2, end: 4 },
        { word: '第一', tier: 'legal', action: 'block', start: 8, end: 10 },
      ],
    );

    const call = mockLlm.mock.calls[0];
    const sysMsg = call[2][0].content;
    expect(sysMsg).toContain('最好');
    expect(sysMsg).toContain('第一');
  });

  it('LLM 返回非法 JSON 时优雅降级', async () => {
    mockLlm.mockResolvedValueOnce({
      text: '这不是合法的JSON',
      mocked: true,
      provider: 'mock',
      model: 'mock',
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const r = await llmSemanticReview('一段足够长的测试文案用于触发语义审核', 'douyin', 'tenant-1', []);
    expect(r.hits).toEqual([]);
  });

  it('LLM 抛异常时优雅降级', async () => {
    mockLlm.mockRejectedValueOnce(new Error('quota exceeded'));

    const r = await llmSemanticReview('一段足够长的测试文案用于触发语义审核', 'douyin', 'tenant-1', []);
    expect(r.hits).toEqual([]);
    expect(r.mocked).toBe(false);
  });

  it('最多返回 10 条命中', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      snippet: `问题${i}`,
      reason: `原因${i}`,
      action: 'warn',
      suggestion: `建议${i}`,
    }));
    mockLlm.mockResolvedValueOnce({
      text: JSON.stringify(many),
      mocked: false,
      provider: 'test',
      model: 'test',
      usage: { promptTokens: 100, completionTokens: 200 },
    });

    const r = await llmSemanticReview('足够长的文案内容用于测试截断逻辑的处理', 'douyin', 'tenant-1', []);
    expect(r.hits).toHaveLength(10);
  });

  it('LLM 返回非数组时优雅降级', async () => {
    mockLlm.mockResolvedValueOnce({
      text: JSON.stringify({ error: 'not an array' }),
      mocked: false,
      provider: 'test',
      model: 'test',
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    const r = await llmSemanticReview('一段足够长的测试文案用于触发语义审核', 'douyin', 'tenant-1', []);
    expect(r.hits).toEqual([]);
  });

  it('过滤掉缺少必填字段的条目', async () => {
    mockLlm.mockResolvedValueOnce({
      text: JSON.stringify([
        { snippet: '有效片段', reason: '有效原因', action: 'warn', suggestion: '建议' },
        { reason: '缺少 snippet' },
        { snippet: '缺少 reason' },
        null,
      ]),
      mocked: false,
      provider: 'test',
      model: 'test',
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    const r = await llmSemanticReview('一段足够长的测试文案用于触发语义审核', 'douyin', 'tenant-1', []);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].snippet).toBe('有效片段');
  });

  it('mock 标记正确传递', async () => {
    mockLlm.mockResolvedValueOnce({
      text: JSON.stringify([{ snippet: '测试', reason: '测试原因', action: 'warn', suggestion: '' }]),
      mocked: true,
      provider: 'mock',
      model: 'mock',
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    const r = await llmSemanticReview('一段足够长的测试文案用于触发语义审核', 'douyin', 'tenant-1', []);
    expect(r.mocked).toBe(true);
  });
});
