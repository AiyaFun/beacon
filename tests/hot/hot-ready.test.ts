import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 「热点刷新」推送事件在设置页能勾很久了，但从来没有发射点——勾了一条也收不到（2026-09-03 盘查抓到）。
const pushed: { ws: string; event: string; msg: any }[] = [];
vi.mock('@/lib/bot', () => ({
  pushEvent: async (ws: string, event: string, msg: unknown) => { pushed.push({ ws, event, msg }); return { sent: 1, failed: 0 }; },
  beaconUrl: (p: string) => `https://x${p}`,
}));
const { pushHotReady, __resetHotReadyThrottle } = await import('@/lib/hot/hot-ready');

beforeEach(async () => {
  pushed.length = 0;
  __resetHotReadyThrottle();
  await prisma.tenant.deleteMany({});
  await prisma.topicCluster.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.workspace.create({ data: { id: 'w2', tenantId: 't1', name: 'W2' } });
  await prisma.botIntegration.create({ data: { workspaceId: 'w1', provider: 'feishu', label: 'a', inboundKey: 'k1', pushEvents: '["hot_ready"]' } });
  await prisma.botIntegration.create({ data: { workspaceId: 'w2', provider: 'feishu', label: 'b', inboundKey: 'k2', pushEvents: '["daily_recommend"]' } });
});

describe('pushHotReady', () => {
  it('只推本轮新建、非敏感的，热度最高最多 5 条；只推订阅了的工作区', async () => {
    const since = new Date(Date.now() - 1000);
    for (let i = 0; i < 7; i++) await prisma.topicCluster.create({ data: { title: `热点${i}`, heat: i } });
    await prisma.topicCluster.create({ data: { title: '敏感', heat: 99, isSensitive: true } });
    await prisma.topicCluster.create({ data: { title: '旧的', heat: 100, createdAt: new Date(Date.now() - 86400_000) } });
    const r = await pushHotReady(since);
    expect(r).toEqual({ workspaces: 1, items: 5 });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].ws).toBe('w1');
    expect(pushed[0].event).toBe('hot_ready');
    const text = JSON.stringify(pushed[0].msg);
    expect(text).toContain('热点6');
    expect(text).not.toContain('敏感');
    expect(text).not.toContain('旧的');
    expect(text).not.toContain('热点1');
  });
  it('两小时内不重复推；没有新聚类不推', async () => {
    const since = new Date(Date.now() - 1000);
    await prisma.topicCluster.create({ data: { title: 'x', heat: 1 } });
    const t0 = Date.now();
    expect((await pushHotReady(since, t0)).workspaces).toBe(1);
    expect((await pushHotReady(since, t0 + 3600_000)).workspaces).toBe(0);
    expect((await pushHotReady(since, t0 + 2 * 3600_000 + 1)).workspaces).toBe(1);
    expect((await pushHotReady(new Date(Date.now() + 60_000))).items).toBe(0);
  });
});
