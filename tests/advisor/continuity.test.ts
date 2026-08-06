import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';
import { recentSessionsBlock } from '@/lib/advisor/panel';

// P1-7 会诊连续性：把最近几场的结论带进下一场，且演示（Mock）场次不许被当历史经验用。

let accountId = '';

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: 'continuity-test' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: 'a', platform: 'douyin' },
  });
  accountId = account.id;
});

async function seedSession(opts: { summary: string; seed?: string; adopted?: string }) {
  const s = await prisma.advisorSession.create({
    data: { accountId, trigger: 'manual', status: 'done', summary: opts.summary, topicSeed: opts.seed ?? null },
  });
  await prisma.advisorOpinion.create({
    data: {
      sessionId: s.id,
      personaKey: 'expert_data_analyst',
      personaName: '数据分析师',
      personaRole: 'expert',
      stance: '只看数据',
      suggestion: opts.adopted ?? '未被采纳的方向',
      adopted: opts.adopted ? true : null,
    },
  });
  return s;
}

describe('智囊团会诊连续性块', () => {
  it('无历史会诊时返回空串', async () => {
    expect(await recentSessionsBlock(accountId)).toBe('');
  });

  it('带出议题与已采纳提案，并要求不要原样重复', async () => {
    await seedSession({ summary: '正常会诊', seed: '五一假期蹭什么热点', adopted: '做一期假期避坑指南' });
    const block = await recentSessionsBlock(accountId);
    expect(block).toContain('【近期会诊回顾】');
    expect(block).toContain('五一假期蹭什么热点');
    expect(block).toContain('做一期假期避坑指南');
    expect(block).toContain('不要原样重复');
  });

  it('Mock/兜底场次（summary 带 ⚠ 前缀）不进历史——演示内容不能反过来当经验', async () => {
    await seedSession({ summary: '⚠ 本次部分人物为演示内容（AI 未接入…）', seed: '演示议题', adopted: '演示方向' });
    const block = await recentSessionsBlock(accountId);
    expect(block).not.toContain('演示议题');
    expect(block).not.toContain('演示方向');
  });

  it('无人被采纳的场次如实说明，不假装有结论', async () => {
    // 清掉前面的场次，只留一场「零采纳」
    await prisma.advisorSession.deleteMany({ where: { accountId } });
    await seedSession({ summary: '正常会诊', seed: '开放式那次' });
    const block = await recentSessionsBlock(accountId);
    expect(block).toContain('当时没有任何提案被采纳');
  });
});
