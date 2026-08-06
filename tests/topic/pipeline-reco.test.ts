import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { generateRecommendations } from '@/lib/pipeline';
import * as scoring from '@/lib/topic/scoring';
import { QuotaExceededError } from '@/lib/quota';

// 推荐管线落库侧的三件事，全走真 SQLite + Mock LLM：
// 1) TopicIdea.mocked 如实标注（Mock 打的分不许装真分）；
// 2) 精排 LLM 调用以真实 tenantId 落账（曾经传 null 绕过配额与成本归属）；
// 3) 探索位来自「高热但人设匹配存疑」的落选候选（曾经是拿精排末位贴标签冒充）。

const hot = (source: string, rank: number, title: string, heat: number) =>
  prisma.hotItem.create({ data: { source, rank, title, heat } });

// 前端人设：让「前端×」标题高匹配、娱乐/生活类零匹配，探索位的选取才可预测
const personaCard = JSON.stringify({
  identity: '前端工程师',
  audience: '前端新人',
  valueProp: '把复杂工具链讲明白',
  niche: '前端工程化',
  canDo: ['构建优化', '性能调优'],
  cantDo: ['医疗建议'],
  tone: '干货',
  platforms: ['bilibili'],
});

async function seedAccount() {
  const tenant = await prisma.tenant.create({ data: { name: 't', plan: 'free' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, platform: 'bilibili', name: '测试账号', personaCard },
  });
  return { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id };
}

let seq = 0;
async function seedCompetitorPosts(titles: string[]) {
  const comp = await prisma.competitorAccount.create({
    data: { platform: 'douyin', handle: `h-${++seq}`, name: '竞对' },
  });
  for (const title of titles) {
    await prisma.crawledPost.create({
      data: { competitorId: comp.id, platform: 'douyin', platformItemId: `p-${++seq}`, title },
    });
  }
}

beforeEach(async () => {
  await prisma.hotItem.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.llmCallLog.deleteMany();
});

describe('Mock 评分落库标注', () => {
  it('dev 无 key：所有推荐的 mocked=true，UI 才知道该挂「示例分」标', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('douyin', 1, '前端工程化实践指南', 500);
    await hot('weibo', 1, '前端构建优化提速', 400);
    await generateRecommendations(accountId, workspaceId, 6);
    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas.every((i) => i.mocked)).toBe(true);
  });
});

describe('精排成本归属', () => {
  it('scoring 调用以真实 tenantId 落账，不再挂 null 绕过配额', async () => {
    const { tenantId, workspaceId, accountId } = await seedAccount();
    await hot('douyin', 1, '前端工程化实践指南', 500);
    await generateRecommendations(accountId, workspaceId, 6);
    const logs = await prisma.llmCallLog.findMany({ where: { fn: 'scoring' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.tenantId === tenantId)).toBe(true);
  });
});

describe('真探索位', () => {
  it('高热但人设匹配存疑的落选候选被追加为探索位，rationale 说人话', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('douyin', 1, '前端工程化实践指南', 300);
    await hot('weibo', 1, '前端构建优化提速', 200);
    await hot('douyin', 2, '明星八卦大瓜', 1000); // 池内热度第一，零匹配 → 探索位
    await hot('weibo', 2, '今日菜价播报', 50);
    await generateRecommendations(accountId, workspaceId, 2);

    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(ideas).toHaveLength(3); // Top2 + 1 探索位
    const exploration = ideas.filter((i) => i.isExploration);
    expect(exploration).toHaveLength(1);
    expect(exploration[0].title).toBe('明星八卦大瓜');
    expect(exploration[0].rationale).toContain('探索位');
    expect(exploration[0].mocked).toBe(true);
    // 常规推荐一条都不许被贴探索标（旧实现拿末位冒充的路已封死）。
    // 这里不再断言具体是哪两条：日历候选（sources/calendar.ts）会按当天日期参与本周队列的竞争，
    // 谁进 Top2 取决于跑测试那天有没有临近节点。要守的性质是「探索位那条不在常规推荐里」。
    const regular = ideas.filter((i) => !i.isExploration);
    expect(regular).toHaveLength(2);
    expect(regular.map((i) => i.title)).not.toContain('明星八卦大瓜');
  });

  it('找不到符合条件的候选就不追加，不许拿末位凑数', async () => {
    const { workspaceId, accountId } = await seedAccount();
    // 全部高匹配且全部进 Top N → 没有落选者
    await hot('douyin', 1, '前端工程化实践指南', 500);
    await hot('weibo', 1, '前端构建优化提速', 400);
    await generateRecommendations(accountId, workspaceId, 6);
    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    // 两条热榜候选都进了推荐（可能还有当天的日历节点候选，条数不固定）；
    // 要守的性质是**一条探索位都没有**——没有落选的高热低匹配候选就不该硬凑一条。
    expect(ideas.filter((i) => i.sourceType !== 'calendar')).toHaveLength(2);
    expect(ideas.some((i) => i.isExploration)).toBe(false);
  });

  it('敏感词条不许借探索位还魂', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('douyin', 1, '前端工程化实践指南', 300);
    await hot('weibo', 1, '前端构建优化提速', 200);
    await hot('douyin', 2, '重庆彭水山体垮塌已救出10人', 2000); // 全场最热但敏感：连候选池都进不去
    await generateRecommendations(accountId, workspaceId, 2);
    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(ideas.some((i) => i.title.includes('垮塌'))).toBe(false);
  });
});

