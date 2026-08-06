import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  evergreenTemplates,
  nicheWord,
  replenishEvergreen,
  EVERGREEN_MIN_RESERVE,
} from '@/lib/topic/sources/evergreen';
import { emptyPersona, type PersonaCard } from '@/lib/persona';

// 赛道常青储备（lib/topic/sources/evergreen.ts）。
// 它存在的意义是补两个必然空窗：新用户第一天、以及赛道没热点的日子。
// 本文件锁两件事：**没赛道词就闭嘴**（不生成缺主语的废话选题），
// 以及**水位线以上一次 LLM 都不调用**（这个源要是每天重跑就成了纯烧钱）。

const persona = (over: Partial<PersonaCard> = {}): PersonaCard => ({
  ...emptyPersona(),
  identity: '前端工程师',
  niche: '前端工程化',
  platforms: ['bilibili'],
  ...over,
});

describe('nicheWord 赛道词', () => {
  it('优先 niche，退到 identity', () => {
    expect(nicheWord(persona())).toBe('前端工程化');
    expect(nicheWord(persona({ niche: '' }))).toBe('前端工程师');
  });

  it('两个都空 → 空串（下游据此整源沉默）', () => {
    expect(nicheWord(emptyPersona())).toBe('');
  });

  it('过短或过长的都不用——「做，最容易踩的坑」和一整段自我介绍都不是赛道词', () => {
    expect(nicheWord(persona({ niche: '前', identity: '' }))).toBe('');
    expect(nicheWord(persona({ niche: '我是一个专注于前端工程化与构建工具链优化的博主', identity: '' }))).toBe('');
  });
});

describe('evergreenTemplates 题库', () => {
  it('赛道词代入模板，每条都带「为什么它是常青题」的说明', () => {
    const list = evergreenTemplates(persona());
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.every((c) => c.title.includes('前端工程化'))).toBe(true);
    expect(list.every((c) => c.sourceType === 'evergreen' && c.queue === 'evergreen')).toBe(true);
    expect(list.every((c) => !!c.evidence)).toBe(true);
  });

  it('热度如实给 0——常青题的价值不在热度，给个假热度就是把没数据伪装成有数据', () => {
    expect(evergreenTemplates(persona()).every((c) => c.heat === 0)).toBe(true);
  });

  it('没有赛道词 → 一条不出，绝不生成缺主语的废话选题', () => {
    expect(evergreenTemplates(emptyPersona())).toEqual([]);
  });

  it('推过的题不再端上来', () => {
    const all = evergreenTemplates(persona());
    const filtered = evergreenTemplates(persona(), new Set([all[0].title, all[1].title]));
    expect(filtered).toHaveLength(all.length - 2);
    expect(filtered.map((c) => c.title)).not.toContain(all[0].title);
  });

  it('题库是确定性的：同样人设两次调用给出同一套题（可 review、可版本化）', () => {
    expect(evergreenTemplates(persona()).map((c) => c.title)).toEqual(
      evergreenTemplates(persona()).map((c) => c.title),
    );
  });
});

describe('replenishEvergreen 水位线补货', () => {
  async function seed(over: Partial<PersonaCard> = {}) {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const acc = await prisma.creatorAccount.create({
      data: {
        workspaceId: ws.id,
        name: 'a',
        platform: 'bilibili',
        personaCard: JSON.stringify(persona(over)),
      },
    });
    return { workspaceId: ws.id, accountId: acc.id, tenantId: tenant.id };
  }

  beforeEach(async () => {
    await prisma.topicIdea.deleteMany();
    await prisma.llmCallLog.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
  });

  it('储备为空 → 补货并落库，全部标记为常青队列', async () => {
    const { accountId, workspaceId } = await seed();
    const r = await replenishEvergreen({ accountId, workspaceId });
    expect(r.created).toBeGreaterThan(0);
    const rows = await prisma.topicIdea.findMany({ where: { accountId } });
    expect(rows.length).toBe(r.created);
    expect(rows.every((t) => t.queue === 'evergreen' && t.sourceType === 'evergreen')).toBe(true);
    expect(rows.every((t) => t.state === 'recommended')).toBe(true);
    // 无真实 key 时精排走 Mock，必须如实标注，UI 才知道挂「示例分」
    expect(rows.every((t) => t.mocked)).toBe(true);
    expect(rows.every((t) => !!t.evidence && !!t.windowHint)).toBe(true);
  });

  it('储备充足 → 直接返回，一次 LLM 都不调用', async () => {
    const { accountId, workspaceId } = await seed();
    for (let i = 0; i < EVERGREEN_MIN_RESERVE; i++) {
      await prisma.topicIdea.create({
        data: { accountId, title: `已有常青题${i}`, angle: 'a', queue: 'evergreen', state: 'recommended' },
      });
    }
    const before = await prisma.llmCallLog.count();
    const r = await replenishEvergreen({ accountId, workspaceId });
    expect(r.created).toBe(0);
    expect(r.reason).toContain('储备充足');
    expect(await prisma.llmCallLog.count()).toBe(before);
  });

  it('已被采纳/拒绝的常青题不算库存——它们已经离开储备池了', async () => {
    const { accountId, workspaceId } = await seed();
    for (const state of ['accepted', 'rejected', 'published']) {
      await prisma.topicIdea.create({
        data: { accountId, title: `处理过的${state}`, angle: 'a', queue: 'evergreen', state },
      });
    }
    const r = await replenishEvergreen({ accountId, workspaceId });
    expect(r.created).toBeGreaterThan(0);
  });

  it('每日热点推荐不算常青储备（两个队列各算各的）', async () => {
    const { accountId, workspaceId } = await seed();
    for (let i = 0; i < 6; i++) {
      await prisma.topicIdea.create({
        data: { accountId, title: `今日热点${i}`, angle: 'a', queue: 'today', state: 'recommended' },
      });
    }
    const r = await replenishEvergreen({ accountId, workspaceId });
    expect(r.created).toBeGreaterThan(0);
  });

  it('人设没填赛道/身份 → 不补货并说明原因，不生成废话选题', async () => {
    const { accountId, workspaceId } = await seed({ niche: '', identity: '' });
    const r = await replenishEvergreen({ accountId, workspaceId });
    expect(r.created).toBe(0);
    expect(r.reason).toContain('赛道');
    expect(await prisma.topicIdea.count({ where: { accountId } })).toBe(0);
  });

  it('题库已全部推荐过（含被拒的）→ 不重复端上来', async () => {
    const { accountId, workspaceId } = await seed();
    for (const c of evergreenTemplates(persona())) {
      await prisma.topicIdea.create({
        data: { accountId, title: c.title, angle: 'a', queue: 'evergreen', state: 'rejected' },
      });
    }
    const r = await replenishEvergreen({ accountId, workspaceId });
    expect(r.created).toBe(0);
    expect(r.reason).toContain('已全部推荐过');
  });

  it('补货成本落到本租户账上（不挂 null 绕过配额）', async () => {
    const { accountId, workspaceId, tenantId } = await seed();
    await replenishEvergreen({ accountId, workspaceId });
    const logs = await prisma.llmCallLog.findMany({ where: { fn: 'scoring' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.tenantId === tenantId)).toBe(true);
  });
});
