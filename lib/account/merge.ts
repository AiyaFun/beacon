import { prisma } from '@/lib/db';
import { parseJson, toJson, type Metrics } from '@/lib/json';
import { platformName } from '@/lib/constants';
import type { TxClient } from '@/lib/tenant-rls';

// 账号合并与删除。
//
// 【为什么需要合并】同一个真实账号会在库里躺成两条（见 lib/account/duplicate.ts 的长注释）：
// 网页手填一条、插件就地建号一条。数据从此一分为二，而每个数据页都是
// `where: { accountId: 当前账号 }`——用户的体感是「一半数据凭空消失」，
// 更糟的是基线、学习信号、算法教练全按账号算，两边各算一半，两边都不准。
// 改名解决不了这个：名字只是显示，数据仍然挂在两个 id 上。只有把行搬过去才是真的合上。
//
// 【为什么删除只对已归档的号开放】删账号是不可逆的，且连带草稿/选题/发布记录一起没。
// 强制「先归档 → 确认没在用 → 再删」这一步，等于给用户一个自然的冷静期，
// 也让「归档」这个已有动作有了终点，不再是只进不出的垃圾堆。

// 清单口径：既是合并前的「要搬什么」，也是删除前的「要毁什么」。同一份口径两处共用，
// 否则会出现最难堪的不一致——预览说 12 条，删完实际没了 30 条。
export type AccountInventoryRow = { key: string; label: string; count: number };

/** 某个账号名下的数据清单。顺序即展示顺序：先「你产出的东西」，再「系统替你攒的」。 */
export async function accountInventory(tx: TxClient, accountId: string): Promise<AccountInventoryRow[]> {
  const byAccount = { accountId };
  const [
    topics, drafts, publishes, ownPosts, dailyStats, audience,
    materials, memories, reviews, advisorSessions, advisorPersonas,
    personaVersions, inspirations, readerComments, mediaAssets, notifications, runs, schedules,
  ] = await Promise.all([
    tx.topicIdea.count({ where: byAccount }),
    tx.draft.count({ where: byAccount }),
    tx.publishRecord.count({ where: byAccount }),
    tx.ownPost.count({ where: byAccount }),
    tx.accountDailyStat.count({ where: byAccount }),
    tx.audienceProfile.count({ where: byAccount }),
    tx.material.count({ where: byAccount }),
    tx.memoryEntry.count({ where: byAccount }),
    tx.reviewReport.count({ where: byAccount }),
    tx.advisorSession.count({ where: byAccount }),
    tx.advisorPersona.count({ where: byAccount }),
    tx.personaVersion.count({ where: byAccount }),
    tx.inspirationItem.count({ where: byAccount }),
    tx.readerComment.count({ where: byAccount }),
    tx.mediaAsset.count({ where: byAccount }),
    tx.notification.count({ where: byAccount }),
    tx.collectionRun.count({ where: { scope: 'self', targetId: accountId } }),
    // 清单是删除确认页上给用户看的那份「会连带什么」。定时智能体不列出来的话，
    // 用户删完才发现「每天 9 点那条计划怎么没了」——而那是他自己配的、最有存在感的东西之一
    tx.scheduledAgent.count({ where: byAccount }),
  ]);
  return [
    { key: 'topicIdea', label: '选题', count: topics },
    { key: 'draft', label: '草稿', count: drafts },
    { key: 'publishRecord', label: '发布记录', count: publishes },
    { key: 'ownPost', label: '历史作品', count: ownPosts },
    { key: 'accountDailyStat', label: '每日账号数据', count: dailyStats },
    { key: 'audienceProfile', label: '受众画像', count: audience },
    { key: 'material', label: '素材', count: materials },
    { key: 'memoryEntry', label: '长期记忆', count: memories },
    { key: 'reviewReport', label: '复盘报告', count: reviews },
    { key: 'advisorSession', label: '智囊团会话', count: advisorSessions },
    { key: 'advisorPersona', label: '智囊团人物卡', count: advisorPersonas },
    { key: 'personaVersion', label: '人设版本历史', count: personaVersions },
    { key: 'inspirationItem', label: '灵感', count: inspirations },
    { key: 'readerComment', label: '读者原声', count: readerComments },
    { key: 'mediaAsset', label: '封面与形象素材', count: mediaAssets },
    { key: 'notification', label: '通知', count: notifications },
    { key: 'collectionRun', label: '采集台账', count: runs },
    { key: 'scheduledAgent', label: '定时智能体', count: schedules },
  ];
}

