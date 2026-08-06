import { describe, it, expect, vi } from 'vitest';
import type { PersonaCard } from '@/lib/persona';

// 精排返回非 JSON 时的兜底路径。Mock provider 永远返回合法 JSON，走不到这个分支，
// 只能把 gateway 替换成「真 provider 抽风」的样子来测（stub 的是 LLM 网关，不是 prisma）。
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: vi.fn(async () => ({
    text: '抱歉，我无法以 JSON 格式回答这个问题。',
    provider: 'real-x',
    model: 'x-1',
    mocked: false,
  })),
}));

import { finePrompt } from '@/lib/topic/scoring';
import { llmComplete } from '@/lib/llm/gateway';

const persona: PersonaCard = {
  identity: '前端工程师',
  audience: '前端新人',
  valueProp: '把复杂工具链讲明白',
  niche: '前端工程化',
  canDo: ['构建优化'],
  cantDo: [],
  tone: '干货',
  platforms: ['bilibili'],
} as PersonaCard;

const cand = { title: '前端工程化实践', heat: 0.5, sourceType: 'hot' as const };

describe('精排 JSON 解析失败的兜底', () => {
  it('回退默认分，并在 rationale 末尾如实说明「默认分」', async () => {
    const s = await finePrompt(null, cand, persona, '');
    expect(s.scores.traffic).toBe(60); // 默认分生效
    expect(s.rationale.endsWith('（默认分：AI 返回异常，本条排序参考性低）')).toBe(true);
    expect(s.mocked).toBe(false); // 真 provider 返回的异常不算 Mock，两种降级不许混标
  });

  it('解析成功时不追加「默认分」说明', async () => {
    vi.mocked(llmComplete).mockResolvedValueOnce({
      text: JSON.stringify({
        angle: '从反常识切入',
        scores: { traffic: 80, personaFit: 70, cost: 60, monetization: 50, compliance: 90, differentiation: 75 },
        rationale: '与人设方向一致。',
      }),
      provider: 'real-x',
      model: 'x-1',
      mocked: false,
    });
    const s = await finePrompt(null, cand, persona, '');
    expect(s.rationale).toBe('与人设方向一致。');
    expect(s.scores.traffic).toBe(80);
  });

  it('tenantId 原样传给 llmComplete（成本归属不许再挂 null）', async () => {
    await finePrompt('tenant-42', cand, persona, '');
    const calls = vi.mocked(llmComplete).mock.calls;
    expect(calls[calls.length - 1][0]).toBe('tenant-42');
    expect(calls[calls.length - 1][1]).toBe('scoring');
  });
});

// 候选源查出来的事实怎么进 prompt。
// 「无证据时不能提『已知事实』」这条是接真实模型实测出来的：一旦无条件把
// 「必须引用已知事实」写进 system prompt，模型会在压根没给证据的候选上自己编一段
// 「已知事实：……」，把推测包装成数据背书。
describe('证据注入', () => {
  const lastPrompt = () => {
    const calls = vi.mocked(llmComplete).mock.calls;
    const msgs = calls[calls.length - 1][2] as { role: string; content: string }[];
    return { system: msgs[0].content, user: msgs[1].content };
  };

  it('有证据 → 事实贴着选题进 user 消息，system 里才出现引用要求', async () => {
    await finePrompt(null, { ...cand, evidence: '你去年发过同题的《X》，3 万播放。', windowHint: '窗口约剩 12 小时' }, persona, '');
    const { system, user } = lastPrompt();
    expect(user).toContain('已知事实');
    expect(user).toContain('你去年发过同题的《X》');
    expect(user).toContain('时间窗口：窗口约剩 12 小时');
    expect(system).toContain('必须在 rationale 里引用它');
  });

  it('无证据 → user 只有选题本身，system 里「已知事实」四个字都不许出现', async () => {
    await finePrompt(null, cand, persona, '');
    const { system, user } = lastPrompt();
    expect(user).toBe('选题：前端工程化实践');
    expect(system).not.toContain('已知事实');
  });

  it('只有窗口没有证据 → 也不注入引用要求（没有事实可引用）', async () => {
    await finePrompt(null, { ...cand, windowHint: '窗口约剩 12 小时' }, persona, '');
    const { system, user } = lastPrompt();
    expect(user).toContain('时间窗口');
    expect(user).not.toContain('已知事实');
    expect(system).not.toContain('已知事实');
  });
});
