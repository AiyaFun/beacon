import { ProxyAgent } from 'undici';
import type { HotEntry, HotListAdapter } from './types';

// YouTube 热门榜适配器：官方 Data API v3 `chart=mostPopular`（真实热门榜，每天 1 万配额免费）。
// ⚠️ 国内服务器直连 googleapis 被 GFW 挡，必须经 BEACON_HTTP_PROXY（内网 xray 代理）出海。
// 仅当 BEACON_YOUTUBE_API_KEY 存在时启用（见 registry）；proxy 不可达/节点挂 → 抛错回退 Mock（示例）。
//
// 区域：BEACON_YOUTUBE_REGION 控制榜单地区，默认 US（出海创作者最关心的全球风向）。

const REGION = process.env.BEACON_YOUTUBE_REGION || 'US';

type YtItem = {
  id?: string;
  snippet?: { title?: string; channelTitle?: string };
  statistics?: { viewCount?: string };
};

export class YouTubeHotAdapter implements HotListAdapter {
  readonly name = 'youtube-official';
  readonly kind = 'official' as const;
  readonly sources = ['youtube'];
  private dispatcher?: ProxyAgent;

  constructor(
    private apiKey: string,
    proxyUrl?: string,
  ) {
    if (proxyUrl) this.dispatcher = new ProxyAgent(proxyUrl);
  }

  async fetchHot(source: string): Promise<HotEntry[]> {
    if (source !== 'youtube') return [];
    const url =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular` +
      `&maxResults=30&regionCode=${encodeURIComponent(REGION)}&key=${encodeURIComponent(this.apiKey)}`;
    // dispatcher 是 undici 对 fetch 的扩展项，标准 RequestInit 类型不含它，故整体 cast。
    const opts = { signal: AbortSignal.timeout(20_000), dispatcher: this.dispatcher } as unknown as RequestInit;
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`youtube HTTP ${res.status}`);
    const json = (await res.json()) as { items?: YtItem[]; error?: { message?: string } };
    if (json.error) throw new Error(`youtube api: ${json.error.message ?? 'unknown'}`);
    const items = json.items ?? [];
    const entries = items
      .filter((it) => it.snippet?.title && it.id)
      .slice(0, 30)
      .map((it, i) => ({
        source: 'youtube',
        rank: i + 1,
        title: it.snippet!.title!,
        url: `https://www.youtube.com/watch?v=${it.id}`,
        heat: Number(it.statistics?.viewCount) || 0,
        extra: it.snippet?.channelTitle ? { desc: `频道：${it.snippet.channelTitle}` } : {},
      }));
    if (entries.length === 0) throw new Error('youtube 空数据');
    return entries;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.fetchHot('youtube');
      return { ok: true, detail: `region ${REGION}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
