// 高热榜单的取数 / 筛选 / 排序（纯函数，2026-08-30 从 CompetitorTopPosts.tsx 抽出来）。
//
// ── 为什么要抽 ──
// 原来这三段是 CompetitorTopPosts() 里的三个 useMemo，而那个函数一共 1121 行。
// 榜单上「谁排前面、谁被滤掉、哪个数显示成什么」全部由这里决定，
// 却因为困在闭包里**一行覆盖都没有**——而这个项目在榜单口径上栽过不止一次
//（hotScore 让无播放量平台恒为 0、缺席被印成 0、率型列串台）。
import { parseJson, engagementRate, type Metrics } from '@/lib/json';
import { heatForSort } from '@/lib/insight/heat';

export type TimeRangeKey = 'all' | '24h' | '7d' | '30d';
export type SortKey = 'interaction' | 'views' | 'engagement' | 'growth';

export type RawPost = {
  id: string;
  title: string;
  metrics: string;
  publishedAt: Date | string | null;
  competitor: { name: string };
};

export type SnapItem = { metrics: string };

/** 时间窗上限（小时）。'all' 不设限。 */
const WINDOW_HOURS: Record<Exclude<TimeRangeKey, 'all'>, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

/**
 * 这条作品发出来多久了（小时）。**没有发布时间就是 null，不是一个很大的数。**
 *
 * ── 修掉的缺陷（2026-08-30）──
 * 原来写的是 `pubTime > 0 ? Math.max(1, …) : 9999`。9999 小时 ≈ 416 天，
 * 于是「发布时间没采到」被静默改写成「很久很久以前」，紧接着时间筛选拿它做判断：
 * 这条作品在 24h / 7d / 30d **三个窗口下全部被滤掉**，只有「全部」才看得见。
 * 用户切一下时间窗就发现少了几条，而界面上没有任何东西解释这件事。
 *
 * 这正是本项目反复裁定过的那条口径的镜像——**缺席不许当成一个确定值**
 *（见 lib/insight/platform-metrics.ts 与「缺席不许当成0」那次）。上次是印成 0，
 * 这次是印成「很旧」。而一行之隔的排序里，`rate` 早就按 `?? -1` 处理并写明了理由，
 * 说明这是漏掉的，不是设计。
 */
export function ageHoursOf(publishedAt: Date | string | null, now: number): number | null {
  if (!publishedAt) return null;
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.max(1, (now - t) / 3_600_000);
}

/**
 * 落在这个时间窗里吗。
 *
 * 【发布时间不知道的怎么办】不进任何有界窗口，只在「全部」里出现。
 * 理由：「近 24 小时」问的是「这 24 小时里发的」，而这条我们并不知道它是不是。
 * 把不知道的塞进去，等于替用户断言了一件我们没有依据的事。
 * **这是一个明写出来的取舍，不是算术的副产品**——原来它是后者。
 */
export function inWindow(ageHours: number | null, range: TimeRangeKey): boolean {
  if (range === 'all') return true;
  if (ageHours === null) return false;
  return ageHours <= WINDOW_HOURS[range];
}

export type AnalyzedPost<P extends RawPost> = P & {
  cleanTitle: string;
  m: Metrics;
  views: number; likes: number; comments: number; collects: number; shares: number;
  coins: number; danmaku: number;
  /** 互动率。算不出来（没有播放量这个分母）就是 null，绝不是 0。 */
  rate: number | null;
  /** 排序口径：互动量（赞+评+藏+转）。每个平台至少拿得到点赞，不像 hotScore 那样恒为 0。 */
  interaction: number;
  growthDelta: number;
  ageHours: number | null;
};

/** 逐条算出展示所需的量。 */
export function analyzePosts<P extends RawPost>(
  posts: readonly P[],
  snapsByPost: Record<string, SnapItem[] | undefined>,
  now: number,
): AnalyzedPost<P>[] {
  return posts.map((p) => {
    const m = parseJson<Metrics>(p.metrics, {});
    const snaps = snapsByPost[p.id] ?? [];
    let growthDelta = 0;
    if (snaps.length >= 2) {
      const last = parseJson<Metrics>(snaps[snaps.length - 1].metrics, {});
      const prev = parseJson<Metrics>(snaps[snaps.length - 2].metrics, {});
      growthDelta = (last.views ?? 0) - (prev.views ?? 0);
    }
    return {
      ...p,
      // 标题前面平台自带的【xx】角标去掉，榜上一列全是它没有信息量
      cleanTitle: p.title.replace(/^【[^】]+】\s*/, ''),
      m,
      views: m.views ?? 0,
      likes: m.likes ?? 0,
      comments: m.comments ?? 0,
      collects: m.collects ?? 0,
      shares: m.shares ?? 0,
      coins: m.coins ?? 0,
      danmaku: m.danmaku ?? 0,
      rate: engagementRate(m),
      interaction: heatForSort(m),
      growthDelta,
      ageHours: ageHoursOf(p.publishedAt, now),
    };
  });
}

/** 时间窗 + 搜索。搜索同时匹配标题与账号名。 */
export function filterPosts<T extends { cleanTitle: string; competitor: { name: string }; ageHours: number | null }>(
  posts: readonly T[],
  range: TimeRangeKey,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  return posts.filter((p) => {
    if (!inWindow(p.ageHours, range)) return false;
    if (!q) return true;
    return p.cleanTitle.toLowerCase().includes(q) || p.competitor.name.toLowerCase().includes(q);
  });
}

/**
 * 排序。
 *
 * 【互动率那条为什么是 `?? -1`】算不出来的排最后，而不是当成 0 混进「互动率最低」
 * 那一堆里——那会让用户以为抖音这些作品互动垫底，其实只是没有播放量这个分母。
 */
export function sortPosts<T extends { views: number; rate: number | null; growthDelta: number; interaction: number }>(
  posts: readonly T[],
  by: SortKey,
): T[] {
  return [...posts].sort((a, b) => {
    if (by === 'views') return b.views - a.views;
    if (by === 'engagement') return (b.rate ?? -1) - (a.rate ?? -1);
    if (by === 'growth') return b.growthDelta - a.growthDelta;
    return b.interaction - a.interaction;
  });
}
