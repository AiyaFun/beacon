// 数据来源分档 + 可信度排名。**零依赖**——这是本文件存在的全部理由。
//
// 分档口径此前住在 csv.ts，而 csv.ts 依赖 timeseries.ts（logicalDay）。当 timeseries.ts
// 也需要按来源可信度选点时，就形成 timeseries → csv → timeseries 的循环导入。
// 把这组常量单独拎出来，让 csv / timeseries / source-priority 三边都只依赖它，环就断了。
// csv.ts 仍 re-export 这两个符号，既有引用不必改。

export type SourceTier = 'official' | 'plugin' | 'manual';

/** 来源分档：官方 API / 插件 / 手填（供导出、UI badge、下结论选点共用同一口径）。 */
export function sourceTier(source: string | null | undefined): SourceTier {
  if (!source || source === 'manual') return 'manual';
  if (source === 'plugin') return 'plugin';
  return 'official'; // wechat-datacube / tikhub / youtube-official / …
}

export const SOURCE_TIER_LABEL: Record<SourceTier, string> = {
  official: '官方',
  plugin: '插件',
  manual: '手填',
};

// 可信度排名（越大越可信）：官方 > 插件 > 手填。
// 未知/空来源一律按最保守的「手填」处理——认不出来源就不该享受高可信待遇。
const TIER_RANK: Record<SourceTier, number> = {
  official: 3,
  plugin: 2,
  manual: 1,
};

export function sourceRank(source: string | null | undefined): number {
  return TIER_RANK[sourceTier(source)];
}
