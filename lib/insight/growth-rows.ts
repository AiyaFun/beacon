import { prisma } from '@/lib/db';
import { parseJson, hasViews, type Metrics } from '@/lib/json';
import { growthOverWindow, windowRange, isApproximate, type Observation, type WindowKey } from '@/lib/insight/growth';
import type { GrowthRow } from '@/components/GrowthBoard';
import { beijingDayKey } from '../beijing';

// 增长追踪的取数。**没有独立页面**，分别长在两个页面里（用户 2026-08-10 两次定调）：
//   · 自有增长 → 数据看板 /data（loadSelfGrowth）
//   · 竞对增长 → 竞对监控 /competitors（loadRivalGrowth）
// 各页只管自己的域，不并排 —— 所以下面是两个独立入口，别再合成一个「全都取」的函数。
//
// 与各页原有内容的分工：它们答「现在是多少」，这里答「这段时间涨了多少、什么时候涨的」。
//
// 取数口径三条（与 lib/insight/growth.ts 的纪律一致，这里是它的调用现场）：
//   ① 基准点取窗口开始**之前**最近的一次观测，所以查快照时要往前多取一段，不能只查窗口内；
//   ② 平台没有播放量（抖音/小红书公开页）时主轴自动换成点赞——摆一列「播放 —」没有意义；
//   ③ 算不出来的项不产出数字，由 GrowthBoard 画占位并说明原因。

export const WINDOW_KEYS: WindowKey[] = ['24h', '7d', '30d'];

/** 主轴指标：有播放量就看播放，没有就看点赞（抖音/小红书这类平台公开页不给播放量）。 */
function pickPrimary(samples: Metrics[]): { key: string; label: string } {
  return samples.some((m) => hasViews(m)) ? { key: 'views', label: '播放' } : { key: 'likes', label: '点赞' };
}

function toRow(
  base: { id: string; name: string; platform: string; scope: 'self' | 'rival' },
  observations: Observation[],
  from: Date,
  to: Date,
): GrowthRow {
  const g = growthOverWindow(observations, from, to);
  const primary = pickPrimary(observations.map((o) => o.metrics));
  return {
    ...base,
    delta: g.delta as Record<string, number>,
    baseline: (g.baseline?.metrics ?? {}) as Record<string, number>,
    status: g.status,
    partial: g.baselineInsideWindow,
    unavailable: g.unavailable,
    points: g.points.map((p) => ({
      at: p.at.toISOString(),
      value: (p.metrics as Record<string, number | undefined>)[primary.key] ?? null,
    })),
    primaryKey: primary.key,
    primaryLabel: primary.label,
    // 平台只给约数、且量级已进入「万/亿」缩写区间时标注：那时的「+0」可能只是变化没到展示精度
    approximate: isApproximate(
      base.platform,
      observations.map((o) => (o.metrics as Record<string, number | undefined>)[primary.key]),
    ),
  };
}

// AccountDailyStat / CompetitorDailyStat 的 date 是 'YYYY-MM-DD' 逻辑日（Asia/Shanghai）。
// 折回 Date 时按当天 12:00 北京时间取中点：用 00:00 会让当天的点在按 UTC 比较时落到前一天，
// 与窗口边界擦肩而过；取中点对 24h/7d/30d 这种粒度足够稳。
function dayToDate(day: string): Date {
  return new Date(`${day}T12:00:00+08:00`);
}

function dateKey(d: Date): string {
  return beijingDayKey(d); // 口径同 lib/beijing.ts（与 logicalDateCN 恒等）
}

/** 账号级主轴固定看粉丝：这一行答的是「涨没涨粉」，不是「播放涨没涨」。 */
function useFollowersAsPrimary(row: GrowthRow, obs: Observation[], from: Date, to: Date): void {
  if (!obs.some((o) => o.metrics.followers != null)) return;
  row.primaryKey = 'followers';
  row.primaryLabel = '粉丝';
  row.points = growthOverWindow(obs, from, to).points.map((p) => ({
    at: p.at.toISOString(),
    value: (p.metrics as Record<string, number | undefined>).followers ?? null,
  }));
}

