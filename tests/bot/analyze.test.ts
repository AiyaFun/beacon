import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { collectAccountFacts, factLines, analyzeAccount } from '@/lib/bot/analyze';
import { handleInbound } from '@/lib/bot/router';

// 账号体检：群里问「我的账号怎么样」，回一份基于真实数据的反馈。
//
// 这套用例守的是同一条纪律：**事实是查出来的，点评是模型写的，两者不许混**。
// 没有数据时必须说没有，而不是让模型对着 0 篇 0 播放编一段分析。

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 29); // 固定时点，窗口断言才稳定

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({
    data: {
      id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active',
      personaCard: JSON.stringify({ identity: '数码测评', audience: '学生党', valueProp: '省钱', platforms: ['douyin'] }),
    },
  });
  await prisma.botIntegration.create({
    data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x', pushEvents: '[]' },
  });
});
afterEach(() => vi.restoreAllMocks());

async function publish(title: string, views: number, daysAgo: number) {
  await prisma.publishRecord.create({
    data: {
      accountId: 'a1', platform: 'douyin', title,
      platformItemId: `${title}-${daysAgo}`,
      publishedAt: new Date(NOW - daysAgo * DAY),
      metrics: JSON.stringify({ views, likes: Math.round(views / 20) }),
    },
  });
}

async function mockLlm(payload: unknown, extra: Record<string, unknown> = {}) {
  const gw = await import('@/lib/llm/gateway');
  return vi.spyOn(gw, 'llmComplete').mockResolvedValue({
    text: JSON.stringify(payload), mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x', ...extra,
  } as any);
}

describe('collectAccountFacts · 事实包（纯查库，不过 LLM）', () => {
  it('按 30 天窗口分期，算出均量与环比', async () => {
    await publish('近期A', 1000, 5);
    await publish('近期B', 3000, 10);
    await publish('上期C', 1000, 40); // 落在前一个 30 天窗口

    const f = (await collectAccountFacts('a1', NOW))!;
    expect(f.published).toBe(2);
    expect(f.prevPublished).toBe(1);
    expect(f.avgViews).toBe(2000);
    expect(f.prevAvgViews).toBe(1000);
    expect(f.deltaPct).toBe(100);
    expect(f.best).toEqual({ title: '近期B', views: 3000 });
    expect(f.worst).toEqual({ title: '近期A', views: 1000 });
  });

  it('粉丝净增按最近 7 天合计，掉粉如实为负', async () => {
    await prisma.accountDailyStat.createMany({
      data: [
        { accountId: 'a1', platform: 'douyin', date: '2026-07-28', followers: 10_000, followerDelta: -50 },
        { accountId: 'a1', platform: 'douyin', date: '2026-07-27', followers: 10_050, followerDelta: 20 },
      ],
    });
    const f = (await collectAccountFacts('a1', NOW))!;
    expect(f.followers).toBe(10_000);
    expect(f.followerDelta7d).toBe(-30);
  });

  it('缺发布链接的篇数会被点出来（自动回流拿不到它们的数据）', async () => {
    await prisma.publishRecord.create({
      data: { accountId: 'a1', platform: 'douyin', title: '缺链接的', needsBackfill: true, publishedAt: new Date(NOW - DAY), metrics: '{}' },
    });
    const f = (await collectAccountFacts('a1', NOW))!;
    expect(f.missingLink).toBe(1);
    expect(factLines(f).join('\n')).toContain('缺发布链接');
  });

  it('账号不存在 → null，不抛', async () => {
    expect(await collectAccountFacts('nope', NOW)).toBeNull();
  });
});

describe('analyzeAccount · 体检全文', () => {
  it('🔒 没有任何数据 → 直说没有并指路，绝不调 LLM 编分析', async () => {
    const spy = await mockLlm({ findings: ['编的'], actions: ['编的'] });
    const reply = await analyzeAccount({ workspaceId: 'w1', accountId: 'a1', now: NOW });
    expect(reply).toContain('没有数据我不编分析');
    expect(spy).not.toHaveBeenCalled();
  });

  it('有数据 → 事实在前、AI 点评在后', async () => {
    await publish('爆的那条', 50_000, 3);
    await publish('平的那条', 500, 12);
    await mockLlm({ findings: ['两条差 100 倍，说明选题波动大'], actions: ['把爆款的选题角度再做一期'] });

    const reply = await analyzeAccount({ workspaceId: 'w1', accountId: 'a1', now: NOW });
    expect(reply).toContain('账号体检');
    expect(reply).toContain('测试号');
    expect(reply).toContain('爆的那条'); // 事实：最好的一条
    expect(reply).toContain('50000');
    expect(reply).toContain('AI 点评');
    expect(reply).toContain('波动大');
  });

  it('🔒 AI 降级 → 事实照给，点评标明是示例', async () => {
    await publish('某条', 800, 3);
    await mockLlm({ findings: ['示例结论'], actions: [] }, { mocked: true, degraded: true });

    const reply = await analyzeAccount({ workspaceId: 'w1', accountId: 'a1', now: NOW });
    expect(reply).toContain('近 30 天发布 1 篇');
    expect(reply).toContain('示例');
  });

  it('AI 抛错 → 数据部分不受影响', async () => {
    await publish('某条', 800, 3);
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw, 'llmComplete').mockRejectedValue(new Error('provider down'));

    const reply = await analyzeAccount({ workspaceId: 'w1', accountId: 'a1', now: NOW });
    expect(reply).toContain('近 30 天发布 1 篇');
    expect(reply).toContain('数据部分不受影响');
  });
});

describe('handleInbound · /分析 走通', () => {
  it('单账号工作区 → 直接体检那个账号，且回执写明是谁', async () => {
    await publish('某条', 1200, 2);
    await mockLlm({ findings: ['样本还少'], actions: ['先攒够 10 条'] });
    const reply = await handleInbound('w1', '/分析', { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1' });
    expect(reply).toContain('测试号');
    expect(reply).toContain('1200');
  });

  it('「分析一下我的账号」→ 确定性短语命中，不依赖 LLM 分类', async () => {
    await publish('某条', 1200, 2);
    await mockLlm({ findings: ['x'], actions: ['y'] });
    const reply = await handleInbound('w1', '分析一下我的账号', { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1' });
    expect(reply).toContain('账号体检');
    expect(await prisma.topicIdea.count()).toBe(0); // 不该顺手收录一条
  });
});
