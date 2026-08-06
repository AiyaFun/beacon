import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { evaluateAndAlert } from '@/lib/insight/alert';

// 爆款/异常预警：默认关（opt-in）；开启后超基线 2 倍 → 爆款、低于 0.3 倍 → 异常；每篇只提醒一次。
// 真 SQLite，无 LLM。

async function mk(automationConfig: string) {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w', automationConfig } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'a', platform: 'douyin' } });
  return { workspaceId: ws.id, accountId: acc.id };
}

async function rec(accountId: string, views: number, id: string) {
  const pub = new Date(Date.now() - 3 * 86_400_000);
  const r = await prisma.publishRecord.create({ data: { accountId, platform: 'douyin', platformItemId: id, title: '内容' + id, publishedAt: pub } });
  await prisma.performanceSnapshot.create({ data: { publishId: r.id, takenAt: new Date(pub.getTime() + 2 * 86_400_000), milestone: 'D+2', source: 'tikhub', metrics: JSON.stringify({ views }) } });
  return r.id;
}

// 3 篇 peer，D+2 均 100k → 基线 100k
async function peers(accountId: string) {
  for (let i = 0; i < 3; i++) await rec(accountId, 100000, 'peer' + i + Math.random());
}

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.performanceSnapshot.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('evaluateAndAlert', () => {
  it('预警默认关 → 不提醒（即便远超基线）', async () => {
    const { workspaceId, accountId } = await mk('{}');
    await peers(accountId);
    const id = await rec(accountId, 500000, 'hot'); // 5x 基线
    const r = await evaluateAndAlert(accountId, workspaceId, id);
    expect(r).toBeNull();
    expect(await prisma.notification.count()).toBe(0);
  });

  it('开启后：超基线 2 倍 → 爆款预警 + 站内通知', async () => {
    const { workspaceId, accountId } = await mk(JSON.stringify({ alerts: true }));
    await peers(accountId);
    const id = await rec(accountId, 300000, 'hot'); // 3x 基线
    const r = await evaluateAndAlert(accountId, workspaceId, id);
    expect(r).toBe('over');
    // refId 带级别后缀（dedup 需要区分 over / under）
    const n = await prisma.notification.findFirst({ where: { kind: 'performance_alert', refId: `${id}:over` } });
    expect(n?.title).toContain('爆款加速');
  });

  it('低于基线 0.3 倍 → 异常预警', async () => {
    const { workspaceId, accountId } = await mk(JSON.stringify({ alerts: true }));
    await peers(accountId);
    const id = await rec(accountId, 20000, 'flop'); // 0.2x 基线
    expect(await evaluateAndAlert(accountId, workspaceId, id)).toBe('under');
  });

  it('接近基线 → 不提醒', async () => {
    const { workspaceId, accountId } = await mk(JSON.stringify({ alerts: true }));
    await peers(accountId);
    const id = await rec(accountId, 110000, 'normal'); // 1.1x
    expect(await evaluateAndAlert(accountId, workspaceId, id)).toBeNull();
  });

  it('同一篇同一级别只提醒一次（去重）', async () => {
    const { workspaceId, accountId } = await mk(JSON.stringify({ alerts: true }));
    await peers(accountId);
    const id = await rec(accountId, 300000, 'hot');
    await evaluateAndAlert(accountId, workspaceId, id);
    const second = await evaluateAndAlert(accountId, workspaceId, id);
    expect(second).toBeNull();
    // dedup key 带级别（refId = `${publishId}:${level}`），故按前缀统计这一篇的通知数
    expect(await prisma.notification.count({ where: { refId: { startsWith: id } } })).toBe(1);
    expect(await prisma.notification.count({ where: { refId: `${id}:over` } })).toBe(1);
  });

  // 回归：去重键此前只按 publishId，不含级别 —— D+1 的「低于预期」会把
  // D+7 真正爆了时的「🚀 爆款加速」永久压掉，而那是本功能最值钱的一条提醒。
  it('🔒 先 under 后 over：两个级别都应各提醒一次，不能被前一级压掉', async () => {
    const { workspaceId, accountId } = await mk(JSON.stringify({ alerts: true }));
    await peers(accountId);
    const id = await rec(accountId, 20000, 'flop'); // 0.2x → under
    expect(await evaluateAndAlert(accountId, workspaceId, id)).toBe('under');

    // 同一篇后来爆了：把累计播放拉到 3x 基线，再评一次
    await prisma.publishRecord.update({ where: { id }, data: { metrics: JSON.stringify({ views: 300000 }) } });
    await prisma.performanceSnapshot.create({
      data: { publishId: id, metrics: JSON.stringify({ views: 300000 }) },
    });
    expect(await evaluateAndAlert(accountId, workspaceId, id)).toBe('over');

    expect(await prisma.notification.count({ where: { refId: `${id}:under` } })).toBe(1);
    expect(await prisma.notification.count({ where: { refId: `${id}:over` } })).toBe(1);
  });

  it('基线样本不足（<3 peer）→ 不判定', async () => {
    const { workspaceId, accountId } = await mk(JSON.stringify({ alerts: true }));
    await rec(accountId, 100000, 'onlypeer');
    const id = await rec(accountId, 500000, 'hot');
    expect(await evaluateAndAlert(accountId, workspaceId, id)).toBeNull();
  });
});
