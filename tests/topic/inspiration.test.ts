import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { applyInspiration, loadInspirations, markInspirationUsed, type InspirationRow } from '@/lib/topic/sources/inspiration';
import { ingestInspiration, pruneInspiration, INSPIRATION_CAP, inspirationPayloadSchema } from '@/lib/ingest/inspiration';
import type { Candidate } from '@/lib/topic/scoring';

// 灵感收集箱（lib/topic/sources/inspiration.ts + lib/ingest/inspiration.ts）。
// 核心纪律：**同一条灵感只走一条路**——要么唤醒已有候选，要么自己占位，绝不两头都占
// （同题两行推荐是纯噪声，与跨平台自搬运同一条规矩）。

const NOW = new Date('2026-07-22T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

let seq = 0;
function item(over: Partial<InspirationRow> = {}): InspirationRow {
  return {
    id: `i-${++seq}`,
    title: '一条讲职场沟通技巧的视频',
    note: null,
    url: null,
    platform: null,
    author: null,
    tags: '[]',
    createdAt: daysAgo(20),
    ...over,
  };
}

const cand = (title: string, over: Partial<Candidate> = {}): Candidate => ({
  title,
  heat: 0.8,
  sourceType: 'douyin',
  ...over,
});

describe('applyInspiration · 唤醒', () => {
  it('收藏的灵感与池中候选同题 → 给那条候选挂上「你几周前收藏过」', () => {
    const r = applyInspiration([cand('职场沟通技巧又上热搜')], [item({ createdAt: daysAgo(21) })], NOW);
    expect(r.wokeUp).toBe(1);
    expect(r.standalone).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].evidence).toContain('3 周前');
    expect(r.candidates[0].evidence).toContain('灵感箱');
    expect(r.candidates[0].sourceType).toBe('douyin'); // 唤醒不改来源
  });

  it('被唤醒的灵感不再独立占位（同题两行推荐是纯噪声）', () => {
    const r = applyInspiration([cand('职场沟通技巧又上热搜')], [item()], NOW);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates.filter((c) => c.sourceType === 'inspiration')).toHaveLength(0);
  });

  it('备注也参与匹配：主题词常常在备注里而不在原标题里', () => {
    const it0 = item({ title: '某个不相关的标题', note: '这个讲增肌餐的角度可以借鉴' });
    const r = applyInspiration([cand('增肌餐怎么搭配')], [it0], NOW);
    expect(r.wokeUp).toBe(1);
  });

  it('已有证据 → 追加而非覆盖', () => {
    const r = applyInspiration([cand('职场沟通技巧又上热搜', { evidence: '抢跑证据。' })], [item()], NOW);
    expect(r.candidates[0].evidence).toContain('抢跑证据。');
    expect(r.candidates[0].evidence).toContain('灵感箱');
  });

  it('来源信息与备注都写进证据里', () => {
    const it0 = item({ platform: 'xiaohongshu', author: '某某', note: '开头钩子很好' });
    const r = applyInspiration([cand('职场沟通技巧又上热搜')], [it0], NOW);
    expect(r.candidates[0].evidence).toContain('小红书');
    expect(r.candidates[0].evidence).toContain('某某');
    expect(r.candidates[0].evidence).toContain('开头钩子很好');
  });
});

