import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { accountInventory, mergeAccounts, deleteAccount, asTx } from '@/lib/account/merge';
import { normalizeAccountKey, looksLikeSameAccount, duplicateGroups } from '@/lib/account/duplicate';

// 账号合并与彻底删除。
//
// 【为什么有这个功能】同一个真实账号会在库里躺成两条：网页里用户按昵称建了「Aiya哎呀」（handle=Aiyafun），
// 插件在作品页按用户名又建了「aiyafun」。数据从此一分为二，而每个数据页都是
// `where: { accountId: 当前账号 }`——用户看到的是「一半数据不见了」，基线/学习信号也各算一半。
//
// 这份用例钉的是三件最容易出错的事：
//   ① 搬要搬干净（含没有外键的那几张表），来源账号不能留下空壳；
//   ② 撞唯一键时不能整批失败，也不能悄悄丢数据；
//   ③ 删除时记忆必须**删掉**——MemoryEntry 的外键是 SetNull，直接删账号会把它的记忆
//      变成「工作区共享记忆」，然后被别的账号召回。删掉的号反而开始影响别人的稿子。

const tx = asTx();
let wsId = '';
let srcId = '';
let tgtId = '';

async function makeAccount(name: string, platform: string, handle?: string) {
  const a = await prisma.creatorAccount.create({ data: { workspaceId: wsId, name, platform, handle } });
  return a.id;
}

beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.workspace.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  wsId = ws.id;
  srcId = await makeAccount('aiyafun', 'x');
  tgtId = await makeAccount('Aiya哎呀', 'x', 'Aiyafun');
});

/** 建一条定时智能体（需要一个模板：ScheduledAgent.templateId 有外键） */
async function makeSchedule(accountId: string) {
  const t = await prisma.workflowTemplate.create({
    data: { slug: `s-${accountId}`, name: '测试模板', steps: '[]', isBuiltin: false, tenantId: null },
  });
  return prisma.scheduledAgent.create({
    data: { workspaceId: wsId, accountId, templateId: t.id, createdBy: 'm1' },
  });
}

describe('定时智能体的归属：accountId 没有外键，不显式处理就是「还在动的僵尸」', () => {
  it('合并时**搬走**——用户配的「每天 9 点」不该因为合并而消失', async () => {
    await makeSchedule(srcId);
    await mergeAccounts(tx, wsId, srcId, tgtId);
    expect(await prisma.scheduledAgent.count({ where: { accountId: srcId } })).toBe(0);
    expect(await prisma.scheduledAgent.count({ where: { accountId: tgtId } })).toBe(1);
  });

  it('删账号时**删掉**——留着的话 worker 每天照常用一个已删除的 id 去建草稿', async () => {
    const before = await makeSchedule(srcId);
    // 删除前必须先归档（deleteAccount 的前置闸），不然拿到的是「只有已归档的账号能删除」
    await prisma.creatorAccount.update({ where: { id: srcId }, data: { status: 'archived' } });
    const r = await deleteAccount(tx, wsId, srcId, 'aiyafun');
    expect(r.ok, 'error' in r ? r.error : '').toBe(true);
    expect(await prisma.scheduledAgent.findUnique({ where: { id: before.id } })).toBeNull();
    // 另一个账号的计划不许被连带删掉
    const keep = await makeSchedule(tgtId);
    expect(await prisma.scheduledAgent.findUnique({ where: { id: keep.id } })).not.toBeNull();
  });

  it('删除前的清单里要列出它——不然用户删完才发现自己的计划没了', async () => {
    await makeSchedule(srcId);
    const rows = await accountInventory(tx, srcId);
    const row = rows.find((r) => r.key === 'scheduledAgent');
    expect(row, '清单里没有定时智能体这一项').toBeTruthy();
    expect(row!.count).toBe(1);
  });
});

