import { describe, it, expect, beforeAll, vi } from 'vitest';

// P1-8 智囊团提案走精排：分数要真的由 LLM 六维产生，而不是拍一个 75。
// stub 的是 LLM 网关（不是 prisma）——账号上下文仍走真库。
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: vi.fn(async () => ({
    text: JSON.stringify({
      angle: '从教练视角拆解常见错误',
      scores: { traffic: 82, personaFit: 78, cost: 60, monetization: 55, compliance: 90, differentiation: 70 },
      rationale: '与账号被验证过的方向一致。',
    }),
    provider: 'real-x',
    model: 'x-1',
    mocked: false,
  })),
}));

import { prisma } from '@/lib/db';
import { scoreAdvisorProposal } from '@/lib/advisor/proposal';
import { llmComplete } from '@/lib/llm/gateway';

let workspaceId = '';
let accountId = '';

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: 'proposal-test' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
  const account = await prisma.creatorAccount.create({
    data: {
      workspaceId: ws.id,
      name: 'a',
      platform: 'douyin',
      personaCard: JSON.stringify({ identity: '健身教练', niche: '健身', canDo: ['增肌'], cantDo: [], platforms: ['douyin'] }),
    },
  });
  workspaceId = ws.id;
  accountId = account.id;
});

describe('智囊团提案精排', () => {
  it('返回六维分与总分，口径与每日推荐一致（不再是固定 75）', async () => {
    const r = await scoreAdvisorProposal({
      tenantId: 't1',
      workspaceId,
      accountId,
      suggestion: '做一期新手深蹲常见错误',
      rationale: '数据分析师认为这个方向历史表现好',
    });
    expect(r).not.toBeNull();
    expect(r!.scores.traffic).toBe(82);
    expect(r!.totalScore).not.toBe(75);
    expect(r!.angle).toBe('从教练视角拆解常见错误');
    // 人物的原始理由保留，精排理由追加在后——两种依据都要能追溯
    expect(r!.rationale).toContain('数据分析师认为这个方向历史表现好');
    expect(r!.rationale).toContain('与账号被验证过的方向一致。');
  });

  it('成本归属：tenantId 与 scoring 用途原样传给网关', async () => {
    await scoreAdvisorProposal({ tenantId: 'tenant-42', workspaceId, accountId, suggestion: 'x', rationale: '' });
    const calls = vi.mocked(llmComplete).mock.calls;
    expect(calls[calls.length - 1][0]).toBe('tenant-42');
    expect(calls[calls.length - 1][1]).toBe('scoring');
  });

  it('精排失败返回 null，交调用方兜底——采纳动作本身不能被 LLM 抖动搞失败', async () => {
    vi.mocked(llmComplete).mockRejectedValueOnce(new Error('通道炸了'));
    const r = await scoreAdvisorProposal({ tenantId: 't1', workspaceId, accountId, suggestion: 'y', rationale: '' });
    expect(r).toBeNull();
  });
});
