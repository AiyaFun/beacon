// SQLite 下 JSON/数组字段以 String 存储，统一在此序列化/反序列化

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export type Metrics = {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  collects?: number;
  danmaku?: number; // B站弹幕数
  coins?: number; // B站投币数
  completion?: number; // 完播率 0-1
  // ── 以下两项只有创作者后台给得到（公开作品页没有），来自插件自有数据回填 ──
  impressions?: number; // 曝光量/展现量。**不是播放**：混进 views 会凭空拔高分母、压低所有互动率
  sources?: Record<string, number>; // 流量来源分布，值为占比 0-1（如 {推荐:0.6, 搜索:0.2}）
};

// 数值型计数键。凡是「按指标键取值」「让用户切换看哪个指标」的地方都用它，
// 不要用 keyof Metrics —— 后者含 sources（嵌套对象）与 completion（率），
// 混进去会让 m[key] 的类型退化成联合类型，取值/格式化全要加断言。
export type MetricCountKey = 'views' | 'likes' | 'comments' | 'shares' | 'collects' | 'danmaku' | 'coins' | 'impressions';

// 曝光点击率：播放/曝光。YouTube 的第一信号之一，此前只能在文案里说「无法从播放数反推」。
// 两者都拿到才算得出来，缺一返回 null——绝不用估算值冒充。
export function clickThroughRate(m: Metrics): number | null {
  const imp = m.impressions ?? 0;
  const v = m.views ?? 0;
  if (imp <= 0 || v <= 0) return null;
  return Math.min(1, v / imp);
}

// 某个来源的流量占比（找不到返回 null，而不是 0——「没这项数据」与「占比为 0」是两回事）
export function sourceShare(m: Metrics, ...names: string[]): number | null {
  const src = m.sources;
  if (!src) return null;
  for (const n of names) {
    for (const [k, v] of Object.entries(src)) {
      if (k.includes(n) && typeof v === 'number') return v;
    }
  }
  return null;
}

export function emptyMetrics(): Metrics {
  return { views: 0, likes: 0, comments: 0, shares: 0, collects: 0 };
}

// 互动率粗算（用于竞对/自有内容打分）
export function engagementRate(m: Metrics): number {
  const v = m.views ?? 0;
  if (v <= 0) return 0;
  const interactions = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.collects ?? 0);
  return interactions / v;
}