describe('合并账号', () => {
  it('数据全部搬到保留账号名下，来源账号不留空壳', async () => {
    await prisma.draft.create({ data: { accountId: srcId, title: '稿', platform: 'x' } });
    await prisma.topicIdea.create({ data: { accountId: srcId, title: '选题', angle: '角度' } });
    await prisma.publishRecord.create({ data: { accountId: srcId, platform: 'x', platformItemId: 'p1' } });
    await prisma.ownPost.create({ data: { accountId: srcId, platform: 'x', title: '旧作品' } });
    await prisma.material.create({ data: { accountId: srcId, type: 'experience', content: '经历' } });
    await prisma.accountDailyStat.create({ data: { accountId: srcId, platform: 'x', date: '2026-08-01', followers: 100 } });
    await prisma.audienceProfile.create({ data: { accountId: srcId, platform: 'x' } });
    await prisma.memoryEntry.create({ data: { workspaceId: wsId, accountId: srcId, type: 'preference', content: '偏好' } });
    await prisma.inspirationItem.create({ data: { workspaceId: wsId, accountId: srcId, title: '灵感' } });
    await prisma.collectionRun.create({
      data: { workspaceId: wsId, scope: 'self', platform: 'x', targetId: srcId, targetName: 'aiyafun', channel: 'plugin_home' },
    });

    const r = await mergeAccounts(tx, wsId, srcId, tgtId);
    expect(r.ok, 'ok' in r && !r.ok ? r.error : '').toBe(true);

    // 来源账号消失，数据一条不少地挂到目标账号名下
    expect(await prisma.creatorAccount.findUnique({ where: { id: srcId } })).toBeNull();
    const rows = await accountInventory(tx, tgtId);
    const count = (key: string) => rows.find((x) => x.key === key)?.count ?? -1;
    expect(count('draft')).toBe(1);
    expect(count('topicIdea')).toBe(1);
    expect(count('publishRecord')).toBe(1);
    expect(count('ownPost')).toBe(1);
    expect(count('material')).toBe(1);
    expect(count('accountDailyStat')).toBe(1);
    expect(count('audienceProfile')).toBe(1);
    expect(count('inspirationItem')).toBe(1);
    expect(count('collectionRun')).toBe(1);

    // 记忆要跟着账号走，而不是被 SetNull 变成工作区共享记忆
    const mem = await prisma.memoryEntry.findFirst({ where: { workspaceId: wsId } });
    expect(mem?.accountId).toBe(tgtId);
  });

  it('采集台账的 targetName 保持采集当时的快照，不被改写', async () => {
    await prisma.collectionRun.create({
      data: { workspaceId: wsId, scope: 'self', platform: 'x', targetId: srcId, targetName: 'aiyafun', channel: 'plugin_home' },
    });
    await mergeAccounts(tx, wsId, srcId, tgtId);
    const run = await prisma.collectionRun.findFirst({ where: { workspaceId: wsId } });
    expect(run?.targetId).toBe(tgtId);
    expect(run?.targetName).toBe('aiyafun'); // 台账是凭证：账号名可以改，历史记录不能被改写
  });

  it('同一天的账号数据两边都有：保留账号那条留下，缺的字段用来源补上', async () => {
    await prisma.accountDailyStat.create({
      data: { accountId: srcId, platform: 'x', date: '2026-08-01', followers: 100, views: 999 },
    });
    await prisma.accountDailyStat.create({
      data: { accountId: tgtId, platform: 'x', date: '2026-08-01', views: 30 },
    });

    const r = await mergeAccounts(tx, wsId, srcId, tgtId);
    expect(r.ok).toBe(true);

    const stats = await prisma.accountDailyStat.findMany({ where: { accountId: tgtId } });
    expect(stats).toHaveLength(1); // 撞唯一键没有让整批失败，也没有堆出两条
    expect(stats[0].views).toBe(30); // 保留账号自己的值优先
    expect(stats[0].followers).toBe(100); // 它没记到的，用来源补上
    if (r.ok) expect(r.dropped.find((d) => d.label === '每日账号数据')?.count).toBe(1);
  });

  it('同一篇发布记录两边都有：来源那条的历史快照挂到保留的那条上，不凭空消失', async () => {
    const src = await prisma.publishRecord.create({
      data: { accountId: srcId, platform: 'x', platformItemId: 'same', metrics: JSON.stringify({ views: 10, likes: 3 }) },
    });
    await prisma.performanceSnapshot.create({ data: { publishId: src.id, metrics: JSON.stringify({ views: 10 }) } });
    const tgt = await prisma.publishRecord.create({
      data: { accountId: tgtId, platform: 'x', platformItemId: 'same', metrics: JSON.stringify({ views: 20 }) },
    });
    await prisma.performanceSnapshot.create({ data: { publishId: tgt.id, metrics: JSON.stringify({ views: 20 }) } });

    const r = await mergeAccounts(tx, wsId, srcId, tgtId);
    expect(r.ok).toBe(true);

    const records = await prisma.publishRecord.findMany({ where: { accountId: tgtId } });
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(tgt.id);
    const metrics = JSON.parse(records[0].metrics);
    expect(metrics.views).toBe(20); // 保留账号那条的值优先
    expect(metrics.likes).toBe(3); // 它没有的指标，用来源那条补齐
    expect(await prisma.performanceSnapshot.count({ where: { publishId: tgt.id } })).toBe(2);
  });

  it('平台不相容时报错，一行都不动（X 的数据挂到抖音号下会污染基线）', async () => {
    const douyin = await makeAccount('抖音号', 'douyin');
    await prisma.draft.create({ data: { accountId: srcId, title: '稿', platform: 'x' } });

    const r = await mergeAccounts(tx, wsId, srcId, douyin);
    expect(r.ok).toBe(false);
    expect(await prisma.creatorAccount.findUnique({ where: { id: srcId } })).not.toBeNull();
    expect(await prisma.draft.count({ where: { accountId: srcId } })).toBe(1);
  });

  it('保留账号是「多平台」时允许合并——一人多平台是合法归属', async () => {
    const multi = await makeAccount('我的账号', 'multi');
    const r = await mergeAccounts(tx, wsId, srcId, multi);
    expect(r.ok).toBe(true);
  });

  it('不能合并到自己，也不能碰别的工作区的号', async () => {
    expect((await mergeAccounts(tx, wsId, srcId, srcId)).ok).toBe(false);
    const other = await prisma.workspace.create({
      data: { tenantId: (await prisma.tenant.create({ data: { name: 't2' } })).id, name: 'w2' },
    });
    const outsider = await prisma.creatorAccount.create({ data: { workspaceId: other.id, name: '别人的号', platform: 'x' } });
    expect((await mergeAccounts(tx, wsId, srcId, outsider.id)).ok).toBe(false);
    expect((await mergeAccounts(tx, other.id, srcId, outsider.id)).ok).toBe(false);
    expect(await prisma.creatorAccount.findUnique({ where: { id: srcId } })).not.toBeNull();
  });
});

