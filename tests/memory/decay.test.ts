import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { recallForInjection } from '@/lib/memory/core';

// 遗忘衰减：注入排序分 = confidence × 半衰期衰减（30 天，下限 0.2）。
// 真 SQLite 直插记忆行（updatedAt 显式指定——@updatedAt 只在未传值时自动填充），
// 然后走真实的 recallForInjection 验证排序与截断。

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '测试租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: '默认工作区' } });
});

function seed(content: string, confidence: number, updatedAt: Date) {
  return prisma.memoryEntry.create({
    data: { workspaceId: 'w1', type: 'preference', content, confidence, hitCount: 1, active: true, updatedAt },
  });
}

describe('recallForInjection · 时间衰减排序', () => {
  it('同置信度：新记忆排在老记忆前面', async () => {
    await seed('老结论', 0.8, ago(60));
    await seed('新结论', 0.8, ago(0));
    const lines = await recallForInjection('w1');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('新结论');
    expect(lines[1]).toContain('老结论');
  });

  it('老记忆的高置信度会被衰减反超：90 天前的 1.0 排在今天的 0.5 后面', async () => {
    // 老条目：1.0 × max(0.2, 0.5^3) = 0.2；新条目：0.5 × 1 = 0.5
    await seed('三个月前的铁律', 1.0, ago(90));
    await seed('这周刚学到的', 0.5, ago(0));
    const lines = await recallForInjection('w1');
    expect(lines[0]).toContain('这周刚学到的');
  });

  it('下限 0.2 兜底：一年前的老记忆没被清零，仍能压过极低置信度的新条目', async () => {
    // 无下限时 0.5^(365/30) ≈ 0.0002，一年前的 1.0 会输给 0.15；有下限则 0.2 > 0.15
    await seed('一年前的经验', 1.0, ago(365));
    await seed('随手一记', 0.15, ago(0));
    const lines = await recallForInjection('w1');
    expect(lines).toHaveLength(2); // 老记忆没消失
    expect(lines[0]).toContain('一年前的经验');
  });

  it('超过 12 条时按衰减后的分截断：老高置信条目会被挤出注入位', async () => {
    // 12 条今天的 0.5（分 0.5）+ 1 条 60 天前的 0.9（分 0.9×0.25 = 0.225）→ 老条目落选。
    // 旧实现（纯 confidence 降序）它会排第一——这正是要修的「长期偏向老记忆」。
    for (let i = 0; i < 12; i++) await seed(`新结论${i}`, 0.5, ago(0));
    await seed('两个月前的高置信老结论', 0.9, ago(60));
    const lines = await recallForInjection('w1');
    expect(lines).toHaveLength(12);
    expect(lines.join('\n')).not.toContain('两个月前的高置信老结论');
  });

  it('有界 DB 读不伤正确性：一批老低置信记忆压不掉 12 条新鲜条目，且输出仍截到 12', async () => {
    // DB 侧按 confidence 降序有界读 + JS 衰减重排。这里放 12 条今天的 0.6（分 0.6）
    // 和 30 条 200 天前的 0.4（分 0.4×0.2=0.08，远低）。confidence 降序会先把 0.4 的排前面，
    // 但衰减重排后它们全在 12 名之外——锁死「DB 读顺序不覆盖衰减排序、老条目不霸位」。
    for (let i = 0; i < 12; i++) await seed(`本周新结论${i}`, 0.6, ago(0));
    for (let i = 0; i < 30; i++) await seed(`大半年前的旧结论${i}`, 0.4, ago(200));
    const lines = await recallForInjection('w1');
    expect(lines).toHaveLength(12);
    expect(lines.every((l) => l.includes('本周新结论'))).toBe(true);
  });

  it('active=false 的记忆无论多新都不注入', async () => {
    await prisma.memoryEntry.create({
      data: { workspaceId: 'w1', type: 'preference', content: '已下线的结论', confidence: 0.9, active: false },
    });
    await seed('生效中的结论', 0.3, ago(0));
    const lines = await recallForInjection('w1');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('生效中的结论');
  });
});
