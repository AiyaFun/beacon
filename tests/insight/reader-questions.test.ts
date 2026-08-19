import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { groupQuestionsByWork, readerQuestionsByWork, rivalReaderQuestions } from '@/lib/insight/reader-questions';

// 「这条作品下读者在问什么」——评论提问按 platformItemId 挂回作品行（数据页场景①）。
// 口径错了不是显示不好看，是指鹿为马：把 A 作品下的提问挂到 B 头上、
// 把竞对读者的提问挂到自有作品上、把跨作品总热度算到单条作品头上。

async function ws(): Promise<string> {
  const t = await prisma.tenant.create({ data: { name: 't' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
  return w.id;
}

beforeEach(async () => {
  await prisma.inspirationItem.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('groupQuestionsByWork 纯分组口径', () => {
  it('按 platform:workKey 分组，作品内按被问次数降序', () => {
    const m = groupQuestionsByWork([
      { title: '这个怎么收费', platform: 'douyin', askedBreak: '{"7001":2,"7002":5}' },
      { title: '有教程吗', platform: 'douyin', askedBreak: '{"7001":7}' },
    ]);
    expect(m.get('douyin:7001')).toEqual([
      { text: '有教程吗', count: 7 },
      { text: '这个怎么收费', count: 2 },
    ]);
    // count 取的是**该作品下**的次数（askedBreak 的值），不是跨作品总和
    expect(m.get('douyin:7002')).toEqual([{ text: '这个怎么收费', count: 5 }]);
  });

  it('🔒 key 带平台前缀：不同平台的同形 workKey 不互相污染', () => {
    const m = groupQuestionsByWork([
      { title: '抖音的问题', platform: 'douyin', askedBreak: '{"123":2}' },
      { title: 'B站的问题', platform: 'bilibili', askedBreak: '{"123":3}' },
    ]);
    expect(m.get('douyin:123')).toEqual([{ text: '抖音的问题', count: 2 }]);
    expect(m.get('bilibili:123')).toEqual([{ text: 'B站的问题', count: 3 }]);
  });

  it('🔒 sha:（标题哈希）与 unknown 的 workKey 不做逐作品归属', () => {
    const m = groupQuestionsByWork([
      { title: '对不上作品的提问', platform: 'douyin', askedBreak: '{"sha:ab12":4,"unknown":2}' },
    ]);
    expect(m.size).toBe(0);
  });

  it('platform 为空或 count 非法的行跳过，不抛错', () => {
    const m = groupQuestionsByWork([
      { title: '无平台', platform: null, askedBreak: '{"7001":2}' },
      { title: '坏JSON', platform: 'douyin', askedBreak: '{oops' },
      { title: '零次', platform: 'douyin', askedBreak: '{"7001":0}' },
    ]);
    expect(m.size).toBe(0);
  });
});

describe('readerQuestionsByWork 查询口径', () => {
  it('🔒 只取自有评论（source=comment）——竞对读者的提问绝不挂到自有作品行', async () => {
    const wid = await ws();
    const base = {
      workspaceId: wid,
      platform: 'douyin',
      askedBreak: '{"7001":3}',
      askedCount: 3,
      askedWorks: 1,
    };
    await prisma.inspirationItem.create({ data: { ...base, title: '自有的提问', source: 'comment' } });
    await prisma.inspirationItem.create({ data: { ...base, title: '竞对的提问', source: 'rival-comment' } });
    await prisma.inspirationItem.create({ data: { ...base, title: '手动收藏', source: 'manual' } });

    const m = await readerQuestionsByWork(wid, 'acc-1');
    expect(m.get('douyin:7001')).toEqual([{ text: '自有的提问', count: 3 }]);
  });

  it('accountId 取本账号或空（工作区共享），别的账号名下的不取；archived 不取', async () => {
    const wid = await ws();
    const base = {
      workspaceId: wid,
      platform: 'douyin',
      source: 'comment',
      askedBreak: '{"7001":2}',
      askedCount: 2,
      askedWorks: 1,
    };
    await prisma.inspirationItem.create({ data: { ...base, title: '挂本账号', accountId: 'acc-1' } });
    await prisma.inspirationItem.create({ data: { ...base, title: '工作区共享', accountId: null } });
    await prisma.inspirationItem.create({ data: { ...base, title: '别的账号', accountId: 'acc-2' } });
    await prisma.inspirationItem.create({ data: { ...base, title: '已归档', accountId: 'acc-1', state: 'archived' } });
    await prisma.inspirationItem.create({ data: { ...base, title: '已转选题', accountId: 'acc-1', state: 'used' } });

    const m = await readerQuestionsByWork(wid, 'acc-1');
    const texts = (m.get('douyin:7001') ?? []).map((q) => q.text).sort();
    expect(texts).toEqual(['工作区共享', '已转选题', '挂本账号']);
  });
});

describe('rivalReaderQuestions（竞对拆解的读者反馈缺口证据）', () => {
  it('🔒 只取该平台该 handle 的 rival-comment，按被问次数降序', async () => {
    const wid = await ws();
    const base = { workspaceId: wid, source: 'rival-comment', askedWorks: 1 };
    await prisma.inspirationItem.create({
      data: { ...base, title: '这个模型多少钱', platform: 'youtube', author: '@TechRival', askedBreak: '{"v1":5}', askedCount: 5 },
    });
    await prisma.inspirationItem.create({
      data: { ...base, title: '有没有教程', platform: 'youtube', author: '@TechRival', askedBreak: '{"v1":2,"v2":7}', askedCount: 9, askedWorks: 2 },
    });
    // 同平台别的竞对、别的平台同名 handle、自有评论——三样都不许混进来
    await prisma.inspirationItem.create({
      data: { ...base, title: '别的竞对的提问', platform: 'youtube', author: '@OtherOne', askedBreak: '{"v9":3}', askedCount: 3 },
    });
    await prisma.inspirationItem.create({
      data: { ...base, title: '别的平台的提问', platform: 'x', author: 'TechRival', askedBreak: '{"s1":4}', askedCount: 4 },
    });
    await prisma.inspirationItem.create({
      data: { ...base, title: '自有评论的提问', platform: 'youtube', author: '@TechRival', source: 'comment', askedBreak: '{"v1":8}', askedCount: 8 },
    });

    const qs = await rivalReaderQuestions(wid, 'youtube', '@TechRival');
    expect(qs).toEqual([
      { text: '有没有教程', count: 9, works: 2 },
      { text: '这个模型多少钱', count: 5, works: 1 },
    ]);
  });

  it('handle 等价写法能对上（@ 前缀与大小写差异，口径同移除申请）', async () => {
    const wid = await ws();
    // 采集侧存的 author 是页面上的写法（无 @、原大小写），库里竞对 handle 是 @ 小写
    await prisma.inspirationItem.create({
      data: {
        workspaceId: wid, source: 'rival-comment', title: '下期什么时候出',
        platform: 'youtube', author: 'TechRival', askedBreak: '{"v1":3}', askedCount: 3, askedWorks: 1,
      },
    });
    const qs = await rivalReaderQuestions(wid, 'youtube', '@techrival');
    expect(qs.map((q) => q.text)).toEqual(['下期什么时候出']);
  });
});
