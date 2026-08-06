import { HOT_SOURCES, PLATFORM_LIST } from '../constants';
import { isProd } from '../env';
import type { CompetitorAdapter, HotEntry, HotListAdapter, CompetitorPostEntry } from './types';
import { DailyHotAdapter } from './dailyhot';
import { Hot60sAdapter } from './hot60s';
import { BaiduHotAdapter } from './baidu';
import { YouTubeHotAdapter } from './youtube-hot';
import { MockHotAdapter, MockCompetitorAdapter } from './mock';
import { realCompetitorAdapter } from './competitor-real';
import { rssHubAdapter } from './rsshub';

// 数据源注册与主备切换（双源冗余 + 熔断降级）。
// 热榜：自建 DailyHot(若配置) → 60s 公开实例(免 key) → Mock(兜底)。
// 竞对：Mock（真实通道需 TikHub/新榜 key 或用户授权）。

// 60s 公开实例开关（铁律：dev 态零基础设施、无网络可跑，全新 clone 默认全 Mock）：
//   · 生产态：默认接真（免 key 拿真实热榜），显式 BEACON_HOT60S='0' 才关。
//   · 非生产态（dev/test）：默认离线走确定性 Mock，显式 BEACON_HOT60S='1' 才联网。
// 兼容早期硬关开关 BEACON_60S_DISABLED='1'（任何环境都强制关，.env 模板里仍保留）。
function hot60sEnabled(): boolean {
  if (process.env.BEACON_60S_DISABLED === '1') return false;
  return isProd() ? process.env.BEACON_HOT60S !== '0' : process.env.BEACON_HOT60S === '1';
}

function hotAdapters(): HotListAdapter[] {
  const list: HotListAdapter[] = [];
  list.push(new BaiduHotAdapter()); // 百度专用（只覆盖 baidu，其余源自动跳过）：60s/DailyHot 都拿不到百度
  // YouTube 官方 API（只覆盖 youtube）：配了 key 才启用，经 BEACON_HTTP_PROXY(xray) 出海翻墙。
  // 拿不到（节点挂/无 key）→ 逐源回退 Mock，youtube 卡片如实标示例，不影响其他源。
  const ytKey = process.env.BEACON_YOUTUBE_API_KEY?.trim();
  if (ytKey) list.push(new YouTubeHotAdapter(ytKey, process.env.BEACON_HTTP_PROXY?.trim() || undefined));
  const base = process.env.BEACON_DAILYHOT_BASE_URL;
  if (base) list.push(new DailyHotAdapter(base)); // 自建开源实例（若配置，最优先）
  if (hot60sEnabled()) list.push(new Hot60sAdapter()); // 免 key 公开实例，无 SLA，单源失败逐源落 Mock
  list.push(new MockHotAdapter()); // 兜底通道：覆盖全部源且永不失败，保证 ingest 不整体挂
  return list;
}

// /api/health 的 hotSource 口径：当前热榜主数据通道是哪条。
// 只描述数据来源，不参与健康判定——公开实例无 SLA，不可达时逐源回退 Mock，不算基础设施故障。
export function hotSourceMode(): 'dailyhot' | '60s' | 'mock' {
  if (process.env.BEACON_DAILYHOT_BASE_URL) return 'dailyhot';
  if (hot60sEnabled()) return '60s';
  return 'mock';
}

export type HotFetchResult = {
  source: string;
  entries: HotEntry[];
  via: string;
  degraded: boolean;
};

export async function fetchHotSource(source: string): Promise<HotFetchResult> {
  const adapters = hotAdapters();
  for (const adapter of adapters) {
    if (!adapter.sources.includes(source)) continue;
    try {
      const entries = await adapter.fetchHot(source);
      if (entries.length > 0) {
        return { source, entries, via: adapter.name, degraded: adapter.kind === 'mock' };
      }
    } catch {
      // 熔断：跳到下一个备源
      continue;
    }
  }
  // 全部失败：返回空 + 降级标记（上层显示"数据新鲜度"警示，不开天窗）
  return { source, entries: [], via: 'none', degraded: true };
}

