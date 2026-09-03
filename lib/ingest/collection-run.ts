import { prisma } from '../db';
import { log } from '../logger';

// 采集台账 —— 每一次抓取覆盖了哪段时间。
//
// 所有采集通道都只取「最近一小段」，而页面上只显示「库里有 N 篇」。中间缺的那句话是
// **「这一批是哪几天的内容」**：没有它，用户既判断不了数据全不全，也不知道补历史该从哪天补。
// 写台账的口径只有一条：**记录已经发生的事实**（这次收到了什么、覆盖到哪天），不做推断。

export type CollectionScope = 'self' | 'rival';

/** 采集通道。谁在采、在哪采——同一批数据的可信度与频率约束都由它决定 */
export type CollectionChannel = 'plugin_home' | 'plugin_backend' | 'local_browser' | 'desktop' | 'server' | 'import' | 'manual';

export const CHANNEL_LABEL: Record<CollectionChannel, string> = {
  plugin_home: '插件·主页',
  plugin_backend: '插件·后台',
  // 没装插件时由整机版/桌面端驱动本机 Chrome 采的（lib/browser/local-collect.ts）。
  // 单列一档：它与插件同一套解析器，但触发方式不同，台账上要分得清
  local_browser: '本机浏览器',
  desktop: '桌面客户端执行器',
  server: '服务端定时',
  import: '文件导入',
  manual: '页面手动',
};

export const SCOPE_LABEL: Record<CollectionScope, string> = {
  self: '自有账号',
  rival: '竞对账号',
};

/** 一批内容的发布时间跨度。全批都没有发布时间时两端都为 null（如只回传了指标的批次） */
export function coveredRange(dates: (Date | null | undefined)[]): { from: Date | null; to: Date | null } {
  const ts = dates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime())).map((d) => d.getTime());
  if (ts.length === 0) return { from: null, to: null };
  return { from: new Date(Math.min(...ts)), to: new Date(Math.max(...ts)) };
}

export type CollectionRunInput = {
  workspaceId: string;
  scope: CollectionScope;
  platform: string;
  targetId?: string | null;
  targetName: string;
  channel: CollectionChannel;
  /** 本批内容的发布时间（作品）或逻辑日（账号级日数据），用来算覆盖区间 */
  dates?: (Date | null | undefined)[];
  coveredFrom?: Date | null;
  coveredTo?: Date | null;
  items: number;
  created?: number;
  updated?: number;
  note?: string | null;
};

/**
 * 落一条台账。
 *
 * **绝不抛错**：台账是旁路记录，写失败不能连累正在入库的真实数据——用户宁可丢一行日志，
 * 也不能因为日志表写不进去而丢一次采集。
 *
 * 空批次的取舍：`server` 通道由 cron 每 2 小时对每个订阅竞对跑一轮，多数轮次什么都没采到
 * （平台没有服务端通道）。这些空转全记下来，台账会被几十行「0 条」淹掉，真正采到东西的那几行
 * 反而找不着。所以**服务端空批次不记**；用户自己点出来的（manual/import/插件回传）一律记，
 * 哪怕是 0 条——那是他刚做过的动作，必须给回音。
 */
export async function recordCollectionRun(input: CollectionRunInput): Promise<void> {
  if (input.items === 0 && input.channel === 'server') return;
  const range =
    input.coveredFrom !== undefined || input.coveredTo !== undefined
      ? { from: input.coveredFrom ?? null, to: input.coveredTo ?? null }
      : coveredRange(input.dates ?? []);
  try {
    await prisma.collectionRun.create({
      data: {
        workspaceId: input.workspaceId,
        scope: input.scope,
        platform: input.platform,
        targetId: input.targetId ?? null,
        targetName: input.targetName.slice(0, 100),
        channel: input.channel,
        coveredFrom: range.from,
        coveredTo: range.to,
        items: input.items,
        created: input.created ?? 0,
        updated: input.updated ?? 0,
        note: input.note ? input.note.slice(0, 300) : null,
      },
    });
  } catch (e) {
    log.warn('采集台账写入失败（不影响本次入库）', { error: (e as Error).message });
  }
}

export type CollectionRunRow = {
  id: string;
  scope: string;
  platform: string;
  targetId: string | null;
  targetName: string;
  channel: string;
  ranAt: Date;
  coveredFrom: Date | null;
  coveredTo: Date | null;
  items: number;
  created: number;
  updated: number;
  note: string | null;
};

/** 台账查询。scope 省略 = 两类都要 */
export async function listCollectionRuns(
  workspaceId: string,
  opts: { scope?: CollectionScope; targetId?: string; take?: number } = {},
): Promise<CollectionRunRow[]> {
  return prisma.collectionRun.findMany({
    where: {
      workspaceId,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.targetId ? { targetId: opts.targetId } : {}),
    },
    orderBy: { ranAt: 'desc' },
    take: opts.take ?? 20,
    select: {
      id: true, scope: true, platform: true, targetId: true, targetName: true, channel: true,
      ranAt: true, coveredFrom: true, coveredTo: true, items: true, created: true, updated: true, note: true,
    },
  });
}
