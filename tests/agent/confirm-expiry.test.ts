import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 等确认等太久=拒绝（2026-09-02）。
// 原来 awaiting_confirm 会永远挂着：不占并发、不是终态、没有任何路径会碰它。

const { tickAgentRuns, expireStaleConfirms, CONFIRM_STALE_DAYS } = await import('@/lib/agent/tick');
const { notifyRefId } = await import('@/lib/agent/notify-run');

let ws = { id: '' };
let memberId = '';

beforeEach(async () => {
  await prisma.agentRun.deleteMany();
  await prisma.notification.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  memberId = member.id;
});

async function awaiting(daysAgo: number) {
  const run = await prisma.agentRun.create({
    data: { workspaceId: ws.id, memberId, goal: '把竞对采一遍', status: 'awaiting_confirm', pending: '{"id":"c1","name":"x","arguments":"{}"}' },
  });
  // updatedAt 由 Prisma 自动写，要倒回去只能 raw 改
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  await prisma.agentRun.updateMany({ where: { id: run.id }, data: { updatedAt: at } });
  return run;
}

describe('expireStaleConfirms', () => {
  it(`超过 ${CONFIRM_STALE_DAYS} 天没人点的取消并通知；刚等一天的不碰`, async () => {
    const old = await awaiting(CONFIRM_STALE_DAYS + 1);
    const fresh = await awaiting(1);
    const n = await expireStaleConfirms();
    expect(n).toBe(1);
    const o = await prisma.agentRun.findUnique({ where: { id: old.id } });
    expect(o?.status).toBe('cancelled');
    expect(o?.pending).toBeNull();
    expect(o?.error).toContain('自动取消');
    expect((await prisma.agentRun.findUnique({ where: { id: fresh.id } }))?.status).toBe('awaiting_confirm');
    // 系统替他取消的要说一声（transition 对 cancelled 刻意不自动通知）
    expect(await prisma.notification.count({ where: { refId: notifyRefId(old.id, 'cancelled', 0) } })).toBe(1);
  });

  it('接进了兜底巡检，且再跑一遍不会重复取消', async () => {
    await awaiting(CONFIRM_STALE_DAYS + 2);
    const r = await tickAgentRuns();
    expect(r.expiredConfirms).toBe(1);
    expect((await tickAgentRuns()).expiredConfirms).toBe(0);
  });

  it('只碰 awaiting_confirm：同样老的 done 不动', async () => {
    const run = await prisma.agentRun.create({ data: { workspaceId: ws.id, memberId, goal: 'x', status: 'done' } });
    await prisma.agentRun.updateMany({ where: { id: run.id }, data: { updatedAt: new Date(Date.now() - 30 * 86_400_000) } });
    expect(await expireStaleConfirms()).toBe(0);
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } }))?.status).toBe('done');
  });
});
