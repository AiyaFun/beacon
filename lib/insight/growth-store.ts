import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';
import { beijingDayKey } from '../beijing';

// 竞对账号级逐日快照的落库层（CompetitorDailyStat）。
// 作品级已有 PostMetricSnapshot，账号级此前一片空白——CompetitorAccount.followers 是覆盖写的
// 单值，采一次盖一次，「这个竞对这周涨了多少粉」在库里无从查起。

/**
 * 逻辑日（YYYY-MM-DD，按 **Asia/Shanghai**）。
 *
 * ⚠️ 必须显式指定时区：worker/web 容器跑在 UTC 上，直接 toISOString().slice(0,10) 会让
 * 每天 08:00 之前的采集全部记到「昨天」——用户看到的曲线会整体错位一天，而且这种错位
 * 只在早上出现，最难复现。（同一个坑在 cron 上踩过，见 lib/jobs 的 tz 说明。）
 */
export function logicalDateCN(d: Date): string {
  // 口径收在 lib/beijing.ts（同一份偏移供配额窗口/展示/导出共用）；
  // tests/time/beijing.test.ts 拿 Intl 的 Asia/Shanghai 逐时对过账，两者恒等。
  return beijingDayKey(d);
}

/** 汇总一批作品的指标。**只累加真的采到的键**，一条都没有的键返回 null 而不是 0。 */
export function sumMetrics(list: Metrics[]): {
  totalViews: number | null;
  totalLikes: number | null;
  totalComments: number | null;
} {
  let v: number | null = null, l: number | null = null, c: number | null = null;
  for (const m of list) {
    if (typeof m.views === 'number' && Number.isFinite(m.views)) v = (v ?? 0) + m.views;
    if (typeof m.likes === 'number' && Number.isFinite(m.likes)) l = (l ?? 0) + m.likes;
    if (typeof m.comments === 'number' && Number.isFinite(m.comments)) c = (c ?? 0) + m.comments;
  }
  return { totalViews: v, totalLikes: l, totalComments: c };
}

/**
 * 记一条竞对账号的当日快照。同一竞对同一天多次采集 → upsert 覆盖成当天最后一次观测
 * （与 AccountDailyStat 同口径，不堆历史垃圾）。
 *
 * followers 采不到时写 null，**绝不写 0 冒充**：0 粉丝和没采到在曲线上是天壤之别。
 * 整个函数吞掉自身异常——账号级快照是锦上添花，绝不能因为它让整批采集回滚。
 */
export async function recordCompetitorDaily(competitorId: string, now: Date = new Date()): Promise<void> {
  try {
    const comp = await prisma.competitorAccount.findUnique({
      where: { id: competitorId },
      select: { followers: true },
    });
    if (!comp) return;

    const posts = await prisma.crawledPost.findMany({
      where: { competitorId },
      select: { metrics: true },
    });
    const totals = sumMetrics(posts.map((p) => parseJson<Metrics>(p.metrics, {})));

    // followers 在表上是 Int @default(0)，0 既可能是真的零粉、也可能是从没采到。
    // 分不清的时候按「没采到」处理：写进曲线的假 0 会造出一次凭空的涨跌。
    const followers = comp.followers > 0 ? comp.followers : null;
    const date = logicalDateCN(now);

    const data = {
      followers,
      posts: posts.length,
      totalViews: totals.totalViews,
      totalLikes: totals.totalLikes,
      totalComments: totals.totalComments,
    };
    await prisma.competitorDailyStat.upsert({
      where: { competitorId_date: { competitorId, date } },
      create: { competitorId, date, ...data },
      // 同日重复采集：用后一次覆盖，但**不拿 null 盖掉已有的真值**
      // （某次采集漏读粉丝数，不该把当天已经记下的数字抹成空）
      update: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)),
    });
  } catch {
    /* 账号级快照失败不影响这批采集本身 */
  }
}