describe('applyInspiration · 独立候选', () => {
  it('没撞上热点的灵感自己成候选，进本周队列', () => {
    const r = applyInspiration([cand('完全无关的娱乐八卦')], [item()], NOW);
    expect(r.standalone).toBe(1);
    const c = r.candidates.find((x) => x.sourceType === 'inspiration')!;
    expect(c.queue).toBe('week');
    expect(c.sourceRef).toBeTruthy();
    expect(c.evidence).toContain('当时觉得值得做');
  });

  it('有备注就拿备注当标题——它更接近用户真正想做的那个选题', () => {
    const it0 = item({ title: '别人的一条视频', note: '想做一期反驳这个观点的' });
    const r = applyInspiration([cand('毫不相干')], [it0], NOW);
    expect(r.candidates.find((x) => x.sourceType === 'inspiration')!.title).toBe('想做一期反驳这个观点的');
  });

  it('有链接就把原内容地址带上', () => {
    const it0 = item({ url: 'https://example.com/x' });
    const r = applyInspiration([cand('毫不相干')], [it0], NOW);
    expect(r.candidates.find((x) => x.sourceType === 'inspiration')!.windowHint).toContain('https://example.com/x');
  });

  it('最多放 3 条：收集箱可能攒了上百条，全塞进去会把候选池冲垮', () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ title: `独立灵感${i}` }));
    const r = applyInspiration([cand('毫不相干')], many, NOW);
    expect(r.standalone).toBe(3);
  });

  it('敏感内容不许借灵感箱绕过热点隔离', () => {
    const bad = item({ title: '重大交通事故致3伤全记录' });
    const badNote = item({ title: '一条普通内容', note: '想聊聊这次垮塌事故' });
    const r = applyInspiration([cand('毫不相干')], [bad, badNote], NOW);
    expect(r.standalone).toBe(0);
  });

  it('虽未被唤醒但与池中候选同题的，也不独立占位', () => {
    // 两条灵感都讲职场沟通：第一条唤醒了候选，第二条不该再单独冒出来
    const a = item({ title: '职场沟通技巧拆解' });
    const b = item({ title: '职场沟通的三个误区' });
    const r = applyInspiration([cand('职场沟通技巧又上热搜')], [a, b], NOW);
    expect(r.wokeUp).toBe(1);
    expect(r.standalone).toBe(0);
  });

  it('收集箱为空 → 候选池原样返回', () => {
    const pool = [cand('随便什么')];
    const r = applyInspiration(pool, [], NOW);
    expect(r.candidates).toBe(pool);
    expect(r.wokeUp + r.standalone).toBe(0);
  });
});

describe('时间措辞', () => {
  it('按新鲜度说人话：今天 / N 天前 / N 周前 / N 个月前', () => {
    const say = (d: number) =>
      applyInspiration([cand('毫不相干')], [item({ createdAt: daysAgo(d) })], NOW)
        .candidates.find((x) => x.sourceType === 'inspiration')!.evidence!;
    expect(say(0)).toContain('今天');
    expect(say(3)).toContain('3 天前');
    expect(say(14)).toContain('2 周前');
    expect(say(90)).toContain('3 个月前');
  });
});

