import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { purgeRemovedAccountData, resolveRemovalRequest, isRemovalRequested } from '@/lib/legal/removal';

// 申请页对权利人承诺的是「停止采集**并移除已收集的**相关公开信息」。
// 停采此前有闸门，「移除已收集的」那半句一直没有代码兑现——本文件锁住它。

async function seedCompetitor(platform: string, handle: string) {
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.competitorAccount.create({ data: { platform, handle, name: '某账号' } });
  // platformItemId 全局唯一（@@unique([platform, platformItemId])）——按 handle 取名，
  // 否则「两个账号」的用例会撞唯一约束
  await prisma.crawledPost.createMany({
    data: [
      { competitorId: acc.id, platform, platformItemId: `${handle}-p1`, title: 'a' },
      { competitorId: acc.id, platform, platformItemId: `${handle}-p2`, title: 'b' },
    ],
  });
  await prisma.watchlistItem.create({ data: { workspaceId: ws.id, competitorId: acc.id } });
  // 采集台账：无外键不会级联，必须被显式删掉——它留着账号名和「哪几天采过它」
  await prisma.collectionRun.create({
    data: { workspaceId: ws.id, scope: 'rival', platform, targetId: acc.id, targetName: '某账号', channel: 'manual', items: 2 },
  });
  return { accountId: acc.id, workspaceId: ws.id };
}

// 从该账号作品评论区提取的读者提问。source='rival-comment'、author=作品作者 handle。
async function seedCommentQuestion(workspaceId: string, platform: string, handle: string, text: string) {
  await prisma.inspirationItem.create({
    data: { workspaceId, title: text, platform, author: handle, source: 'rival-comment', askedCount: 3, askedWorks: 2 },
  });
}

// 该账号作品评论区留存的读者原声正文（ReaderComment）。author 同样是**作品作者**的 handle。
let seedSeq = 0;
async function seedReaderComment(workspaceId: string, platform: string, handle: string, text: string) {
  seedSeq += 1;
  await prisma.readerComment.create({
    data: {
      workspaceId, platform, scope: 'rival', author: handle,
      workKey: `w${seedSeq}`, text, kind: 'other', textHash: `h${seedSeq}`,
    },
  });
}

