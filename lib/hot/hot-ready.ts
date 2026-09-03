import { prisma } from '../db';
import { pushEvent, beaconUrl } from '../bot';

// 「热点刷新」推送（PUSH_EVENTS.hot_ready）。
//
// 这个事件在设置页能勾很久了，但从来没有发射点——勾了的用户一条也收不到（2026-09-03 盘查抓到）。
// 接在 cluster_topics 之后：本轮**新建**的聚类里挑热度最高的几条推给订阅了的工作区。
//
// 节流是刻意的：聚类每 30 分钟跑一次，不节流就是每半小时一条群消息，等于教用户把它关掉。
// 同一工作区两小时内只推一次；进程内记时（worker 单进程），重启后最多多推一次。
const MAX_ITEMS = 5;
const THROTTLE_MS = 2 * 3600_000;
const lastPushAt = new Map<string, number>();

export async function pushHotReady(since: Date, now = Date.now()): Promise<{ workspaces: number; items: number }> {
  const fresh = await prisma.topicCluster.findMany({
    where: { createdAt: { gte: since }, isSensitive: false },
    orderBy: { heat: 'desc' },
    take: MAX_ITEMS,
    select: { id: true, title: true, heat: true, category: true },
  });
  if (fresh.length === 0) return { workspaces: 0, items: 0 };

  // 只找订阅了这个事件的工作区（pushEvents 是 JSON 字符串，contains 足够；pushEvent 内部还会再判一次）
  const subs = await prisma.botIntegration.findMany({
    where: { enabled: true, pushEvents: { contains: 'hot_ready' } },
    select: { workspaceId: true },
    distinct: ['workspaceId'],
  });
  let sent = 0;
  for (const { workspaceId } of subs) {
    const last = lastPushAt.get(workspaceId) ?? 0;
    if (now - last < THROTTLE_MS) continue;
    const r = await pushEvent(workspaceId, 'hot_ready', {
      kind: 'card',
      title: `🔥 新上榜热点 ${fresh.length} 条`,
      lines: fresh.map((c, i) => `${i + 1}. ${c.title}`),
      link: { text: '去热点页看', url: beaconUrl('/hot') },
    });
    if (r.sent > 0) {
      lastPushAt.set(workspaceId, now);
      sent++;
    }
  }
  return { workspaces: sent, items: fresh.length };
}

/** 测试用 */
export function __resetHotReadyThrottle(): void {
  lastPushAt.clear();
}