export type MergeOutcome =
  | {
      ok: true;
      sourceName: string;
      targetName: string;
      /** 搬过去的行数（只列非零） */
      moved: { label: string; count: number }[];
      /** 目标已有同一条、来源那条被丢弃的行数（只列非零） */
      dropped: { label: string; count: number }[];
    }
  | { ok: false; error: string };

/**
 * 把 source 的数据全部并进 target，然后删掉 source 这个空壳。
 *
 * 规则（写在这里，界面上也照这个说，别让用户猜）：
 *   · 保留的是 **target** 的名称 / handle / 人设卡 / 风格指纹；source 的这四样连同人设版本历史一起丢弃。
 *     —— 人设版本号是按账号自增的，两段历史并进来会出现两个 v1、两个 v2，回滚时根本分不清是谁的。
 *   · 其余所有数据行都搬过去，一条不丢。
 *   · 撞唯一键的（同一天的账号数据、同一篇发布记录、同一个平台的受众画像、同名人物卡）：
 *     **目标已有的那条留下**，来源那条按字段补空后删除——目标是「留下来的那个号」，它自己的记录更可信。
 *   · 采集台账（CollectionRun）的 targetId 跟着搬，但 targetName 是采集当时的名字快照，不动。
 *
 * ⚠️ 平台必须相容（同平台，或目标是「多平台」）。否则 X 的数据会挂到抖音号下，
 *    平台基线、算法教练、学习样本全部按账号算，混进来的另一平台数据会污染每一项——
 *    这正是 2026-07-25 那次「回填成功但看板空白」事故的同一类错误。宁可报错让用户先改平台。
 */