/** 往前多取 60 天：基准点要落在窗口**之前**，只查窗口内会漏掉基准，
 *  把「区间增长」退化成「窗口内首末之差」（系统性低估，见 growth.ts 的说明）。 */
function rangeOf(windowKey: WindowKey) {
  const { from, to } = windowRange(windowKey, new Date());
  return { from, to, lookback: new Date(from.getTime() - 60 * 86_400_000) };
}

export type GrowthData = { rows: GrowthRow[]; hasAny: boolean };

/** 竞对增长（竞对监控页用）：只有竞对账号级，不掺自有。 */
export async function loadRivalGrowth(workspaceId: string, windowKey: WindowKey): Promise<GrowthData> {
  const { from, to, lookback } = rangeOf(windowKey);
  const watchlist = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    select: {
      competitor: {
        select: {
          id: true, name: true, platform: true,
          dailyStats: { where: { date: { gte: dateKey(lookback) } }, orderBy: { date: 'asc' } },
        },
      },
    },
  });

  const rows: GrowthRow[] = [];
  for (const w of watchlist) {
    const c = w.competitor;
    if (!c) continue;
    const obs: Observation[] = c.dailyStats.map((st) => ({
      at: dayToDate(st.date),
      metrics: {
        ...(st.followers != null ? { followers: st.followers } : {}),
        ...(st.totalViews != null ? { views: st.totalViews } : {}),
        ...(st.totalLikes != null ? { likes: st.totalLikes } : {}),
        ...(st.totalComments != null ? { comments: st.totalComments } : {}),
      },
    }));
    const row = toRow({ id: c.id, name: c.name, platform: c.platform, scope: 'rival' }, obs, from, to);
    useFollowersAsPrimary(row, obs, from, to);
    rows.push(row);
  }
  return { rows, hasAny: rows.some((r) => r.status !== 'no-data') };
}

/** 自有增长（数据看板用）：账号级涨粉在前，单条作品在后。 */
export async function loadSelfGrowth(accountId: string, windowKey: WindowKey): Promise<GrowthData> {
  const { from, to, lookback } = rangeOf(windowKey);
  const [records, accountDaily] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId },
      select: {
        id: true, title: true, platform: true,
        snapshots: { where: { takenAt: { gte: lookback, lte: to } }, orderBy: { takenAt: 'asc' }, select: { takenAt: true, metrics: true } },
      },
    }),
    prisma.accountDailyStat.findMany({
      where: { accountId, date: { gte: dateKey(lookback) } },
      orderBy: { date: 'asc' },
    }),
  ]);

  const rows: GrowthRow[] = [];

  // ── 账号级（涨粉）──
  const byPlatform = new Map<string, typeof accountDaily>();
  for (const st of accountDaily) {
    if (!byPlatform.has(st.platform)) byPlatform.set(st.platform, []);
    byPlatform.get(st.platform)!.push(st);
  }
  for (const [platform, list] of byPlatform) {
    const obs: Observation[] = list.map((st) => ({
      at: dayToDate(st.date),
      metrics: {
        ...(st.followers != null ? { followers: st.followers } : {}),
        ...(st.views != null ? { views: st.views } : {}),
      },
    }));
    const row = toRow({ id: `self-acc-${platform}`, name: '我的账号', platform, scope: 'self' }, obs, from, to);
    useFollowersAsPrimary(row, obs, from, to);
    rows.push(row);
  }

  // ── 作品级 ──
  for (const r of records) {
    if (r.snapshots.length === 0) continue;
    const obs: Observation[] = r.snapshots.map((sn) => ({
      at: sn.takenAt,
      metrics: parseJson<Metrics>(sn.metrics, {}),
    }));
    const row = toRow({ id: r.id, name: r.title || '(无标题)', platform: r.platform, scope: 'self' }, obs, from, to);
    if (row.status !== 'no-data') rows.push(row);
  }

  return { rows, hasAny: rows.some((r) => r.status !== 'no-data') };
}
