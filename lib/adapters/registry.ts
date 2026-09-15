import { HOT_SOURCES, PLATFORM_LIST } from '../constants';
import { isProd } from '../env';
import type { CompetitorAdapter, HotEntry, HotListAdapter, CompetitorPostEntry } from './types';
import { DailyHotAdapter } from './dailyhot';
import { Hot60sAdapter } from './hot60s';
import { BaiduHotAdapter } from './baidu';
import { YouTubeHotAdapter } from './youtube-hot';
import { MockHotAdapter, MockCompetitorAdapter } from './mock';
import { PLUGIN_COLLECTABLE } from '../ingest/competitor';
import { realCompetitorAdapter } from './competitor-real';
import { rssHubAdapter, rssHubStatus } from './rsshub';

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
//   主：商业源/官方 API（TikHub 抖音/小红书 · 新榜公众号 · YouTube 官方 · twitterapi.io X；B 站无服务端主源，见 competitor-real.ts）
//   备：自建 RSSHub（方案二 · 开源自建，配 BEACON_RSSHUB_BASE_URL 才在链上；无指标，只做发新内容监控）
//   兜底：一条真实通道都没配时才落 Mock（dev 铁律：全新 clone 零网络跑通）。
// 注意与热榜的一个刻意差异：真实通道**配置了但全部失败**时不落 Mock 而是返回空——
// 竞对作品会入库成全局 CrawledPost，生产态把 Mock 假作品写进真实竞对档案是数据污染事故。
// （另有 authorized 通道 = 浏览器插件回传，不走本链——见 lib/ingest/competitor.ts）
/**
 * 服务端有没有一条**真能走通**的路去采这个平台。
 *
 * 判据就是链空不空，不写死平台名单：将来补上 BEACON_NEWRANK_KEY 之类，
 * 这里自动变成 true，靠它做决定的地方（定时采集派不派活给插件）也就自动停手。
 * 写死名单的话，配了 key 还在派活，用户会看到「插件一直在采一个服务端已经采好的号」。
 */
export function serverCanCrawl(platform: string): boolean {
  return competitorChain(platform).length > 0;
}

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
/**
 * 一个平台的竞对数据**现在到底取不取得到**。
 *
 * 【为什么必须有这个，而且必须显示出来】隐私政策里写着
 * 「未配置时对应平台不取数（**界面上会显示为数据源未启用**）」——
 * 而 2026-08-29 查出来：`sourceHealthBoard()` 返回的 competitor 那一半
 * **一处都没渲染过**，那句承诺零代码兑现。
 * 用户看到的是「加了竞对、点进去空白」，而界面上不说为什么——
 * 这比没有这个功能更伤：没有功能他不会失望，有入口点了没数据他会认为产品坏了。
 *
 * 【三态，不是两态】「要装插件」和「真的没有数据源」对用户是完全不同的两件事：
 * 前者他能自己解决，后者他做什么都没用。合并成「未启用」等于把能解决的问题
 * 说成了解决不了的。
 */
export type CompetitorSourceStatus = 'server' | 'plugin' | 'none';

export function competitorSourceStatus(platform: string): CompetitorSourceStatus {
  if (competitorChain(platform).length > 0) return 'server';
  // 【直接用那份名单，不再抄一遍】原来这里写了一个同内容的 PLUGIN_ONLY，
  // 打算再配一条「两份要一致」的守卫——但这个项目已经反复证明：
  // 靠守卫维持两份清单一致，不如只留一份。确认过无循环依赖（ingest/competitor
  // 的依赖链里没有 adapters/registry）。
  return PLUGIN_COLLECTABLE.has(platform) ? 'plugin' : 'none';
}