describe('ingest 入库', () => {
  async function ws() {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const w = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    return w.id;
  }

  beforeEach(async () => {
    await prisma.inspirationItem.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
  });

  it('正常入库，默认待用状态', async () => {
    const workspaceId = await ws();
    const r = await ingestInspiration(workspaceId, { title: '一条好内容', source: 'plugin' });
    expect(r.ok && r.duplicate).toBe(false);
    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId } });
    expect(row!.state).toBe('open');
    expect(row!.accountId).toBeNull(); // 插件没有账号上下文 → 工作区共享
  });

  it('同 URL 重复收藏不新增，只补备注（第二次点通常是想补一句话）', async () => {
    const workspaceId = await ws();
    await ingestInspiration(workspaceId, { title: 'A', url: 'https://e.com/1', source: 'plugin' });
    const r = await ingestInspiration(workspaceId, { title: 'A', url: 'https://e.com/1', note: '补的备注', source: 'plugin' });
    expect(r.ok && r.duplicate).toBe(true);
    expect(await prisma.inspirationItem.count({ where: { workspaceId } })).toBe(1);
    expect((await prisma.inspirationItem.findFirst({ where: { workspaceId } }))!.note).toBe('补的备注');
  });

  it('第二次没写备注 → 不覆盖第一次写的', async () => {
    const workspaceId = await ws();
    await ingestInspiration(workspaceId, { title: 'A', url: 'https://e.com/1', note: '原备注', source: 'plugin' });
    await ingestInspiration(workspaceId, { title: 'A', url: 'https://e.com/1', source: 'plugin' });
    expect((await prisma.inspirationItem.findFirst({ where: { workspaceId } }))!.note).toBe('原备注');
  });

  it('重新收藏已归档的 → 放回待用（用户又想起它了）', async () => {
    const workspaceId = await ws();
    const first = await ingestInspiration(workspaceId, { title: 'A', url: 'https://e.com/1', source: 'plugin' });
    await prisma.inspirationItem.update({ where: { id: (first as { id: string }).id }, data: { state: 'archived' } });
    await ingestInspiration(workspaceId, { title: 'A', url: 'https://e.com/1', source: 'plugin' });
    expect((await prisma.inspirationItem.findFirst({ where: { workspaceId } }))!.state).toBe('open');
  });

  it('超出上限挤掉最老的待用条目，但不动已转选题/已归档的（那是有结论的记录）', async () => {
    const workspaceId = await ws();
    await prisma.inspirationItem.createMany({
      data: [
        ...Array.from({ length: INSPIRATION_CAP + 5 }, (_, i) => ({
          workspaceId, title: `open-${i}`, state: 'open',
          createdAt: new Date(NOW.getTime() - (INSPIRATION_CAP + 5 - i) * 60_000),
        })),
        { workspaceId, title: 'used-old', state: 'used', createdAt: new Date(0) },
        { workspaceId, title: 'archived-old', state: 'archived', createdAt: new Date(0) },
      ],
    });
    const pruned = await pruneInspiration(workspaceId);
    expect(pruned).toBe(5);
    expect(await prisma.inspirationItem.count({ where: { workspaceId, state: 'open' } })).toBe(INSPIRATION_CAP);
    expect(await prisma.inspirationItem.count({ where: { workspaceId, state: { in: ['used', 'archived'] } } })).toBe(2);
  });

  it('自有与同行的同一个问题各存一条——两边都被问到是有信息量的，不该被合并掉', async () => {
    const workspaceId = await ws();
    await ingestInspiration(workspaceId, { title: '这个多少钱', note: '被问到 3 次', source: 'comment' });
    const r = await ingestInspiration(workspaceId, { title: '这个多少钱', note: '被问到 5 次', source: 'rival-comment' });
    expect(r.ok && r.duplicate).toBe(false);
    expect(await prisma.inspirationItem.count({ where: { workspaceId } })).toBe(2);
  });

  it('同一来源里的同一个问题仍然去重，只更新次数', async () => {
    const workspaceId = await ws();
    await ingestInspiration(workspaceId, { title: '这个多少钱', note: '被问到 3 次', source: 'rival-comment' });
    const r = await ingestInspiration(workspaceId, { title: '这个多少钱', note: '被问到 7 次', source: 'rival-comment' });
    expect(r.ok && r.duplicate).toBe(true);
    expect(await prisma.inspirationItem.count({ where: { workspaceId } })).toBe(1);
    expect((await prisma.inspirationItem.findFirst({ where: { workspaceId } }))!.note).toBe('被问到 7 次');
  });

  it('校验：标题必填、URL 要合法、未知平台打回', () => {
    expect(inspirationPayloadSchema.safeParse({ title: '' }).success).toBe(false);
    expect(inspirationPayloadSchema.safeParse({ title: 'A', url: '不是链接' }).success).toBe(false);
    expect(inspirationPayloadSchema.safeParse({ title: 'A', platform: 'myspace' }).success).toBe(false);
    expect(inspirationPayloadSchema.safeParse({ title: 'A', platform: 'douyin' }).success).toBe(true);
    // 平台可空：在不认识的站点上刷到好东西，恰恰是收集箱最该支持的场景
    expect(inspirationPayloadSchema.safeParse({ title: 'A' }).success).toBe(true);
  });
});

describe('取数范围与出队', () => {
  beforeEach(async () => {
    await prisma.inspirationItem.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
  });

  it('只取本账号专属 + 工作区共享的待用条目', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const w = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const mine = await prisma.creatorAccount.create({ data: { workspaceId: w.id, name: 'a', platform: 'douyin' } });
    const other = await prisma.creatorAccount.create({ data: { workspaceId: w.id, name: 'b', platform: 'douyin' } });
    await prisma.inspirationItem.createMany({
      data: [
        { workspaceId: w.id, title: '共享的', accountId: null },
        { workspaceId: w.id, title: '我的', accountId: mine.id },
        { workspaceId: w.id, title: '别人的', accountId: other.id },
        { workspaceId: w.id, title: '已归档的', accountId: null, state: 'archived' },
      ],
    });
    const rows = await loadInspirations(w.id, mine.id);
    expect(rows.map((r) => r.title).sort()).toEqual(['我的', '共享的'].sort());
  });

  it('markInspirationUsed 出队（不出队会在往后每一轮重复冒出来）', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const w = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const row = await prisma.inspirationItem.create({ data: { workspaceId: w.id, title: 'A' } });
    await markInspirationUsed(row.id);
    const after = await prisma.inspirationItem.findUnique({ where: { id: row.id } });
    expect(after!.state).toBe('used');
    expect(after!.usedAt).not.toBeNull();
  });

  it('markInspirationUsed 对不存在的 id 静默通过（选题的 sourceRef 是松引用）', async () => {
    await expect(markInspirationUsed('nope')).resolves.toBeUndefined();
  });
});
