import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 复盘引擎三合一回流：reviewed 回写 + 曲线形态记忆 + advisor 人物战绩校准。
// 真 SQLite；stub LLM 网关返回「非 Mock 的合法 JSON」，才能触发回流（Mock 结果不回流是既有约定）。

const gw = vi.hoisted(() => ({ mocked: false }));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({
    text: JSON.stringify({
      headline: '这篇跑赢了同窗基线',
      shapeReason: '首日爆发说明钩子有效',
      causes: [{ factor: '开头3秒冲突前置', evidence: 'data' }],
      suggestions: ['把同款钩子复用到下一条'],
    }),
    mocked: gw.mocked,
    degraded: false,
  }),
}));
// 账号上下文里的记忆语义召回会打向量库，测试用 Mock 嵌入即可；这里只需 persona 块，走真实 prisma。

const { generateArticleReview } = await import('@/lib/insight/review');

let tenantId: string, workspaceId: string, accountId: string;

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: 'a', platform: 'douyin', personaCard: JSON.stringify({ identity: '测评博主', niche: '数码' }) },
  });
  return { tenantId: tenant.id, workspaceId: ws.id, accountId: acc.id };
}

// 给某记录造多日快照（首日爆发型）
async function addSnaps(publishId: string, pub: Date, pts: [number, number][]) {
  for (const [d, v] of pts) {
    await prisma.performanceSnapshot.create({
      data: { publishId, takenAt: new Date(pub.getTime() + d * 86_400_000), milestone: `D+${d}`, source: 'tikhub', metrics: JSON.stringify({ views: v }) },
    });
  }
}

beforeEach(async () => {
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.advisorOpinion.deleteMany();
  await prisma.advisorSession.deleteMany();
  await prisma.advisorPersona.deleteMany();
  await prisma.reviewReport.deleteMany();
  await prisma.memoryEntry.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  gw.mocked = false;
  const s = await seed();
  tenantId = s.tenantId;
  workspaceId = s.workspaceId;
  accountId = s.accountId;
});

describe('generateArticleReview 三合一回流', () => {
  it('非 Mock + 数据齐 → 落 ReviewReport、reviewed 回写、写形态记忆', async () => {
    const pub = new Date(Date.now() - 8 * 86_400_000);
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '选题', angle: '冲突前置', sourceType: 'hot', state: 'published', totalScore: 80 },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: 'p1', title: '爆款测评', topicId: topic.id, publishedAt: pub },
    });
    // 本篇首日爆发（高于同窗基线）
    await addSnaps(rec.id, pub, [[1, 400000], [2, 450000], [3, 470000]]);
    // 同平台 3 篇 peer，D+3 平均 ~100k（本篇 470k 远超 → over）
    for (let i = 0; i < 3; i++) {
      const p = await prisma.publishRecord.create({
        data: { accountId, platform: 'douyin', platformItemId: `peer${i}`, title: `p${i}`, publishedAt: new Date(pub.getTime() - (i + 1) * 5 * 86_400_000) },
      });
      await addSnaps(p.id, p.publishedAt!, [[1, 60000], [3, 100000]]);
    }

    const r = await generateArticleReview({ tenantId, accountId, workspaceId, publishId: rec.id });
    expect(r).not.toBeNull();
    expect(r!.mocked).toBe(false);
    expect(r!.verdict).toBe('over');
    expect(r!.shape).toBe('first_day_burst');
    expect(r!.baselineCompare?.sample).toBe(3);
    expect(r!.headline).toContain('同窗基线');

    // ReviewReport 落库
    expect(await prisma.reviewReport.count({ where: { accountId, kind: 'article', refId: rec.id } })).toBe(1);
    // reviewed 回写（published → reviewed）
    const t = await prisma.topicIdea.findUniqueOrThrow({ where: { id: topic.id } });
    expect(t.state).toBe('reviewed');
    // 曲线形态记忆写入（performance 类）
    const mem = await prisma.memoryEntry.findFirst({ where: { accountId, type: 'performance' } });
    expect(mem?.content).toContain('首日爆发型');
  });

  it('Mock 结果不回流：reviewed 不改、不写记忆', async () => {
    gw.mocked = true;
    const pub = new Date(Date.now() - 8 * 86_400_000);
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '选题', angle: 'x', sourceType: 'hot', state: 'published', totalScore: 70 },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: 'p1', title: 't', topicId: topic.id, publishedAt: pub },
    });
    await addSnaps(rec.id, pub, [[1, 400000], [3, 470000]]);

    const r = await generateArticleReview({ tenantId, accountId, workspaceId, publishId: rec.id });
    expect(r!.mocked).toBe(true);
    expect(await prisma.reviewReport.count()).toBe(1); // 报告仍留档
    const t = await prisma.topicIdea.findUniqueOrThrow({ where: { id: topic.id } });
    expect(t.state).toBe('published'); // 不回写
    expect(await prisma.memoryEntry.count({ where: { type: 'performance' } })).toBe(0);
  });

  it('advisor 来源 + over → 人物经验笔记追加数据验证条目', async () => {
    const pub = new Date(Date.now() - 8 * 86_400_000);
    const session = await prisma.advisorSession.create({ data: { accountId, status: 'done', summary: 's' } });
    const op = await prisma.advisorOpinion.create({
      data: { sessionId: session.id, personaKey: 'expert_data_analyst', personaName: '数据分析师', personaRole: 'expert', stance: 'x', suggestion: '做数码横评' },
    });
    await prisma.advisorPersona.create({
      data: { accountId, key: 'expert_data_analyst', name: '数据分析师', role: 'expert', emoji: '📈', stance: 'x', focus: '[]', source: 'builtin', learnedNotes: '[]' },
    });
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '数码横评', angle: 'x', sourceType: 'advisor', sourceRef: op.id, state: 'published', totalScore: 75 },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'douyin', platformItemId: 'p1', title: 't', topicId: topic.id, publishedAt: pub },
    });
    await addSnaps(rec.id, pub, [[1, 400000], [3, 470000]]);
    for (let i = 0; i < 3; i++) {
      const p = await prisma.publishRecord.create({
        data: { accountId, platform: 'douyin', platformItemId: `peer${i}`, title: `p${i}`, publishedAt: new Date(pub.getTime() - (i + 1) * 5 * 86_400_000) },
      });
      await addSnaps(p.id, p.publishedAt!, [[1, 60000], [3, 100000]]);
    }

    await generateArticleReview({ tenantId, accountId, workspaceId, publishId: rec.id });
    const persona = await prisma.advisorPersona.findFirstOrThrow({ where: { accountId, key: 'expert_data_analyst' } });
    expect(persona.learnedNotes).toContain('数据验证');
  });
});
