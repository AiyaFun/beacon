import type { HotEntry, HotListAdapter } from './types';

// 开源热榜主通道：对接自建的 DailyHotApi 实例（https://github.com/imsyy/DailyHotApi）。
// 设置 BEACON_DAILYHOT_BASE_URL 指向你的 Docker 实例即可切换为真实数据。

// DailyHotApi 的 routeName 与本系统 source 键的映射
const ROUTE_MAP: Record<string, string> = {
  douyin: 'douyin',
  weibo: 'weibo',
  bilibili: 'bilibili',
  zhihu: 'zhihu',
  baidu: 'baidu',
  toutiao: 'toutiao',
  // xiaohongshu / youtube / x 在多数开源实例中缺失，需商业源或用户授权兜底
};

export class DailyHotAdapter implements HotListAdapter {
  readonly name = 'dailyhot-opensource';
  readonly kind = 'opensource' as const;
  readonly sources = Object.keys(ROUTE_MAP);
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async fetchHot(source: string): Promise<HotEntry[]> {
    const route = ROUTE_MAP[source];
    if (!route) return [];
    const res = await fetch(`${this.baseUrl}/${route}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`DailyHot ${source} HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: { title?: string; url?: string; hot?: number; desc?: string }[];
    };
    // 过滤空标题项：部分源（如百度热搜需 cookie）会返回 code 200 但 data 里是占位空项，
    // 直接入库会在页面上显示空行、且让「示例数据」标签误消失。全空则抛错 → registry 逐源降级到 Mock，
    // 页面如实标「示例数据」，比展示空行诚实。
    const entries = (data.data ?? [])
      .filter((item) => item.title && item.title.trim())
      .slice(0, 30)
      .map((item, i) => ({
        source,
        rank: i + 1,
        title: item.title!.trim(),
        url: item.url,
        heat: item.hot ?? 0,
        extra: item.desc ? { desc: item.desc } : {},
      }));
    if (entries.length === 0) throw new Error(`DailyHot ${source} 空数据（可能需 cookie）`);
    return entries;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/all`, { signal: AbortSignal.timeout(5000) });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
