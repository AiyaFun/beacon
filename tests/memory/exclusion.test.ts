import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { learnFromPerformance } from '@/lib/insight/learn';

// 矛盾记忆互斥：同一切入角在同一平台的「被数据验证有效」与「未跑出基线」不能同时 active。
// 走真实回流学习路径（真 SQLite + buildBaseline），不直接戳内部函数——
// 要防的失败模式恰恰是「互斥逻辑写了但没挂在写入路径上」。

const PROVEN = '切入角「反常识」在抖音被数据验证有效';
const FAILED = '切入角「反常识」在抖音未跑出基线';

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '测试租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: '默认工作区' } });
  await prisma.creatorAccount.create({
    data: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin', personaCard: '{}' },
  });
  await prisma.topicIdea.create({
    data: { id: 'topic1', accountId: 'a1', title: '测试选题', angle: '反常识' },
  });
  // 3 条基线发布（满 MIN_PEERS，views=100）
  for (let i = 0; i < 3; i++) {
    await prisma.publishRecord.create({
      data: { accountId: 'a1', platform: 'douyin', title: `基线${i}`, metrics: '{"views":100}' },
    });
  }
});

// 发一条带切入角的内容并触发回流学习
async function publishAndLearn(views: number) {
  const rec = await prisma.publishRecord.create({
    data: { accountId: 'a1', platform: 'douyin', topicId: 'topic1', title: '带角内容', metrics: `{"views":${views}}` },
  });
  return learnFromPerformance('a1', 'w1', rec.id);
}

const angleMemory = (content: string) =>
  prisma.memoryEntry.findFirst({ where: { workspaceId: 'w1', accountId: 'a1', type: 'preference', content } });

describe('learnFromPerformance · 切入角正反结论互斥', () => {
  it('写入反向结论后，旧结论 active=false 但 hitCount 保留（不删只下线）', async () => {
    // 两次跑输 → 负向结论累计生效
    await publishAndLearn(40);
    await publishAndLearn(40);
    let failed = await angleMemory(FAILED);
    expect(failed?.active).toBe(true);
    expect(failed?.hitCount).toBe(2);

    // 一次跑赢 → 负向被下线，正向落库
    await publishAndLearn(500);
    failed = await angleMemory(FAILED);
    expect(failed?.active).toBe(false);
    expect(failed?.hitCount).toBe(2); // 命中记录不清零，将来数据反转还能累计回来
    expect(await angleMemory(PROVEN)).toBeTruthy();
  });

  it('同向结论不受互斥影响，照旧去重累计直至生效', async () => {
    await publishAndLearn(40);
    await publishAndLearn(40);
    await publishAndLearn(500); // 互斥触发点
    await publishAndLearn(500); // 同向第二次：累计而非新建
    const proven = await angleMemory(PROVEN);
    expect(proven?.hitCount).toBe(2);
    expect(proven?.active).toBe(true);
    // 负向仍处于下线状态
    expect((await angleMemory(FAILED))?.active).toBe(false);
  });

  it('数据再度反转时能翻回来：正向下线、负向重新累计生效', async () => {
    await publishAndLearn(40);
    await publishAndLearn(40);
    await publishAndLearn(500);
    await publishAndLearn(500);
    await publishAndLearn(20); // 明显跑输（此刻基线已被 500 抬高）
    expect((await angleMemory(PROVEN))?.active).toBe(false);
    const failed = await angleMemory(FAILED);
    expect(failed?.active).toBe(true);
    expect(failed?.hitCount).toBe(3);
  });

  it('互斥只打击同一切入角的反向结论，别的角的记忆一根汗毛都不动', async () => {
    const other = await prisma.memoryEntry.create({
      data: {
        workspaceId: 'w1', accountId: 'a1', type: 'preference',
        content: '切入角「对比实验」在抖音未跑出基线', confidence: 0.55, hitCount: 2, active: true,
      },
    });
    await publishAndLearn(500); // 「反常识」跑赢
    const untouched = await prisma.memoryEntry.findUnique({ where: { id: other.id } });
    expect(untouched?.active).toBe(true);
  });
});