export async function mergeAccounts(
  tx: TxClient,
  workspaceId: string,
  sourceId: string,
  targetId: string,
): Promise<MergeOutcome> {
  if (!sourceId || !targetId) return { ok: false, error: '请选择要合并的两个账号' };
  if (sourceId === targetId) return { ok: false, error: '不能把账号合并到它自己' };

  const [source, target] = await Promise.all([
    tx.creatorAccount.findFirst({ where: { id: sourceId, workspaceId } }),
    tx.creatorAccount.findFirst({ where: { id: targetId, workspaceId } }),
  ]);
  if (!source || !target) return { ok: false, error: '账号不存在或不属于当前工作区' };
  if (source.platform !== target.platform && target.platform !== 'multi') {
    return {
      ok: false,
      error:
        `保留的账号是「${platformName(target.platform)}」，被合并的是「${platformName(source.platform)}」——`
        + '两个平台的数据混在一个号下，平台基线和算法教练就都不准了。'
        + '确实是同一个人在多个平台，请先把保留账号的平台改成「多平台」再合并。',
    };
  }

  const moved: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  const addMoved = (k: string, n: number) => { if (n > 0) moved[k] = (moved[k] ?? 0) + n; };
  const addDropped = (k: string, n: number) => { if (n > 0) dropped[k] = (dropped[k] ?? 0) + n; };

  // ── ① 发布记录：唯一键 (accountId, platformItemId) ──
  // 同一篇作品两个号下各存了一条时，把来源那条的历史快照挂到目标那条上再删，指标按
  // 「目标已有的值优先、来源补空缺」合并——快照是趋势曲线的原料，直接删掉等于抹掉一段历史。
  // （实践中很少发生：lib/ingest/own-post.ts 的对齐是跨本工作区**所有**账号按 platformItemId 找的，
  //   同一篇不会在两个号下各建一条；能撞上的基本只有手动登记的发布记录。）
  const srcRecords = await tx.publishRecord.findMany({
    where: { accountId: sourceId, platformItemId: { not: null } },
    select: { id: true, platformItemId: true, metrics: true },
  });
  if (srcRecords.length > 0) {
    const tgtRecords = await tx.publishRecord.findMany({
      where: { accountId: targetId, platformItemId: { in: srcRecords.map((r) => r.platformItemId as string) } },
      select: { id: true, platformItemId: true, metrics: true },
    });
    const tgtByItem = new Map(tgtRecords.map((r) => [r.platformItemId as string, r]));
    for (const src of srcRecords) {
      const dup = tgtByItem.get(src.platformItemId as string);
      if (!dup) continue;
      await tx.performanceSnapshot.updateMany({ where: { publishId: src.id }, data: { publishId: dup.id } });
      const merged: Metrics = {
        ...parseJson<Metrics>(src.metrics, {}),
        ...parseJson<Metrics>(dup.metrics, {}),
      };
      await tx.publishRecord.update({ where: { id: dup.id }, data: { metrics: toJson(merged) } });
      await tx.publishRecord.delete({ where: { id: src.id } });
      addDropped('发布记录', 1);
    }
  }
  addMoved('发布记录', (await tx.publishRecord.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);

  // ── ② 每日账号数据：唯一键 (accountId, platform, date) ──
  // 撞上的按字段补空：目标那天没记到粉丝数、来源记到了，就把它填进去（?? 不会被 0 吞掉）。
  const srcStats = await tx.accountDailyStat.findMany({ where: { accountId: sourceId } });
  if (srcStats.length > 0) {
    const tgtStats = await tx.accountDailyStat.findMany({
      where: { accountId: targetId, date: { in: srcStats.map((r) => r.date) } },
    });
    const dayKey = (r: { platform: string; date: string }) => `${r.platform}|${r.date}`;
    const tgtByDay = new Map(tgtStats.map((r) => [dayKey(r), r]));
    for (const src of srcStats) {
      const dup = tgtByDay.get(dayKey(src));
      if (!dup) continue;
      await tx.accountDailyStat.update({
        where: { id: dup.id },
        data: {
          followers: dup.followers ?? src.followers,
          followerDelta: dup.followerDelta ?? src.followerDelta,
          views: dup.views ?? src.views,
          interactions: dup.interactions ?? src.interactions,
        },
      });
      await tx.accountDailyStat.delete({ where: { id: src.id } });
      addDropped('每日账号数据', 1);
    }
  }
  addMoved('每日账号数据', (await tx.accountDailyStat.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);

  // ── ③ 受众画像：唯一键 (accountId, platform)。撞上的取**更新时间新的那份**（画像是全量覆盖式的一份快照，不能逐字段拼）──
  const srcAudience = await tx.audienceProfile.findMany({ where: { accountId: sourceId } });
  if (srcAudience.length > 0) {
    const tgtAudience = await tx.audienceProfile.findMany({
      where: { accountId: targetId, platform: { in: srcAudience.map((r) => r.platform) } },
    });
    const tgtByPlatform = new Map(tgtAudience.map((r) => [r.platform, r]));
    for (const src of srcAudience) {
      const dup = tgtByPlatform.get(src.platform);
      if (!dup) continue;
      if (src.updatedAt > dup.updatedAt) {
        await tx.audienceProfile.update({
          where: { id: dup.id },
          data: { gender: src.gender, age: src.age, region: src.region, interest: src.interest, source: src.source },
        });
      }
      await tx.audienceProfile.delete({ where: { id: src.id } });
      addDropped('受众画像', 1);
    }
  }
  addMoved('受众画像', (await tx.audienceProfile.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);

  // ── ④ 智囊团人物卡：唯一键 (accountId, key)。同名的保留目标那张（含它自己的采纳/否决权重）──
  const srcPersonas = await tx.advisorPersona.findMany({ where: { accountId: sourceId }, select: { id: true, key: true } });
  if (srcPersonas.length > 0) {
    const tgtPersonas = await tx.advisorPersona.findMany({
      where: { accountId: targetId, key: { in: srcPersonas.map((p) => p.key) } },
      select: { key: true },
    });
    const taken = new Set(tgtPersonas.map((p) => p.key));
    const dupIds = srcPersonas.filter((p) => taken.has(p.key)).map((p) => p.id);
    if (dupIds.length > 0) {
      await tx.advisorPersona.deleteMany({ where: { id: { in: dupIds } } });
      addDropped('智囊团人物卡', dupIds.length);
    }
  }
  addMoved('智囊团人物卡', (await tx.advisorPersona.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);

  // ── ⑤ 无唯一键约束的，直接搬 ──
  addMoved('选题', (await tx.topicIdea.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('草稿', (await tx.draft.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('历史作品', (await tx.ownPost.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('素材', (await tx.material.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('长期记忆', (await tx.memoryEntry.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('复盘报告', (await tx.reviewReport.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('智囊团会话', (await tx.advisorSession.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('灵感', (await tx.inspirationItem.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('读者原声', (await tx.readerComment.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('封面与形象素材', (await tx.mediaAsset.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  addMoved('通知', (await tx.notification.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  // 群里绑定到被合并账号的会话：跟着搬，否则机器人下一句话又把内容记回一个不存在的号
  addMoved('群绑定', (await tx.botConversation.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  // 采集台账：targetId 搬，targetName 保持采集当时的快照（台账是「什么时候采了谁」的凭证，不能事后改写）
  addMoved('采集台账', (await tx.collectionRun.updateMany({ where: { scope: 'self', targetId: sourceId }, data: { targetId } })).count);
  // 定时智能体：**搬**（删账号那条路是删掉，这里不一样）。合并的语义是「这两条本来就是同一个号」，
  // 用户配好的「每天 9 点跑」不该因为合并而消失。accountId 没有外键，不搬就是每天用一个
  // 已删除的 id 去干活——**还在动的**僵尸行。
  addMoved('定时智能体', (await tx.scheduledAgent.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);
  // 排队中的浏览器任务跟着搬：合并的语义是「本来就是同一个号」，已派的活不该作废
  addMoved('浏览器任务', (await tx.browserTask.updateMany({ where: { accountId: sourceId }, data: { accountId: targetId } })).count);

  // ── ⑥ 空壳删除。人设版本历史随之而去（见函数头注释）──
  const versions = await tx.personaVersion.count({ where: { accountId: sourceId } });
  if (versions > 0) addDropped('人设版本历史', versions);
  await tx.creatorAccount.delete({ where: { id: sourceId } });

  const rows = (m: Record<string, number>) => Object.entries(m).map(([label, count]) => ({ label, count }));
  return { ok: true, sourceName: source.name, targetName: target.name, moved: rows(moved), dropped: rows(dropped) };
}

export type DeleteOutcome = { ok: true; name: string } | { ok: false; error: string };

/**
 * 彻底删除一个**已归档**的账号，连同它名下的数据。
 *
 * 只对已归档的号开放：归档 → 确认 → 删除，中间那一步是冷静期，也是「这个号确实没在用」的证据。
 *
 * 三处必须手写、不能指望外键：
 *   · MemoryEntry 的外键是 **SetNull**——直接删账号会把这个号的记忆变成「工作区共享记忆」，
 *     然后被**其它账号**的上下文召回（lib/vector/store.ts 的 `accountId = ? OR accountId IS NULL`）。
 *     删掉的号反而开始影响别人的稿子，这是最隐蔽的一种脏数据。所以记忆必须显式删掉。
 *   · Notification / InspirationItem / BotConversation / CollectionRun 都**没有外键**（各自有理由），
 *     删账号不会带走它们，要在这里逐个交代清楚。
 *   · 灵感置空而不是删：InspirationItem 的 accountId 本就是可空的「归属谁」，
 *     空 = 工作区共享。用户删的是账号，不是那些他随手存下来的念头。
 *   · 采集台账原样保留：它是「什么时候、从哪采了什么」的合规凭证，targetName 里有账号名快照，
 *     账号没了台账仍然读得懂。（用户要连台账一起清，走「数据移除申请」那条路。）
 */
export async function deleteAccount(
  tx: TxClient,
  workspaceId: string,
  accountId: string,
  confirmName: string,
): Promise<DeleteOutcome> {
  const account = await tx.creatorAccount.findFirst({ where: { id: accountId, workspaceId } });
  if (!account) return { ok: false, error: '账号不存在或不属于当前工作区' };
  if (account.status === 'active') {
    return { ok: false, error: '只有已归档的账号能删除：先归档，确认没有在用的东西，再回来删。' };
  }
  // 确认字串在服务端再校一次：前端的输入框只是提醒，真正拦住误删的是这一行
  if (confirmName.trim() !== account.name) {
    return { ok: false, error: `请完整输入账号名称「${account.name}」以确认删除` };
  }
  const total = await tx.creatorAccount.count({ where: { workspaceId } });
  if (total <= 1) return { ok: false, error: '至少保留一个账号' };

  await tx.memoryEntry.deleteMany({ where: { accountId } });
  await tx.notification.deleteMany({ where: { accountId } });
  await tx.botConversation.updateMany({ where: { accountId }, data: { accountId: null } });
  await tx.inspirationItem.updateMany({ where: { accountId }, data: { accountId: null } });
  // ReaderComment.accountId 同样没有外键（不会 Cascade、也不会 SetNull），必须显式解绑：
  // 留着指向已删账号的 id，这些评论在 `OR:[{accountId},{accountId:null}]` 的取数里
  // 一条都命中不了——不是被删了，是变成谁都看不见的僵尸行，直到 90 天保留期到才消失。
  await tx.readerComment.updateMany({ where: { accountId }, data: { accountId: null } });
  // MediaAsset.accountId 同理没有外键：留着指向已删账号的 id，这些图在「本账号的形象库」里
  // 一张都查不到，却仍占着工作区配额——不是删了，是变成谁都看不见还占地方的僵尸行。
  // 解绑而不是删：形象库是工作区级的素材，用户删的是账号不是他存的那些照片。
  await tx.mediaAsset.updateMany({ where: { accountId }, data: { accountId: null } });
  // 定时智能体：**删掉，不解绑**。它的语义是「按时替这个账号干活」，账号没了它就没有意义了；
  // 而 accountId 同样没有外键，留着的话 worker 每天照常把它捡起来跑，
  // 用一个已删除的账号 id 去建草稿/发布计划——不是僵尸行，是**还在动的**僵尸。
  await tx.scheduledAgent.deleteMany({ where: { accountId } });
  // 浏览器任务：accountId 同样没有外键。留着的话插件下次醒来会领到一个
  // 「去这个已删除账号的后台回填」的活——同 ScheduledAgent，是**还在动的**僵尸
  await tx.browserTask.deleteMany({ where: { accountId } });
  // 其余（选题/草稿/发布记录/作品/日数据/画像/素材/复盘/智囊团/人设版本）由外键 Cascade 带走
  await tx.creatorAccount.delete({ where: { id: accountId } });

  return { ok: true, name: account.name };
}

/** 供 UI 之外的调用方（脚本/测试）用裸 prisma 走同一份逻辑 */
export const asTx = () => prisma as unknown as TxClient;