export async function fetchAllHot(): Promise<HotFetchResult[]> {
  return Promise.all(HOT_SOURCES.map((s) => fetchHotSource(s.key)));
}

// 竞对适配器链：主备切换与热榜同款逐源降级。
//   主：商业源/官方 API（TikHub 抖音/小红书 · 新榜公众号 · YouTube 官方 · twitterapi.io X · B站公开接口）
//   备：自建 RSSHub（方案二 · 开源自建，配 BEACON_RSSHUB_BASE_URL 才在链上；无指标，只做发新内容监控）
//   兜底：一条真实通道都没配时才落 Mock（dev 铁律：全新 clone 零网络跑通）。
// 注意与热榜的一个刻意差异：真实通道**配置了但全部失败**时不落 Mock 而是返回空——
// 竞对作品会入库成全局 CrawledPost，生产态把 Mock 假作品写进真实竞对档案是数据污染事故。
// （另有 authorized 通道 = 浏览器插件回传，不走本链——见 lib/ingest/competitor.ts）
function competitorChain(platform: string): CompetitorAdapter[] {
  const chain: CompetitorAdapter[] = [];
  const real = realCompetitorAdapter(platform);
  if (real) chain.push(real);
  const rss = rssHubAdapter(platform);
  if (rss) chain.push(rss);
  return chain;
}

export type CompetitorFetchResult = {
  platform: string;
  posts: CompetitorPostEntry[];
  via: string;
  degraded: boolean;
  /**
   * 这批 posts 是 Mock 造的示例数据。**调用方一律不得落库**（见 lib/pipeline.ts crawlOneCompetitor）：
   * Mock 只为「页面上别开天窗」而存在，写进 CrawledPost 就是永久污染——假标题混在真作品里，
   * 编造的互动量还会被 buildBaseline 当成竞对基准去和用户的真实数据比。
   */
  isMock?: boolean;
};

export async function fetchCompetitorPosts(platform: string, handle: string): Promise<CompetitorFetchResult> {
  const chain = competitorChain(platform);
  if (chain.length === 0) {
    // 零真实通道：dev/演示态 → Mock（isMock 语义，页面明确标注、且**不落库**）
    const mock = new MockCompetitorAdapter(platform);
    return { platform, posts: await mock.fetchPosts(handle), via: mock.name, degraded: true, isMock: true };
  }
  // 逐源尝试：拿到非空结果即返回；成功但为空先记着（可能是竞对真没发过作品），
  // 让后面的备源再试一次，全链都空/失败时如实返回空。
  let emptyVia: string | null = null;
  for (const adapter of chain) {
    try {
      const posts = await adapter.fetchPosts(handle);
      if (posts.length > 0) return { platform, posts, via: adapter.name, degraded: false };
      emptyVia = emptyVia ?? adapter.name;
    } catch {
      continue; // 熔断：跳到下一个备源
    }
  }
  if (emptyVia) return { platform, posts: [], via: emptyVia, degraded: false }; // 真实通道确认没作品
  return { platform, posts: [], via: 'none', degraded: true }; // 全链失败：空 + 降级标记，不喂假数据
}

// 数据源健康看板（供设置页/概览页显示新鲜度）
export async function sourceHealthBoard() {
  const hot = hotAdapters();
  const hotHealth = await Promise.all(
    hot.map(async (a) => ({ name: a.name, kind: a.kind, ...(await a.health()) })),
  );
  const competitorHealth = PLATFORM_LIST.map((p) => {
    const chain = competitorChain(p.key);
    const primary = chain[0] ?? new MockCompetitorAdapter(p.key);
    // name 显示整条链（如 "tikhub → rsshub"），kind 取主源——设置页据此标注通道性质
    const name = chain.length > 1 ? chain.map((a) => a.name).join(' → ') : primary.name;
    return { platform: p.key, name, kind: primary.kind };
  });
  return { hot: hotHealth, competitor: competitorHealth };
}
