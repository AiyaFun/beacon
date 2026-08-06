import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { DEMO_WORKSPACE_ID } from '@/lib/demo/guard';

// daily_recommend 夜间批处理：为每个活跃账号生成今日推荐。
// 本文件锁两条**生产上真实炸过**的性质：
//   1) 演示工作区必须排除——它的账号会一路走到 llmComplete 被 assertNotDemo 抛错，
//      不排除则整个 job 崩在第一个演示账号上，真实用户当天没有推荐（2026-07-22 生产实况）。
//   2) 单账号失败不连坐——配额耗尽/模型超时只该少这一个账号，其余租户照常出推荐。

// 按账号 id 决定成败：以 'boom' 开头的账号抛错，其余正常出 2 条。
const calls: string[] = [];
vi.mock('@/lib/pipeline', () => ({
  ingestHot: async () => ({ inserted: 0, degraded: [] }),
  clusterHotTopics: async () => ({ clusters: 0 }),
  crawlCompetitors: async () => ({ posts: 0, accounts: 0, degraded: false }),
  generateRecommendations: async (accountId: string) => {
    calls.push(accountId);
    if (accountId.startsWith('boom')) throw new Error('配额耗尽');
    return { created: 2 };
  },
}));

const { HANDLERS } = await import('@/lib/jobs/handlers');

async function mkAccount(opts: { id?: string; workspaceId?: string; automationConfig?: string } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({
    data: {
      ...(opts.workspaceId ? { id: opts.workspaceId } : {}),
      tenantId: tenant.id,
      name: 'w',
      automationConfig: opts.automationConfig ?? '{}',
    },
  });
  const acc = await prisma.creatorAccount.create({
    data: { ...(opts.id ? { id: opts.id } : {}), workspaceId: ws.id, name: 'a', platform: 'douyin' },
  });
  return { workspaceId: ws.id, accountId: acc.id };
}

beforeEach(async () => {
  calls.length = 0;
  await prisma.jobRun.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.botIntegration.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('daily_recommend 夜间推荐', () => {
  it('正常账号 → 生成推荐并记账 ok', async () => {
    await mkAccount();
    const r = await HANDLERS.daily_recommend({});
    expect(r.detail).toContain('1 账号');
    expect(r.detail).toContain('2 条推荐');
    expect(await prisma.jobRun.count({ where: { name: 'daily_recommend', status: 'ok' } })).toBe(1);
  });

  it('演示工作区的账号 → 根本不进候选（否则 assertNotDemo 会崩掉整个 job）', async () => {
    await mkAccount({ workspaceId: DEMO_WORKSPACE_ID });
    const r = await HANDLERS.daily_recommend({});
    expect(calls).toEqual([]);
    expect(r.detail).toContain('0 账号');
  });

  it('演示账号与真实账号共存 → 真实账号照常出推荐', async () => {
    await mkAccount({ workspaceId: DEMO_WORKSPACE_ID });
    const { accountId } = await mkAccount();
    const r = await HANDLERS.daily_recommend({});
    expect(calls).toEqual([accountId]);
    expect(r.detail).toContain('2 条推荐');
  });

  it('单账号抛错 → 只失败它一个，其余账号照常，job 仍记 ok', async () => {
    await mkAccount({ id: 'boom-1' });
    const { accountId } = await mkAccount();
    const r = await HANDLERS.daily_recommend({});
    expect(calls).toHaveLength(2);
    expect(calls).toContain(accountId);
    expect(r.detail).toContain('2 条推荐'); // 好账号的产出没被连坐
    expect(r.detail).toContain('失败 1 个'); // 但失败如实记账，不掩盖
    expect(await prisma.jobRun.count({ where: { name: 'daily_recommend', status: 'failed' } })).toBe(0);
  });

  it('工作区关闭「每日推荐」→ 跳过且如实记账', async () => {
    await mkAccount({ automationConfig: JSON.stringify({ dailyRecommend: false }) });
    const r = await HANDLERS.daily_recommend({});
    expect(calls).toEqual([]);
    expect(r.detail).toContain('1 个已关闭');
  });

  // 【回归】机器人出站不在这个 job 里：它跑在清晨固定点，而用户配的推送时刻可能是 9 点、18 点。
  // 谁把 pushEvent 挪回来，晨报就又会在生成的那一刻推出去（用户设 9 点、13 点收到那个 bug）。
  it('不直接推机器人（出站归 push_daily_brief），但站内信照写', async () => {
    const { workspaceId, accountId } = await mkAccount();
    await prisma.topicIdea.create({
      data: { accountId, title: '选题一', angle: 'x', sourceType: 'hot', state: 'recommended', totalScore: 88, queue: 'today' },
    });
    await prisma.botIntegration.create({
      data: {
        workspaceId,
        provider: 'feishu',
        webhookUrl: 'https://open.feishu.cn/hook/should-not-fire',
        enabled: true,
        pushEvents: JSON.stringify(['daily_recommend']),
        pushSchedule: '09:00',
      },
    });
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }) as any);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await HANDLERS.daily_recommend({});
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await prisma.notification.count({ where: { kind: 'daily_recommend' } })).toBe(1);
  });
});

describe('crawl_competitors 竞对采集', () => {
  it('演示工作区 → 不发起真实采集', async () => {
    await mkAccount({ workspaceId: DEMO_WORKSPACE_ID });
    const r = await HANDLERS.crawl_competitors({});
    expect(r.detail).toContain('0 工作区');
  });
});
