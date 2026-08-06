import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ingestCompetitorData } from '@/lib/ingest/competitor';
import { sanitizeAutomationConfig } from '@/lib/jobs/automation';
import { toJson } from '@/lib/json';

// 「插件边逛边建档」从写死的 zod 默认值，变成工作区级开关（2026-07-30）。
// 语义：请求要开 **且** 工作区允许，才真的建档/订阅——两者取与。
// 为什么要有这个开关：CompetitorAccount 是全局共享表，「浏览即写入」是管理员该能一键关掉的产品语义。

let workspaceId: string;

beforeEach(async () => {
  await prisma.watchlistItem.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  workspaceId = ws.id;
});

const payload = {
  platform: 'bilibili',
  handle: 'uid-1',
  autoSubscribe: true,
  profile: { name: '某up' },
  posts: [],
} as Parameters<typeof ingestCompetitorData>[1];

async function setSwitch(on: boolean) {
  const cfg = sanitizeAutomationConfig(null, { pluginAutoSubscribe: on });
  await prisma.workspace.update({ where: { id: workspaceId }, data: { automationConfig: toJson(cfg) } });
}

describe('插件边逛边建档开关', () => {
  it('默认（从未配置过）保持既有行为：自动建档 + 自动订阅', async () => {
    const r = await ingestCompetitorData(workspaceId, payload);
    expect(r.ok).toBe(true);
    expect(await prisma.competitorAccount.count()).toBe(1);
    expect(await prisma.watchlistItem.count()).toBe(1);
  });

  it('关掉之后：不在库的号一律拒绝建档（全局共享表不许被顺手写）', async () => {
    await setSwitch(false);
    const r = await ingestCompetitorData(workspaceId, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
    expect(await prisma.competitorAccount.count()).toBe(0);
  });

  it('关掉之后：号在库但本工作区没订阅 → not_subscribed，不偷偷替你订阅', async () => {
    await setSwitch(false);
    await prisma.competitorAccount.create({ data: { platform: 'bilibili', handle: 'uid-1', name: '某up' } });
    const r = await ingestCompetitorData(workspaceId, payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_subscribed');
    expect(await prisma.watchlistItem.count()).toBe(0);
  });

  it('关掉之后：已订阅的对象照常补充数据（关的是「建档」，不是「采集」）', async () => {
    await setSwitch(false);
    const c = await prisma.competitorAccount.create({ data: { platform: 'bilibili', handle: 'uid-1', name: '某up' } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: c.id } });
    const r = await ingestCompetitorData(workspaceId, {
      ...payload,
      posts: [{ platformItemId: 'bv1', title: '一条作品', metrics: { views: 100 } }],
    } as Parameters<typeof ingestCompetitorData>[1]);
    expect(r.ok).toBe(true);
    expect(await prisma.crawledPost.count()).toBe(1);
  });

  it('开关开着但请求没表态 → 仍然 fail-closed（既有守卫不被开关放松）', async () => {
    await setSwitch(true);
    const r = await ingestCompetitorData(workspaceId, { ...payload, autoSubscribe: false } as Parameters<typeof ingestCompetitorData>[1]);
    expect(r.ok).toBe(false);
    expect(await prisma.competitorAccount.count()).toBe(0);
  });
});