describe('空人设不再冷启动 500（分片1·问题①）', () => {
  it('personaCard 为库默认 "{}" 时照常出推荐，不因 canDo undefined 崩 TypeError', async () => {
    // 直接建一个 personaCard='{}' 的新账号（库默认值），不走 seedAccount 的完整人设
    const tenant = await prisma.tenant.create({ data: { name: 't', plan: 'free' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const account = await prisma.creatorAccount.create({
      data: { workspaceId: ws.id, platform: 'douyin', name: '没填人设的新账号', personaCard: '{}' },
    });
    await hot('douyin', 1, '前端工程化实践指南', 500);
    await hot('weibo', 1, '今天天气不错', 300);
    // 修复前：readPersona('{}') → canDo undefined → personaPromptBlock 抛 TypeError → 整个 await reject
    const res = await generateRecommendations(account.id, ws.id, 6);
    expect(res.created).toBeGreaterThan(0);
    expect(await prisma.topicIdea.count({ where: { accountId: account.id } })).toBeGreaterThan(0);
  });
});

describe('探索位 best-effort（分片1·问题②）', () => {
  it('探索位精排触配额上限 → 跳过探索位，已产出的 Top N 照常返回，不整次报失败', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('douyin', 1, '前端工程化实践指南', 300);
    await hot('weibo', 1, '前端构建优化提速', 200);
    await hot('douyin', 2, '明星八卦大瓜', 1000); // 高热零匹配 → 探索位候选（同真探索位用例）
    await hot('weibo', 2, '今日菜价播报', 50);

    // 只让探索位那条 finePrompt 触配额上限；Top N 的精排（runScoring 内部调用）照常成功。
    // 用条件转发：非探索候选走真实实现，探索候选抛 QuotaExceededError。
    const orig = scoring.finePrompt;
    const spy = vi
      .spyOn(scoring, 'finePrompt')
      .mockImplementation((tenantId, candidate, persona, memory) =>
        candidate.title === '明星八卦大瓜'
          ? Promise.reject(new QuotaExceededError('今日 AI 额度已用完'))
          : orig(tenantId, candidate, persona, memory),
      );

    const res = await generateRecommendations(accountId, workspaceId, 2);
    expect(res.created).toBe(2); // 探索位失败不拖累已提交的 Top 2

    const ideas = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(ideas).toHaveLength(2);
    expect(ideas.some((i) => i.isExploration)).toBe(false);
    spy.mockRestore();
  });
});

describe('饱和度真路径（竞对库 → 粗排）', () => {
  it('热度/匹配打平时，中等饱和度候选挤掉红海候选', async () => {
    const { workspaceId, accountId } = await seedAccount();
    // 两条候选与前端人设零匹配、热度打平，只有饱和度能分胜负
    await hot('douyin', 1, '减脂餐一周食谱', 500);
    await hot('weibo', 1, '增肌餐一周食谱', 500);
    // 近 72h 竞对作品：减脂 6 条（红海，封顶 1.0）；增肌 3 条（中等，0.6）
    await seedCompetitorPosts([
      ...Array.from({ length: 6 }, (_, i) => `减脂餐做法分享第${i}期`),
      ...Array.from({ length: 3 }, (_, i) => `增肌餐做法分享第${i}期`),
    ]);
    await generateRecommendations(accountId, workspaceId, 1);
    const ideas = await prisma.topicIdea.findMany({ where: { accountId, isExploration: false } });
    expect(ideas).toHaveLength(1);
    expect(ideas[0].title).toBe('增肌餐一周食谱');
  });

  it('竞对库为空：新账号照常出推荐，不因取数为空而挂掉', async () => {
    const { workspaceId, accountId } = await seedAccount();
    await hot('douyin', 1, '前端工程化实践指南', 500);
    await generateRecommendations(accountId, workspaceId, 6);
    // 那唯一一条热榜候选必须在。日历候选也可能同时出现（取决于跑测试那天临近哪个节点），
    // 所以只断言热榜那条落了库，不锁总条数。
    const titles = (await prisma.topicIdea.findMany({ where: { accountId }, select: { title: true } })).map((t) => t.title);
    expect(titles).toContain('前端工程化实践指南');
  });
});
