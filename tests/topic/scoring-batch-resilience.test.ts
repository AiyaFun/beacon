import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PersonaCard } from '@/lib/persona';

// 2026-09-01 生产排查的落点：daily_recommend 每天 05:00 稳定有 ~20 次精排首调失败，
// 近 14 天有 11 条选题带着占位分过夜。两个放大器：
//   ① Promise.all 把 topN 条一口气全打到供应商（每账号 6 连发、几十个账号排队发）；
//   ② 降级后**立即**重试——正落在同一个限流/抖动窗口里，第二枪打在同一堵墙上。
// 这个文件钉住修法：精排最多 4 路在途；降级重试前退避 ≥2s。

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: vi.fn(),
}));

import { finePrompt, runScoring } from '@/lib/topic/scoring';
import { llmComplete } from '@/lib/llm/gateway';

const persona: PersonaCard = {
  identity: '前端工程师', audience: '前端新人', valueProp: '讲明白', niche: '前端',
  canDo: [], cantDo: [], tone: '干货', platforms: ['bilibili'],
} as PersonaCard;

const okJson = JSON.stringify({
  angle: '从反常识切入',
  scores: { traffic: 80, personaFit: 70, cost: 60, monetization: 50, compliance: 90, differentiation: 75 },
  rationale: 'ok',
});
const real = { text: okJson, provider: 'real-x', model: 'x-1', mocked: false };

beforeEach(() => {
  vi.mocked(llmComplete).mockReset();
  vi.useRealTimers();
});

describe('精排的批处理韧性', () => {
  it('🔒 并发有界：10 条候选同时在途绝不超过 4', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(llmComplete).mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return real;
    });
    const cands = Array.from({ length: 10 }, (_, i) => ({
      title: `候选${i}`, heat: 0.5, sourceType: 'hot' as const,
    }));
    await runScoring(null, cands, persona, '', 10);
    expect(vi.mocked(llmComplete).mock.calls.length).toBe(10); // 都精排到了，没有静默丢
    expect(peak, `同时在途峰值 ${peak}，又回到全发了`).toBeLessThanOrEqual(4);
    expect(peak, '池子形同虚设（串行也能过≤4，但那是另一种坏）').toBeGreaterThan(1);
  });

  it('🔒 降级重试前有 ≥2s 退避（立即重试对限流无效）', async () => {
    vi.useFakeTimers();
    const stamps: number[] = [];
    vi.mocked(llmComplete).mockImplementation(async () => {
      stamps.push(Date.now());
      // 第一枪降级、第二枪成功
      return stamps.length === 1
        ? { text: okJson, provider: 'mock', model: 'beacon-mock-v1', mocked: true, degraded: true }
        : real;
    });
    const p = finePrompt(null, { title: 'x', heat: 0.5, sourceType: 'hot' as const }, persona, '');
    await vi.advanceTimersByTimeAsync(10_000);
    const s = await p;
    expect(stamps.length).toBe(2); // 确实重试了
    const gap = stamps[1] - stamps[0];
    expect(gap, `重试间隔只有 ${gap}ms —— 又改回立即重试了`).toBeGreaterThanOrEqual(2_000);
    expect(s.mocked).toBe(false); // 重试成功后用的是真结果
  });

  it('重试仍降级 → 保留降级标（llmDegraded），供选题页亮「AI 调用失败」和重评按钮', async () => {
    vi.useFakeTimers();
    vi.mocked(llmComplete).mockResolvedValue({
      text: okJson, provider: 'mock', model: 'beacon-mock-v1', mocked: true, degraded: true,
    });
    const p = finePrompt(null, { title: 'x', heat: 0.5, sourceType: 'hot' as const }, persona, '');
    await vi.advanceTimersByTimeAsync(10_000);
    const s = await p;
    expect(s.mocked).toBe(true);
    expect(s.llmDegraded).toBe(true);
  });
});