describe('彻底删除账号', () => {
  it('只有已归档的账号能删', async () => {
    const r = await deleteAccount(tx, wsId, srcId, 'aiyafun');
    expect(r.ok).toBe(false);
    expect(await prisma.creatorAccount.findUnique({ where: { id: srcId } })).not.toBeNull();
  });

  it('名称对不上不删——输入框是提醒，服务端这一行才是真正的闸', async () => {
    await prisma.creatorAccount.update({ where: { id: srcId }, data: { status: 'archived' } });
    const r = await deleteAccount(tx, wsId, srcId, 'aiya');
    expect(r.ok).toBe(false);
    expect(await prisma.creatorAccount.findUnique({ where: { id: srcId } })).not.toBeNull();
  });

  it('删除会带走名下数据；记忆必须真的删掉，不能变成工作区共享记忆', async () => {
    await prisma.creatorAccount.update({ where: { id: srcId }, data: { status: 'archived' } });
    await prisma.draft.create({ data: { accountId: srcId, title: '稿', platform: 'x' } });
    await prisma.memoryEntry.create({ data: { workspaceId: wsId, accountId: srcId, type: 'preference', content: '偏好' } });
    await prisma.notification.create({ data: { workspaceId: wsId, accountId: srcId, kind: 'test', title: '通知' } });
    await prisma.inspirationItem.create({ data: { workspaceId: wsId, accountId: srcId, title: '灵感' } });
    await prisma.collectionRun.create({
      data: { workspaceId: wsId, scope: 'self', platform: 'x', targetId: srcId, targetName: 'aiyafun', channel: 'plugin_home' },
    });

    const r = await deleteAccount(tx, wsId, srcId, 'aiyafun');
    expect(r.ok, 'ok' in r && !r.ok ? r.error : '').toBe(true);

    expect(await prisma.creatorAccount.findUnique({ where: { id: srcId } })).toBeNull();
    expect(await prisma.draft.count()).toBe(0);
    // ⚠️ 这一条是本文件的重点：外键是 SetNull，不显式删就会留下一条 accountId=null 的
    // 「工作区共享记忆」，被其它账号的上下文召回——删掉的号反而开始影响别人的稿子
    expect(await prisma.memoryEntry.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    // 灵感不属于任何账号也能用，转为工作区共享而不是销毁
    const insp = await prisma.inspirationItem.findFirst();
    expect(insp?.accountId).toBeNull();
    // 采集台账是合规凭证，账号没了也要留着（名字有快照，读得懂）
    expect(await prisma.collectionRun.count()).toBe(1);
  });

  it('群里绑定到这个账号的机器人会话会解绑，而不是指向一个已删除的 id', async () => {
    await prisma.creatorAccount.update({ where: { id: srcId }, data: { status: 'archived' } });
    const bot = await prisma.botIntegration.create({ data: { workspaceId: wsId, provider: 'feishu' } });
    await prisma.botConversation.create({
      data: { workspaceId: wsId, integrationId: bot.id, chatId: 'c1', accountId: srcId },
    });

    expect((await deleteAccount(tx, wsId, srcId, 'aiyafun')).ok).toBe(true);
    const conv = await prisma.botConversation.findFirst();
    expect(conv?.accountId).toBeNull();
  });

  it('最后一个账号不能删', async () => {
    await prisma.creatorAccount.delete({ where: { id: tgtId } });
    await prisma.creatorAccount.update({ where: { id: srcId }, data: { status: 'archived' } });
    const r = await deleteAccount(tx, wsId, srcId, 'aiyafun');
    expect(r.ok).toBe(false);
  });
});

describe('疑似重复判定', () => {
  it('规范化：去 @、去空白、大小写不敏感', () => {
    expect(normalizeAccountKey(' @Aiyafun ')).toBe('aiyafun');
    expect(normalizeAccountKey('Aiya fun')).toBe('aiyafun');
    expect(normalizeAccountKey(null)).toBe('');
  });

  it('一边把用户名当账号名、另一边把它填进 handle —— 正是真实重复的形态', () => {
    const fromPlugin = { name: 'aiyafun', platform: 'x' };
    const fromWeb = { name: 'Aiya哎呀', platform: 'x', handle: '@Aiyafun' };
    expect(looksLikeSameAccount(fromPlugin, fromWeb)).toBe(true);
  });

  it('跨平台同名不算重复（一个人在两个平台用同一个名字是常态）', () => {
    expect(looksLikeSameAccount({ name: 'aiyafun', platform: 'x' }, { name: 'aiyafun', platform: 'douyin' })).toBe(false);
  });

  it('没有 handle、名字也不同的两个号不算重复', () => {
    expect(looksLikeSameAccount({ name: '主号', platform: 'x' }, { name: '小号', platform: 'x' })).toBe(false);
  });

  it('分组：A≈B、B≈C 滚成一组，不相干的不进组', () => {
    const groups = duplicateGroups([
      { id: '1', name: 'aiyafun', platform: 'x' },
      { id: '2', name: 'Aiya哎呀', platform: 'x', handle: 'Aiyafun' },
      { id: '3', name: 'AIYAFUN', platform: 'x' },
      { id: '4', name: '别的号', platform: 'x' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((a) => a.id)).toEqual(['1', '2', '3']);
  });
});
