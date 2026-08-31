import { parseJson, type Metrics } from '../json';
import { platformName } from '../constants';
import { logicalDay } from './timeseries';
import { sourceTier, SOURCE_TIER_LABEL } from './source-tier';
import { pickAuthoritativeSnapshot } from './source-priority';
import { beijingDayKey } from '../beijing';
import { buildCsv } from '../csv';

// 数据导出（纯函数）。CSV 带 UTF-8 BOM 供 Excel 直接双开不乱码；字段做转义。
// 两种粒度：发布明细（每篇一行）、逐日快照（每篇×每逻辑日一行，含来源）。

// 转义与拼装住在 lib/csv.ts（零依赖，客户端组件也要用；且那里补了公式注入的处置）。
// 这里 re-export，既有 `from './csv'` 的引用不必改。
export { buildCsv, escapeCell } from '../csv';

// 来源分档口径住在 source-tier.ts（零依赖，避免 timeseries ↔ csv 循环导入）。
// 这里 re-export，既有 `from './csv'` 的引用不必改。
export { sourceTier, SOURCE_TIER_LABEL, type SourceTier } from './source-tier';

export type CsvRecord = {
  platform: string;
  title: string | null;
  /** 可空：插件从某些页面回填时采不到发布时间，如实留空而不是写成回填当天 */
  publishedAt: Date | null;
  fromRecommend: boolean;
  metrics: string;
  snapshots: { takenAt: Date; metrics: string; source: string | null; milestone: string | null }[];
};

// 导出的日期与页面上看到的必须是同一天：一律北京时间的逻辑日（见 lib/beijing.ts）。
// 用 toISOString() 切出来的是 UTC 日，早上八点前发的作品会被导成前一天，
// 用户拿这份 CSV 跟平台后台对账时对不上，而且只在早上对不上。
function fmtDate(d: Date | null): string {
  // 【拿不到就写「未记录」，不写空】空格子在 Excel 里会被读成「这天是空的」，
  // 而事实是「我们不知道是哪天」——与竞对榜单导出同一条口径
  return d ? beijingDayKey(d) : '未记录';
}

const M = (m: Metrics) => [m.views ?? 0, m.likes ?? 0, m.comments ?? 0, m.shares ?? 0, m.collects ?? 0, m.completion ?? ''];

// 发布明细：每篇一行，取值与全站结论口径一致（来源优先级：官方>插件>手填，同一逻辑日内比较）。
// 导出的数字必须与 /data 页面上看到的一致——两份对不上时用户只会认为产品在乱报数。
// 「数据出处」列标的是**被采用的那条快照**的来源，不是最新一条，否则会出现
// 「数字是官方的、出处写着手填」的自相矛盾。
export function publishCsv(records: CsvRecord[]): string {
  const headers = ['平台', '标题', '发布日期', '选题来源', '播放', '点赞', '评论', '转发', '收藏', '完播率', '数据出处'];
  const rows = records.map((r) => {
    const picked = pickAuthoritativeSnapshot(r.snapshots, r.publishedAt);
    const m = parseJson<Metrics>(picked ? picked.metrics : r.metrics, {});
    // 全部快照都没有指标时（值来自 record.metrics 回落），标最后写入者的来源——
    // 明知是适配器写的却标「手填」是另一种失真
    const latest = [...r.snapshots].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
    return [
      platformName(r.platform),
      r.title ?? '',
      fmtDate(r.publishedAt),
      r.fromRecommend ? 'AI推荐' : '自选',
      ...M(m),
      SOURCE_TIER_LABEL[sourceTier(picked?.source ?? latest?.source ?? 'manual')],
    ];
  });
  return buildCsv(headers, rows);
}

// 逐日快照：每篇×每逻辑日一行（AI 分析/自建报表的原料）
export function snapshotCsv(records: CsvRecord[]): string {
  const headers = ['平台', '标题', '发布日期', '逻辑日', '来源', '里程碑', '播放', '点赞', '评论', '转发', '收藏', '完播率'];
  const rows: (string | number)[][] = [];
  for (const r of records) {
    const sorted = [...r.snapshots].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
    for (const s of sorted) {
      const m = parseJson<Metrics>(s.metrics, {});
      rows.push([
        platformName(r.platform),
        r.title ?? '',
        fmtDate(r.publishedAt),
        `D+${logicalDay(r.publishedAt, s.takenAt, s.milestone)}`,
        SOURCE_TIER_LABEL[sourceTier(s.source)],
        s.milestone ?? '',
        ...M(m),
      ]);
    }
  }
  return buildCsv(headers, rows);
}
