import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { jaccard, topicClashRate, complianceFalsePositiveRate, CLASH_THRESHOLD } from '@/lib/insight/guardrails';
import { textShingles } from '@/lib/topic/scoring';

// 「安全线」这两条指标 2026-07-30 从占位变成真算。真 SQLite。
// 核心口径：**样本不足时不出数**——0/0 显示成 0% 会被当成「很好」，那比空着更糟。

let tenantId: string, workspaceId: string, accountId: string;

beforeEach(async () => {
  await prisma.topicIdea.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'xiaohongshu' } });
  tenantId = tenant.id;
  workspaceId = ws.id;
  accountId = acc.id;
});

const addTopic = (title: string) =>
  prisma.topicIdea.create({ data: { accountId, title, angle: 'x', state: 'recommended' } });

async function addRival(titles: string[]) {
  const c = await prisma.competitorAccount.create({
    data: { platform: 'xiaohongshu', handle: `rival-${titles.length}`, name: '竞对' },
  });
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId: c.id } });
  for (let i = 0; i < titles.length; i++) {
    await prisma.crawledPost.create({
      data: {
        competitorId: c.id,
        platform: 'xiaohongshu',
        platformItemId: `p-${i}-${Math.random()}`,
        title: titles[i],
        publishedAt: new Date(Date.now() - 86400_000),
      },
    });
  }
}

describe('撞题率与合规误报率', () => {
  it('Jaccard：空集算 0，不算 1', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['ab']), new Set())).toBe(0);
    expect(jaccard(new Set(['ab', 'bc']), new Set(['ab', 'bc']))).toBe(1);
  });

  it('阈值能分开「同一件事的两种说法」和「不相干」', () => {
    const a = textShingles('小红书涨粉的三个方法');
    const near = textShingles('小红书涨粉方法三个');
    const far = textShingles('新能源车企年报解读');
    expect(jaccard(a, near)).toBeGreaterThanOrEqual(CLASH_THRESHOLD);
    expect(jaccard(a, far)).toBeLessThan(CLASH_THRESHOLD);
  });

  it('选题不足 5 条 → 不出数并说明原因', async () => {
    await addTopic('只有一条');
    const r = await topicClashRate(workspaceId, accountId);
    expect(r.state).toBe('insufficient');
    expect(r.note).toContain('5 条');
  });

  it('有选题但没订阅竞对 → 指路而不是给 0%', async () => {
    for (let i = 0; i < 6; i++) await addTopic(`选题${i}`);
    const r = await topicClashRate(workspaceId, accountId);
    expect(r.state).toBe('insufficient');
    expect(r.note).toContain('竞对');
  });

  it('竞对作品太少（<10 条）也不出数', async () => {
    for (let i = 0; i < 6; i++) await addTopic(`选题${i}`);
    await addRival(['竞对作品一', '竞对作品二']);
    const r = await topicClashRate(workspaceId, accountId);
    expect(r.state).toBe('insufficient');
    expect(r.note).toContain('10 条');
  });

  it('样本够了就出真数：撞上的那几条被算进去', async () => {
    const clashing = ['小红书涨粉的三个方法', '普通人做 IP 的正确路径'];
    const clean = ['深海鱼类的洄游规律', '宋代点茶法复原实录', '铁路信号系统入门'];
    for (const t of [...clashing, ...clean]) await addTopic(t);
    await addRival([
      '小红书涨粉方法三个',
      '普通人做 IP 正确的路径',
      ...Array.from({ length: 10 }, (_, i) => `无关作品${i}`),
    ]);
    const r = await topicClashRate(workspaceId, accountId);
    expect(r.state).toBe('ok');
    if (r.state === 'ok') {
      expect(r.sample).toBe(5);
      expect(r.pct).toBe(40); // 2/5
      expect(r.note).toContain('2/5');
    }
  });

  it('没有合规命中 → 不出数（0/0 不许显示成 0%）', async () => {
    const r = await complianceFalsePositiveRate(tenantId);
    expect(r.state).toBe('insufficient');
    expect(r.note).toContain('没有合规命中');
  });
});