beforeEach(async () => {
  await prisma.inspirationItem.deleteMany();
  await prisma.readerComment.deleteMany();
  await prisma.dataRemovalRequest.deleteMany();
  await prisma.collectionRun.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('执行移除', () => {
  it('删档案的同时级联带走作品与订阅关系', async () => {
    const { workspaceId } = await seedCompetitor('douyin', 'abc');
    await seedCommentQuestion(workspaceId, 'douyin', 'abc', '这个怎么收费呢');
    await seedReaderComment(workspaceId, 'douyin', 'abc', '这条视频的配色真好看');
    const r = await purgeRemovedAccountData('douyin', 'abc');
    expect(r).toEqual({
      accounts: 1, posts: 2, watchlistItems: 1, runs: 1, commentQuestions: 1, readerComments: 1,
      // 站点类那三项在**账号**移除里恒为 0：站点停采与账号停采是两条互不相干的路
      scrapeRecords: 0, scrapeRecipes: 0, aiCitations: 0, clips: 0,
    });
    expect(await prisma.competitorAccount.count()).toBe(0);
    expect(await prisma.crawledPost.count()).toBe(0);
    expect(await prisma.watchlistItem.count()).toBe(0);
    // 台账里不能留下「我采过这个号」的痕迹
    expect(await prisma.collectionRun.count()).toBe(0);
    // 从它评论区提取的读者提问同样要带走
    expect(await prisma.inspirationItem.count()).toBe(0);
    // 评论正文更要带走：「已经不采你了」却把你作品下的读者原话留着，这句承诺就是假的
    expect(await prisma.readerComment.count()).toBe(0);
  });

  it('库里本来就没有这个账号 → 零删除且不报错（收到申请但从没采过是常态）', async () => {
    expect(await purgeRemovedAccountData('douyin', 'never-seen'))
      .toEqual({
        accounts: 0, posts: 0, watchlistItems: 0, runs: 0, commentQuestions: 0, readerComments: 0,
        scrapeRecords: 0, scrapeRecipes: 0, aiCitations: 0, clips: 0,
      });
  });

  it('只删被申请的那个账号，同平台其他账号不受影响', async () => {
    await seedCompetitor('douyin', 'target');
    await seedCompetitor('douyin', 'innocent');
    await purgeRemovedAccountData('douyin', 'target');
    const left = await prisma.competitorAccount.findMany({ select: { handle: true } });
    expect(left.map((x) => x.handle)).toEqual(['innocent']);
    // 台账同理：只带走被申请那个号的行
    expect(await prisma.collectionRun.count()).toBe(1);
  });
});

// 这三条盯的是同一个形状的事故：删除范围写宽了。宽出去的部分是**别人的**数据，
// 删完不可恢复、没有任何人会收到通知，所以只能靠用例守。
describe('评论提问的移除范围', () => {
  it('同平台另一个账号的提问一条都不能碰', async () => {
    const { workspaceId } = await seedCompetitor('douyin', 'target');
    await seedCommentQuestion(workspaceId, 'douyin', 'target', '这个怎么收费呢');
    await seedCommentQuestion(workspaceId, 'douyin', 'innocent', '什么时候出教程');
    const r = await purgeRemovedAccountData('douyin', 'target');
    expect(r.commentQuestions).toBe(1);
    const left = await prisma.inspirationItem.findMany({ select: { author: true } });
    expect(left.map((x) => x.author)).toEqual(['innocent']);
  });

  // 移除是**跨工作区**的：申请人要的是「你们这儿别再有我的数据」，不是「某个客户那儿没有」。
  // 所以同一个 handle 在别的工作区也要删；但别的工作区里**别人**的提问一条都不能连坐。
  it('跨工作区删同一个账号，但不碰别的工作区里其他账号的提问', async () => {
    const a = await seedCompetitor('douyin', 'target');
    const tenant = await prisma.tenant.create({ data: { name: 't2' } });
    const other = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w2' } });
    await seedCommentQuestion(a.workspaceId, 'douyin', 'target', '这个怎么收费呢');
    await seedCommentQuestion(other.id, 'douyin', 'target', '有没有优惠券呢');   // 同号，另一个工作区 → 要删
    await seedCommentQuestion(other.id, 'douyin', 'innocent', '什么时候出教程'); // 同平台别的号 → 不能碰
    const r = await purgeRemovedAccountData('douyin', 'target');
    expect(r.commentQuestions).toBe(2);
    const left = await prisma.inspirationItem.findMany({ select: { author: true, workspaceId: true } });
    expect(left).toEqual([{ author: 'innocent', workspaceId: other.id }]);
  });

  it('自有作品的提问（source=comment）不受影响：那是用户自己读者的话，不属于被申请人', async () => {
    const { workspaceId } = await seedCompetitor('douyin', 'target');
    await prisma.inspirationItem.create({
      data: { workspaceId, title: '这个怎么收费呢', platform: 'douyin', author: 'target', source: 'comment' },
    });
    const r = await purgeRemovedAccountData('douyin', 'target');
    expect(r.commentQuestions).toBe(0);
    expect(await prisma.inspirationItem.count()).toBe(1);
  });

  // 评论**正文**的范围。与提问同一形状的风险，但后果更重：宽出去删的是别人的原话，
  // 窄进来留下的也是别人的原话。
  it('正文只删被申请那个账号的，同平台别的账号一条不碰', async () => {
    const { workspaceId } = await seedCompetitor('douyin', 'target');
    await seedReaderComment(workspaceId, 'douyin', 'target', '这条视频的配色真好看');
    await seedReaderComment(workspaceId, 'douyin', 'innocent', '这期节奏有点快了');
    const r = await purgeRemovedAccountData('douyin', 'target');
    expect(r.readerComments).toBe(1);
    const left = await prisma.readerComment.findMany({ select: { author: true } });
    expect(left.map((x) => x.author)).toEqual(['innocent']);
  });

  it('自有作品的正文（scope=own）不受影响：那是用户自己读者的话', async () => {
    const { workspaceId } = await seedCompetitor('douyin', 'target');
    await prisma.readerComment.create({
      data: {
        workspaceId, platform: 'douyin', scope: 'own', author: 'target',
        workKey: 'own1', text: '这期我照着做成功了', kind: 'praise', textHash: 'own-h1',
      },
    });
    const r = await purgeRemovedAccountData('douyin', 'target');
    expect(r.readerComments).toBe(0);
    expect(await prisma.readerComment.count()).toBe(1);
  });

  it('账号从没进过竞对库，也要删得掉它名下的正文', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    await seedReaderComment(ws.id, 'douyin', 'no-profile', '这条的收音有点糊');
    const r = await purgeRemovedAccountData('douyin', 'no-profile');
    expect(r.accounts).toBe(0);
    expect(r.readerComments).toBe(1);
    expect(await prisma.readerComment.count()).toBe(0);
  });

  it('账号从没进过竞对库，也要删得掉它名下的提问（评论可从任意公开作品页提取）', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    await seedCommentQuestion(ws.id, 'douyin', 'no-profile', '这个怎么收费呢');
    const r = await purgeRemovedAccountData('douyin', 'no-profile');
    expect(r.accounts).toBe(0);          // 竞对库里确实没有它的档案
    expect(r.commentQuestions).toBe(1);  // 但提问必须删掉
    expect(await prisma.inspirationItem.count()).toBe(0);
  });
});

describe('申请状态流转', () => {
  it('核验成立 → 标记 removed + 执行删除 + 继续停采', async () => {
    await seedCompetitor('xiaohongshu', 'star');
    const req = await prisma.dataRemovalRequest.create({
      data: { platform: 'xiaohongshu', handle: 'star', contact: 'a@b.com' },
    });
    const r = await resolveRemovalRequest(req.id, 'removed');
    expect(r.ok).toBe(true);
    expect(r.purged).toEqual({
      accounts: 1, posts: 2, watchlistItems: 1, runs: 1, commentQuestions: 0, readerComments: 0,
      scrapeRecords: 0, scrapeRecipes: 0, aiCitations: 0, clips: 0,
    });
    const after = await prisma.dataRemovalRequest.findUnique({ where: { id: req.id } });
    expect(after?.status).toBe('removed');
    expect(after?.resolvedAt).toBeTruthy();
    expect(await isRemovalRequested('xiaohongshu', 'star')).toBe(true);
  });

  it('驳回 → 恢复采集，且不删任何数据（冒用他人身份的申请不能连坐真实数据）', async () => {
    await seedCompetitor('bilibili', 'up1');
    const req = await prisma.dataRemovalRequest.create({
      data: { platform: 'bilibili', handle: 'up1', contact: 'x@y.com' },
    });
    const r = await resolveRemovalRequest(req.id, 'rejected');
    expect(r.ok).toBe(true);
    expect(r.purged).toBeUndefined();
    expect(await prisma.competitorAccount.count()).toBe(1);
    expect(await prisma.crawledPost.count()).toBe(2);
    expect(await isRemovalRequested('bilibili', 'up1')).toBe(false);
  });

  it('不存在的申请 → 如实报错，不静默成功', async () => {
    expect(await resolveRemovalRequest('nope', 'removed')).toEqual({ ok: false, error: '申请不存在' });
  });
});