/**
 * 数据源实况面板。拆成三段是因为**它们的代价差了三个数量级**：
 *
 *   · 竞对那半（competitorSourceBoard）= 纯计算，读的是内存里的适配器链，0 次网络；
 *   · 热榜那半（hotSourceHealth）= 每个适配器各发一次真实 HTTP 探测，超时 5~6 秒；
 *   · 自建 RSSHub（rssHubStatus）= 再一次 HTTP，超时 3 秒。
 *
 * 【为什么要拆】2026-09-12 量到：/settings 的 domContentLoaded = **5022ms**，
 * 其余每一页都在 20~50ms。5 秒全花在「这一页顺手探一下所有外部源活着没有」上，
 * 而那一页真正要给用户看的（定时任务开关、模型渠道数、密钥入口）一次网络都不需要。
 * 探测挂在渲染的关键路径上 = 外部源慢一秒，用户的设置页就白屏一秒；
 * 源挂了（超时 6 秒）用户看到的是「这个产品坏了」，而不是「这条数据源坏了」。
 *
 * 拆开后：页面主体立刻出来，两块探测各自挂在自己的 <Suspense> 里流进来。
 * 再加 TTL 缓存——同一批探测结果在 60 秒内共享，连着刷两次设置页不会重探一轮。
 */
const HEALTH_TTL_MS = 60_000;
let hotHealthCache: { at: number; value: Promise<HotSourceHealth[]> } | null = null;
let rssHubCache: { at: number; value: Promise<RssHubHealth> } | null = null;

export type HotSourceHealth = { name: string; kind: string; ok: boolean; detail?: string };
export type RssHubHealth = { configured: boolean; baseUrl?: string; ok: boolean; detail: string };

/** 当前挂在链上的热榜通道条数。纯计算——设置页的统计格只要这个数，不必等探测。 */
export function hotSourceCount(): number {
  return hotAdapters().length;
}

/** 热榜各通道的实况。真发 HTTP，**结果缓存 60 秒**（失败的结果不缓存，免得一次抖动钉住一分钟）。 */
export function hotSourceHealth(): Promise<HotSourceHealth[]> {
  const now = Date.now();
  if (hotHealthCache && now - hotHealthCache.at < HEALTH_TTL_MS) return hotHealthCache.value;
  const value = Promise.all(
    hotAdapters().map(async (a) => ({ name: a.name, kind: a.kind, ...(await a.health()) })),
  ).catch((e) => {
    hotHealthCache = null; // 整批挂了就别把这个结果留在缓存里
    throw e;
  });
  hotHealthCache = { at: now, value };
  return value;
}

/** 自建 RSSHub 实况。同样缓存 60 秒；探测本身抛错时如实说，不冒充「没配」。 */
export function rssHubHealth(): Promise<RssHubHealth> {
  const now = Date.now();
  if (rssHubCache && now - rssHubCache.at < HEALTH_TTL_MS) return rssHubCache.value;
  const value = rssHubStatus().catch(() => ({
    configured: false, ok: false, detail: '探测本身失败',
  }));
  rssHubCache = { at: now, value };
  return value;
}

/** 竞对那半：纯计算，读适配器链与插件名单，一次网络都不发。 */
export function competitorSourceBoard() {
  return PLATFORM_LIST.map((p) => {
    const chain = competitorChain(p.key);
    const primary = chain[0] ?? new MockCompetitorAdapter(p.key);
    // name 显示整条链（如 "tikhub → rsshub"），kind 取主源——设置页据此标注通道性质
    const name = chain.length > 1 ? chain.map((a) => a.name).join(' → ') : primary.name;
    return { platform: p.key, name, kind: primary.kind, status: competitorSourceStatus(p.key) };
  });
}

/**
 * 三段合一。运维台（/ops/health）一次要看全，它只有运维在看，等得起；
 * 用户侧的 /settings 不用这个入口，各段分别流式取（见 app/(app)/settings/page.tsx）。
 */
export async function sourceHealthBoard() {
  const [hot, rsshub] = await Promise.all([hotSourceHealth(), rssHubHealth()]);
  return { hot, competitor: competitorSourceBoard(), rsshub };
}
