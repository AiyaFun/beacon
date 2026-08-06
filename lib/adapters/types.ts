// 数据接入层统一契约（PRD §7）。五通道（官方API/商业API/开源自建/RSS/用户授权）
// 都实现同一 SourceAdapter 接口，上层不感知来源，可主备切换与熔断。

export type HotEntry = {
  source: string;
  rank: number;
  title: string;
  url?: string;
  heat?: number;
  extra?: Record<string, unknown>;
};

export type CompetitorPostEntry = {
  platform: string;
  platformItemId: string;
  title: string;
  summary?: string;
  url?: string;
  publishedAt?: Date;
  metrics?: Record<string, number>;
};

export interface HotListAdapter {
  readonly name: string;
  readonly kind: 'opensource' | 'commercial' | 'official' | 'rss' | 'mock';
  readonly sources: string[];
  fetchHot(source: string): Promise<HotEntry[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export interface CompetitorAdapter {
  readonly name: string;
  readonly kind: 'opensource' | 'commercial' | 'official' | 'authorized' | 'mock';
  readonly platform: string;
  fetchPosts(handle: string): Promise<CompetitorPostEntry[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
