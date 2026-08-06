import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { optimizeWorkspaceMemory, personaLearningProposals } from '@/lib/memory/optimize';

// 记忆持续学习优化：去重合并 / 达阈值生效 / 老旧低信度遗忘（降权不删）。

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '测试租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: '默认工作区' } });
});

function mem(data: Partial<Parameters<typeof prisma.memoryEntry.create>[0]['data']> & { content: string; type: string }) {
  return prisma.memoryEntry.create({
    data: {
      workspaceId: 'w1',
      type: data.type,
      content: data.content,
      confidence: data.confidence ?? 0.3,
      hitCount: data.hitCount ?? 1,
      active: data.active ?? false,
      updatedAt: data.updatedAt ?? new Date(),
    },
  });
}

describe('optimizeWorkspaceMemory', () => {
  it('去重合并：同内容两条 → 一条，hitCount 求和并生效', async () => {
    await mem({ type: 'preference', content: '偏好：精简', hitCount: 1, confidence: 0.3 });
    await mem({ type: 'preference', content: '偏好：精简。', hitCount: 1, confidence: 0.3 }); // 尾标点归一化后同一条
    const r = await optimizeWorkspaceMemory('w1');
    expect(r.merged).toBe(1);
    const rows = await prisma.memoryEntry.findMany({ where: { workspaceId: 'w1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].hitCount).toBe(2);
    expect(rows[0].active).toBe(true); // hitCount>=2 → 生效
  });

  it('达阈值生效：hitCount≥2 的未生效记忆被 promote', async () => {
    await mem({ type: 'preference', content: '偏好：多用案例', hitCount: 3, confidence: 0.4, active: false });
    const r = await optimizeWorkspaceMemory('w1');
    expect(r.promoted).toBe(1);
    const row = await prisma.memoryEntry.findFirst({ where: { workspaceId: 'w1' } });
    expect(row?.active).toBe(true);
  });

  it('遗忘：老旧+单次+低信度 → 降权停用，但不删除', async () => {
    await mem({ type: 'fact', content: '随手一记', hitCount: 1, confidence: 0.3, active: true, updatedAt: ago(100) });
    const r = await optimizeWorkspaceMemory('w1');
    expect(r.retired).toBe(1);
    const row = await prisma.memoryEntry.findFirst({ where: { workspaceId: 'w1' } });
    expect(row).not.toBeNull(); // 没被删
    expect(row?.active).toBe(false); // 只是降权停用
  });

  it('人设记忆永不遗忘', async () => {
    await mem({ type: 'persona', content: '我是数码测评博主', hitCount: 1, confidence: 0.3, active: true, updatedAt: ago(200) });
    const r = await optimizeWorkspaceMemory('w1');
    expect(r.retired).toBe(0);
    const row = await prisma.memoryEntry.findFirst({ where: { workspaceId: 'w1' } });
    expect(row?.active).toBe(true);
  });

  it('干净记忆：无变更时给出「已是最优」小结', async () => {
    await mem({ type: 'preference', content: '偏好：口语化', hitCount: 3, confidence: 0.8, active: true });
    const r = await optimizeWorkspaceMemory('w1');
    expect(r.merged + r.promoted + r.retired).toBe(0);
    expect(r.summaryText).toContain('最优');
  });
});

describe('personaLearningProposals · 只提议', () => {
  it('≥2 条生效偏好 → 提议固化进人设卡', () => {
    const proposals = personaLearningProposals([
      { type: 'preference', content: '偏好：精简', confidence: 0.8, hitCount: 3, active: true },
      { type: 'preference', content: '偏好：多案例', confidence: 0.7, hitCount: 2, active: true },
    ]);
    expect(proposals.some((p) => p.kind === 'persona')).toBe(true);
  });
  it('证据不足 → 无建议', () => {
    expect(personaLearningProposals([{ type: 'preference', content: '偏好：X', confidence: 0.3, hitCount: 1, active: false }])).toHaveLength(0);
  });
});
