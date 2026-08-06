import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { HANDLERS } from '@/lib/jobs/handlers';
import { DEMO_WORKSPACE_ID } from '@/lib/demo/guard';

// push_daily_brief：按每个机器人自己配的「每日定时推送时间」推今日选题晨报。
// 【为什么这个 job 存在】pushSchedule 以前只存不读，晨报实际跟着 daily_recommend 的 cron 走，
// 用户设 9 点、13 点才收到（2026-07-28 反馈）。下面把「谁、什么时候、推几条」全钉死。
// 真 SQLite + stub fetch：走的是真的 pushEvent → sendVia → webhook，只把网络那一跳换掉。

const posted: string[] = [];
beforeEach(() => {
  posted.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    posted.push(typeof input === 'string' ? input : input.url);
    return { ok: true, status: 200, json: async () => ({ code: 0 }) } as any;
  }));
});
afterEach(() => vi.unstubAllGlobals());

// 北京时间 → UTC ISO（job 用 payload.now 注入当前时刻）
const bjNow = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 28, h - 8, m)).toISOString();

async function mkWorkspace(opts: { id?: string; automationConfig?: string } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      tenantId: tenant.id,
      name: 'w',
      automationConfig: opts.automationConfig ?? '{}',
    },
  });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '甲', platform: 'douyin' } });
  return { workspaceId: ws.id, accountId: acc.id };
}

async function mkRecommendation(accountId: string) {
  await prisma.topicIdea.create({
    data: { accountId, title: '选题一', angle: '切入角', sourceType: 'hot', state: 'recommended', totalScore: 88, queue: 'today' },
  });
}

async function mkBot(workspaceId: string, pushSchedule: string, url: string) {
  return prisma.botIntegration.create({
    data: {
      workspaceId,
      provider: 'feishu',
      webhookUrl: url,
      enabled: true,
      pushEvents: JSON.stringify(['daily_recommend']),
      pushSchedule,
    },
  });
}

beforeEach(async () => {
  await prisma.botIntegration.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('push_daily_brief 按设置的时刻推送', () => {
  it('设 09:00 → 北京 09:00 那一跳推出去', async () => {
    const { workspaceId, accountId } = await mkWorkspace();
    await mkRecommendation(accountId);
    await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/nine');

    const r = await HANDLERS.push_daily_brief({ now: bjNow(9, 0) });
    expect(posted).toEqual(['https://open.feishu.cn/hook/nine']);
    expect(r.detail).toContain('推送 1 条');
  });

  it('【回归】设 09:00 → 北京 13:00 这一跳什么都不推', async () => {
    const { workspaceId, accountId } = await mkWorkspace();
    await mkRecommendation(accountId);
    await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/nine');

    await HANDLERS.push_daily_brief({ now: bjNow(13, 0) });
    expect(posted).toEqual([]);
  });

  it('同工作区两个机器人配不同时刻 → 只推到点的那个', async () => {
    const { workspaceId, accountId } = await mkWorkspace();
    await mkRecommendation(accountId);
    await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/nine');
    await mkBot(workspaceId, '18:00', 'https://open.feishu.cn/hook/evening');

    await HANDLERS.push_daily_brief({ now: bjNow(9, 0) });
    expect(posted).toEqual(['https://open.feishu.cn/hook/nine']);

    posted.length = 0;
    await HANDLERS.push_daily_brief({ now: bjNow(18, 0) });
    expect(posted).toEqual(['https://open.feishu.cn/hook/evening']);
  });

  it('没有推荐选题 → 不推空卡片', async () => {
    const { workspaceId } = await mkWorkspace();
    await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/empty');

    await HANDLERS.push_daily_brief({ now: bjNow(9, 0) });
    expect(posted).toEqual([]);
  });

  it('没订阅 daily_recommend 事件的机器人不推', async () => {
    const { workspaceId, accountId } = await mkWorkspace();
    await mkRecommendation(accountId);
    const bot = await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/unsub');
    await prisma.botIntegration.update({ where: { id: bot.id }, data: { pushEvents: JSON.stringify(['compliance_alert']) } });

    await HANDLERS.push_daily_brief({ now: bjNow(9, 0) });
    expect(posted).toEqual([]);
  });

  it('工作区关了「每日选题推荐」开关 → 不推', async () => {
    const { workspaceId, accountId } = await mkWorkspace({ automationConfig: JSON.stringify({ dailyRecommend: false }) });
    await mkRecommendation(accountId);
    await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/off');

    await HANDLERS.push_daily_brief({ now: bjNow(9, 0) });
    expect(posted).toEqual([]);
  });

  it('演示工作区不推（与 daily_recommend 同款排除）', async () => {
    const { workspaceId, accountId } = await mkWorkspace({ id: DEMO_WORKSPACE_ID });
    await mkRecommendation(accountId);
    await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/demo');

    await HANDLERS.push_daily_brief({ now: bjNow(9, 0) });
    expect(posted).toEqual([]);
  });

  it('停用的机器人不推', async () => {
    const { workspaceId, accountId } = await mkWorkspace();
    await mkRecommendation(accountId);
    const bot = await mkBot(workspaceId, '09:00', 'https://open.feishu.cn/hook/disabled');
    await prisma.botIntegration.update({ where: { id: bot.id }, data: { enabled: false } });

    await HANDLERS.push_daily_brief({ now: bjNow(9, 0) });
    expect(posted).toEqual([]);
  });
});
