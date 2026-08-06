import type { HotEntry, HotListAdapter } from './types';

// 免费公开热榜接口（60s API，无需 key，默认启用；BEACON_HOT60S='0' 显式关闭）。
// 开源地址 https://github.com/vikiboss/60s 。默认连作者的公开实例——个人维护、无 SLA，
// 所以单源失败/超时只回退 Mock（registry 逐源熔断），绝不拖垮 ingest。
// 可自部署后用 BEACON_60S_BASE_URL 覆盖。
// 覆盖平台：抖音/微博/知乎/头条/B站；其余源(百度/小红书/YouTube/X)由自建 DailyHot 或商业源兜底。

const BASE = process.env.BEACON_60S_BASE_URL || 'https://60s.viki.moe/v2';

// 本系统 source 键 → 60s 端点
const ROUTE: Record<string, string> = {
  douyin: 'douyin',
  weibo: 'weibo',
  zhihu: 'zhihu',
  toutiao: 'toutiao',
  bilibili: 'bili',
};

export class Hot60sAdapter implements HotListAdapter {
  readonly name = '60s-public';
  readonly kind = 'opensource' as const;
  readonly sources = Object.keys(ROUTE);

  async fetchHot(source: string): Promise<HotEntry[]> {
    const route = ROUTE[source];
    if (!route) return [];
    // 5s 超时：公开实例慢即视为不可用，快速熔断落 Mock，别拖住整轮 ingest
    const res = await fetch(`${BASE.replace(/\/$/, '')}/${route}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`60s ${source} HTTP ${res.status}`);
    const json = (await res.json()) as { code?: number; data?: unknown[] };
    if (json.code !== 200 || !Array.isArray(json.data)) throw new Error(`60s ${source} 无数据`);
    return json.data.slice(0, 30).map((raw, i) => {
      const it = raw as Record<string, unknown>;
      return {
        source,
        rank: i + 1,
        title: String(it.title ?? ''),
        url: (it.link ?? it.url ?? it.mobil_url) as string | undefined,
        heat: Number(it.hot_value ?? it.hot ?? 0) || 0,
        extra: it.detail ? { desc: String(it.detail).slice(0, 120) } : {},
      };
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${BASE.replace(/\/$/, '')}/weibo`, { signal: AbortSignal.timeout(6000) });
      return { ok: res.ok, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
