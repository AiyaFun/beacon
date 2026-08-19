import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { generateRecommendations } from '@/lib/pipeline';
import * as scoring from '@/lib/topic/scoring';
import type { ScoredTopic } from '@/lib/topic/scoring';

// 答案结构判定的落库侧（真 SQLite）。
//
// 单独一个文件而不是并进 angle-shape.test.ts：那边把 llm/gateway 整个 mock 掉了，
// 这里要跑真管线。两件事塞一个文件必然互相绊住。
//
// 为什么要有这个用例：ScoredTopic 上多一个字段最容易发生的事，是它到 createMany 那一步
// 被忘记写进 data —— 类型不会报（Prisma 的字段全是可选的），测试也照绿，
// 只有生产库里那一列永远是 null。这里把「精排判了 → 库里就得有」钉死。

const personaCard = JSON.stringify({
  identity: '前端工程师',
  audience: '前端新人',
  valueProp: '把复杂工具链讲明白',
  niche: '前端工程化',
  canDo: ['构建优化', '性能调优'],
  cantDo: [],
  tone: '干货',
  platforms: ['bilibili'],
});

async function seedAccount() {
  const tenant = await prisma.tenant.create({ data: { name: 't', plan: 'free' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, platform: 'bilibili', name: '测试账号', personaCard },
  });
  return { workspaceId: ws.id, accountId: account.id };
}

const scored = (over: Partial<ScoredTopic>): ScoredTopic => ({
  title: '前端工程化实践指南',
  angle: '对比 Vite 与 Webpack，按冷启动、增量构建、生态成熟度三个维度算账',
  rationale: '与人设一致。',
  scores: { traffic: 70, personaFit: 70, cost: 60, monetization: 50, compliance: 90, differentiation: 70 },
  totalScore: 70,
  sourceType: 'hot',
  relevant: true,
  mocked: true,
  llmDegraded: false,
  queue: 'today',
  ...over,
});

beforeEach(async () => {
  await prisma.hotItem.deleteMany();
  await prisma.topicIdea.deleteMany();
});

describe('答案结构判定落库', () => {
  it('🔒 精排判出的 angleShape 写进 TopicIdea', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await prisma.hotItem.create({ data: { source: 'douyin', rank: 1, title: '前端工程化实践指南', heat: 500 } });
    const spy = vi
      .spyOn(scoring, 'runScoring')
      .mockResolvedValue([scored({ angleShape: 'comparison' })]);

    await generateRecommendations(accountId, workspaceId, 1);
    const rows = await prisma.topicIdea.findMany({ where: { accountId, isExploration: false } });
    expect(rows).toHaveLength(1);
    expect(rows[0].angleShape).toBe('comparison');
    spy.mockRestore();
  });

  it('🔒 没判定就落 null，不补默认形状', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await prisma.hotItem.create({ data: { source: 'douyin', rank: 1, title: '前端工程化实践指南', heat: 500 } });
    const spy = vi.spyOn(scoring, 'runScoring').mockResolvedValue([scored({ angleShape: undefined })]);

    await generateRecommendations(accountId, workspaceId, 1);
    const rows = await prisma.topicIdea.findMany({ where: { accountId, isExploration: false } });
    expect(rows).toHaveLength(1);
    expect(rows[0].angleShape).toBeNull();
    spy.mockRestore();
  });
});
