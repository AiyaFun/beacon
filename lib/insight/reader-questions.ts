import { prisma } from '../db';
import { parseJson } from '../json';
import { canonicalRemovalHandle } from '../legal/removal';

// 「这条作品下，读者在问什么」——评论采集（InspirationItem source='comment'）与
// 作品表现数据的第一处结合点：指标说效果如何，提问说读者为什么/还想要什么。
//
// 连接键就是 askedBreak 的 workKey = platformItemId（插件在作品页采集时由 __beaconParse 带回，
// 见 extension/content/comments.js），与 PublishRecord.platformItemId 同一个值。
// askedBreak 是 JSON string {workKey: count}，做不了 SQL join——应用层解析。
// 量级无压力：评论提问有 pruneInspiration 分源配额 + 90 天 stale 归档，全量也就几十行。
//
// 两条口径，错了会指鹿为马：
//   · key 必须带平台前缀（`${platform}:${workKey}`）——B站 BV 号和抖音数字 ID 形态不同
//     撞不上，但「形态碰巧相同」不是可以赌的事（不透明 ID 的教训见 lib/legal/removal.ts）。
//   · `sha:` 开头（标题哈希）与 'unknown' 的 workKey 跳过——它们对不上任何 platformItemId，
//     硬塞进某条作品就是张冠李戴。这些提问仍在灵感箱/选题候选里，只是不做逐作品归属。

export type ReaderQuestion = {
  text: string;
  // 在**这条作品**下被问到的次数（askedBreak[workKey]），不是跨作品总数——
  // 「这条作品的读者在问」用总数会把别的作品下的热度算到这条头上。
  count: number;
};

export function groupQuestionsByWork(
  items: { title: string; platform: string | null; askedBreak: string }[],
): Map<string, ReaderQuestion[]> {
  const byWork = new Map<string, ReaderQuestion[]>();
  for (const it of items) {
    if (!it.platform) continue;
    const brk = parseJson<Record<string, number>>(it.askedBreak, {});
    for (const [workKey, count] of Object.entries(brk)) {
      if (workKey === 'unknown' || workKey.startsWith('sha:')) continue;
      if (typeof count !== 'number' || !(count > 0)) continue;
      const key = `${it.platform}:${workKey}`;
      const list = byWork.get(key);
      if (list) list.push({ text: it.title, count });
      else byWork.set(key, [{ text: it.title, count }]);
    }
  }
  for (const list of byWork.values()) list.sort((a, b) => b.count - a.count);
  return byWork;
}

// 某个竞对名下的读者提问（source='rival-comment'，author=作品作者 handle）——
// 竞对拆解的「读者反馈缺口」证据：评论区反复在问、而竞对没接住的，就是你的切入机会。
//
// handle 匹配口径：author 是插件按页面原样存的（可能带 @、任意大小写），竞对库的 handle
// 是添加时的形态——两侧都过 canonicalRemovalHandle 归一后比较，口径与「被监控账号申请
// 移除」同一份（两处对 handle 的理解不一致会各错各的；不透明 ID 平台原样精确比，
// 「不透明 ID 不许转小写」的红线见 lib/legal/removal.ts）。任意大小写没法展开成有限
// 变体列表进 `in` 查询，所以取该平台全量后应用层过滤——rival-comment 有分源配额，
// 全量就几十行。
export type RivalQuestion = {
  text: string;
  // 跨作品累计被问次数 + 出现在几条作品下——「三条作品下都在问」比「一条下问了五次」强
  count: number;
  works: number;
};

export async function rivalReaderQuestions(
  workspaceId: string,
  platform: string,
  handle: string,
  take = 8,
): Promise<RivalQuestion[]> {
  const want = canonicalRemovalHandle(platform, handle);
  if (!want) return [];
  const rows = await prisma.inspirationItem.findMany({
    where: {
      workspaceId,
      source: 'rival-comment',
      state: { in: ['open', 'used'] },
      platform,
    },
    orderBy: [{ askedCount: 'desc' }],
    select: { title: true, askedCount: true, askedWorks: true, author: true },
  });
  return rows
    .filter((r) => canonicalRemovalHandle(platform, r.author ?? '') === want)
    .slice(0, take)
    .map((r) => ({ text: r.title, count: r.askedCount, works: r.askedWorks }));
}

// 本账号自有作品的读者提问。accountId 为空的行也取：插件回传时可能没有账号上下文
//（InspirationItem.accountId 的既有语义：空 = 工作区共享，见 prisma/schema.prisma）。
// 只取 source='comment'（自有评论）——rival-comment 是竞对作品下的提问，
// 挂到自有作品行上就是把别人的读者当成你的。
export async function readerQuestionsByWork(
  workspaceId: string,
  accountId: string,
): Promise<Map<string, ReaderQuestion[]>> {
  const rows = await prisma.inspirationItem.findMany({
    where: {
      workspaceId,
      source: 'comment',
      // used（已转选题）也展示：提问被采纳不代表它从这条作品下消失了；archived 是用户
      // 主动收起或 90 天未再被问，不再打扰。
      state: { in: ['open', 'used'] },
      OR: [{ accountId }, { accountId: null }],
    },
    select: { title: true, platform: true, askedBreak: true },
  });
  return groupQuestionsByWork(rows);
}
