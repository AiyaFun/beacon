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

/**
 * 这条作品到底有没有播放量。
 *
 * **抖音等平台的公开页面根本不显示播放量**（主页角标是 ♡ 点赞、详情页给的是赞/评/藏/转），
 * 播放量只有创作者后台才有。所以 `views` 缺席或为 0，含义都是「不知道」而不是「零次播放」——
 * 二者一旦混为一谈，下游就会拿 0 当真实观测，算出一堆看着像数据的假结论。
 */
export function hasViews(m: Metrics): boolean {
  return typeof m.views === 'number' && Number.isFinite(m.views) && m.views > 0;
}

/**
 * 比值。**算不出来就返回 null，绝不返回 0**——0 会被页面渲染成「0.0%」，
 * 那是把「没这项数据」说成了「这项数据是零」。
 *
 * 分子真的采到 0（比如这条确实零评论）是有意义的观测，照常返回 0；
 * 分子压根没采到（undefined）才是 null。这两件事的区别正是本函数存在的理由。
 */
export function ratioOf(numerator: number | undefined | null, denominator: number | undefined | null): number | null {
  if (typeof numerator !== 'number' || !Number.isFinite(numerator)) return null;
  if (typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * 互动率 =（赞+评+转+藏）/ 播放。**拿不到播放量返回 null**。
 *
 * 曾经在这里返回 0，代价有两层：页面上抖音作品一律显示「互动率 0.0%」（编的），
 * 以及任何按互动率排序/求均值的地方都会把抖音作品系统性摁到最底（也是编的）。
 * 同文件的 sourceShare / clickThroughRate 早就是 null 口径，这里补齐。
 */
export function engagementRate(m: Metrics): number | null {
  if (!hasViews(m)) return null;
  const interactions = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.collects ?? 0);
  return interactions / (m.views as number);
}
