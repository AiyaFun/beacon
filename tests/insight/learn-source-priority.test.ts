import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';
import { learnFromPerformance, REVIEW_MARK } from '@/lib/insight/learn';
import { toJson } from '@/lib/json';

// 来源优先级在**真实链路上**生效：learnFromPerformance 下结论时，同一篇以高可信来源为准，
// 而不是 PublishRecord.metrics 上那个「谁最后写谁说了算」的值。
//
// 单测（source-priority.test.ts）锁的是挑选函数本身；这个文件锁的是它真的被接进了 learn ——
// 两者缺一不可：挑选函数写对了但没接上，线上行为一点没变。

let workspaceId = '';
let accountId = '';

// 基线：同平台 4 篇均 1000 播放（MIN_PEERS=3，够下结论）。
// **每个用例各用一个平台**：learn 的基线是「同账号同平台的其它所有发布」，
// 共用一个平台会让先跑的用例把后跑用例的基线抬走，测试变成执行顺序的函数。
async function seedBaseline(platform: string) {
  for (let i = 0; i < 4; i++) {
    await prisma.publishRecord.create({
      data: {
        accountId,
        platform,
        title: `基线${i}`,
        metrics: toJson({ views: 1000, likes: 10 }),
        publishedAt: new Date(Date.now() - (i + 5) * 86400000),
      },
    });
  }
}

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: 'src-priority-test' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: 'a', platform: 'douyin' },
  });
  workspaceId = ws.id;
  accountId = account.id;
  for (const p of ['douyin', 'bilibili', 'xiaohongshu']) await seedBaseline(p);
});

describe('learnFromPerformance · 同篇以高可信来源为准', () => {
  it('手填后写覆盖了官方值 → 仍按官方值下结论', async () => {
    const publishedAt = new Date(Date.now() - 8 * 86400000);
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '官方 vs 手填', angle: '来源优先级', rationale: '精排原文', state: 'drafting' },
    });
    const rec = await prisma.publishRecord.create({
      data: {
        accountId,
        topicId: topic.id,
        platform: 'douyin',
        title: '官方 vs 手填',
        publishedAt,
        // record 上留着的是手填的那个约数（后写覆盖）
        metrics: toJson({ views: 900 }),
      },
    });
    const at = new Date(publishedAt.getTime() + 7 * 86400000);
    await prisma.performanceSnapshot.create({
      data: { publishId: rec.id, takenAt: at, milestone: 'D+7', source: 'tikhub', metrics: toJson({ views: 5000 }) },
    });
    await prisma.performanceSnapshot.create({
      // 同一逻辑日、更晚写入的手填
      data: { publishId: rec.id, takenAt: new Date(at.getTime() + 3600_000), source: 'manual', metrics: toJson({ views: 900 }) },
    });

    const insights = await learnFromPerformance(accountId, workspaceId, rec.id);

    // 5000 / 1000 = 跑赢；若用手填的 900 会判成跑输，结论完全相反
    expect(insights.some((i) => i.kind === 'overperform')).toBe(true);
    expect(insights.some((i) => i.kind === 'underperform')).toBe(false);
    const after = await prisma.topicIdea.findUnique({ where: { id: topic.id } });
    expect(after?.rationale).toContain(REVIEW_MARK);
    expect(after?.rationale).toContain('5000');
    expect(after?.rationale).toContain('跑赢');
    // 切入角结论也应写成「被数据验证有效」而不是反向的「未跑出基线」。
    // 不断言 active：首次写入按设计只积累不生效（hitCount≥2 或 conf≥0.7 才 active），
    // 这里锁的是结论**方向**，不是它已经生效。
    const written = await prisma.memoryEntry.findMany({
      where: { accountId, type: 'preference', content: { contains: '来源优先级' } },
      select: { content: true },
    });
    expect(written.map((w) => w.content)).toContainEqual(expect.stringContaining('被数据验证有效'));
    expect(written.map((w) => w.content)).not.toContainEqual(expect.stringContaining('未跑出基线'));
  });

  it('陈旧官方值不压过更新的手填值 —— 长尾爆款不许被判成跑输', async () => {
    const publishedAt = new Date(Date.now() - 40 * 86400000);
    const rec = await prisma.publishRecord.create({
      data: { accountId, platform: 'bilibili', title: '长尾爆款', publishedAt, metrics: toJson({ views: 60000 }) },
    });
    // 官方只抓到了 D+1 的冷启动数（很低）
    await prisma.performanceSnapshot.create({
      data: {
        publishId: rec.id,
        takenAt: new Date(publishedAt.getTime() + 86400000),
        milestone: 'D+1',
        source: 'tikhub',
        metrics: toJson({ views: 200 }),
      },
    });
    // 用户 D+30 手填了长尾之后的真实值
    await prisma.performanceSnapshot.create({
      data: {
        publishId: rec.id,
        takenAt: new Date(publishedAt.getTime() + 30 * 86400000),
        source: 'manual',
        metrics: toJson({ views: 60000 }),
      },
    });

    const insights = await learnFromPerformance(accountId, workspaceId, rec.id);

    expect(insights.some((i) => i.kind === 'overperform')).toBe(true);
    expect(insights.some((i) => i.kind === 'underperform')).toBe(false);
  });

  it('无快照的历史记录 → 回落 record.metrics，照常下结论', async () => {
    const rec = await prisma.publishRecord.create({
      data: {
        accountId,
        platform: 'xiaohongshu',
        title: '无快照老记录',
        publishedAt: new Date(Date.now() - 9 * 86400000),
        metrics: toJson({ views: 4000 }),
      },
    });
    const insights = await learnFromPerformance(accountId, workspaceId, rec.id);
    expect(insights.some((i) => i.kind === 'overperform')).toBe(true);
  });
});
