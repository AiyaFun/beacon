import type { CompetitorAdapter, CompetitorPostEntry } from './types';

// RSSHub 自建实例（方案二 · 开源自建通道，kind='opensource'）。
//
// 定位：**竞对发新内容的变更监控**，不是指标采集——RSS 里没有播放/点赞数，
// metrics 一律为空，作品指标靠商业 API（TikHub 等）或插件回传（authorized 通道）补。
// 两条通道 upsert 到同一 (platform, platformItemId)，谁有指标谁补上，互不覆盖为零。
//
// 合规边界（用户明确要求不走灰色地带）：
//   · 只在配置 BEACON_RSSHUB_BASE_URL（自部署实例）时启用——dev 铁律：无 env 零网络。
//   · 只订阅公开主页的公开作品列表，频率跟随 crawl_competitors cron（默认 2h 一轮），
//     且 RSSHub 实例自身带缓存层，对源站的实际请求频率更低。
//   · 抖音/小红书路由在 RSSHub 侧可能需要实例配置 cookie 才可用——那是实例部署者的
//     选择；本适配器对拿不到的路由只会得到 4xx/5xx 然后走 registry 的降级链，不重试硬闯。
//
// 输出格式：统一请求 `?format=json`（JSON Feed 1.1），省掉 XML 解析依赖。

// 平台 → RSSHub 路由（handle 语义与 CompetitorAccount.handle 对齐）：
//   bilibili → UP 主 mid    douyin → sec_user_id    xiaohongshu → user_id
//   youtube → @handle       x → 用户名（RSSHub 实例需自配 twitter 凭证）    tiktok → unique_id
// wechat 无稳定公开路由，不支持（→ null，registry 走下一通道）。
const ROUTES: Record<string, (handle: string) => string> = {
  bilibili: (h) => `/bilibili/user/video/${encodeURIComponent(h)}`,
  douyin: (h) => `/douyin/user/${encodeURIComponent(h)}`,
  xiaohongshu: (h) => `/xhs/user/${encodeURIComponent(h)}/notes`,
  youtube: (h) => `/youtube/user/@${encodeURIComponent(h.replace(/^@/, ''))}`,
  x: (h) => `/twitter/user/${encodeURIComponent(h.replace(/^@/, ''))}`,
  // tiktok → unique_id（不带 @）。与抖音/小红书同档：路由能不能用取决于实例部署情况，
  // 拿不到就是 4xx/5xx，registry 走下一通道，不重试硬闯。
  tiktok: (h) => `/tiktok/user/${encodeURIComponent(h.replace(/^@/, ''))}`,
};

// JSON Feed 1.1 的条目形状（只取用到的字段）
type JsonFeedItem = {
  id?: string;
  url?: string;
  title?: string;
  summary?: string;
  content_html?: string;
  date_published?: string;
};

// 从作品 URL 提取平台原生 ID，与其他通道（插件采到的 B 站 bvid、TikHub 的 aweme_id/note_id）
// 的 platformItemId 对齐——对不齐就会出现同一作品两条记录，upsert 幂等失效。
const ID_PATTERNS: Record<string, RegExp> = {
  bilibili: /video\/(BV\w+)/,
  douyin: /video\/(\d+)/,
  xiaohongshu: /(?:explore|discovery\/item)\/([0-9a-f]+)/,
  youtube: /(?:watch\?v=|youtu\.be\/|shorts\/)([\w-]+)/,
  x: /status\/(\d+)/,
  // 与 content/tiktok.js、lib/publish/parse-url.ts 同口径：纯数字 item_id
  tiktok: /\/(?:video|photo)\/(\d+)/,
};

function extractItemId(platform: string, item: JsonFeedItem, fallback: string): string {
  for (const s of [item.url, item.id]) {
    const m = s ? ID_PATTERNS[platform]?.exec(s) : null;
    if (m) return m[1];
  }
  return item.id ?? item.url ?? fallback;
}

// content_html → 纯文本摘要（RSS 描述常是整段 HTML）
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export class RssHubAdapter implements CompetitorAdapter {
  readonly name = 'rsshub';
  readonly kind = 'opensource' as const;
  constructor(
    readonly platform: string,
    private baseUrl: string,
  ) {}

  async fetchPosts(handle: string): Promise<CompetitorPostEntry[]> {
    const route = ROUTES[this.platform];
    if (!route) return [];
    const url = `${this.baseUrl.replace(/\/$/, '')}${route(handle)}?format=json&limit=15`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`rsshub ${res.status}`);
    const feed = (await res.json()) as { items?: JsonFeedItem[] };
    const items = feed?.items ?? [];
    return items.slice(0, 15).map((it, i) => {
      const summary = it.summary ?? (it.content_html ? stripHtml(it.content_html) : undefined);
      const publishedAt = it.date_published ? new Date(it.date_published) : undefined;
      return {
        platform: this.platform,
        platformItemId: extractItemId(this.platform, it, `${handle}-rss-${i}`),
        title: (it.title ?? '').trim() || (summary ?? '').slice(0, 60),
        summary: summary?.slice(0, 200),
        url: it.url,
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined,
        // 有意不给 metrics（undefined 而非 {}）：RSS 无互动指标。
        // pipeline 的 upsert 对无 metrics 的条目不覆盖已有指标（见 crawlOneCompetitor）。
      };
    });
  }

  async health() {
    return rssHubStatus();
  }
}

/**
 * 自建 RSSHub 实例现在到底活着没有。
 *
 * 【为什么要真的探一次】原来这个 health() 是个桩：无条件 `ok: true`，只把 URL 回显一遍。
 * 容器死了、镜像拉挂了、端口没通——它一律说「好」。而 sourceHealthBoard() 又只对
 * **热榜**适配器调 health，竞对那半只列名字，所以这个桩连被调用的机会都没有。
 * 结果是「这个容器到底有没有在干活」这件事在产品里**根本答不了**——
 * 而那正是「该配上还是该停掉」这个问题会一直悬着的原因。
 *
 * 【判据是「够不够得着」，不是「返回什么」】任何 HTTP 响应都说明实例活着；
 * 只有连不上/超时才算挂。RSSHub 对未知路径回 404 是正常的，不该被读成故障。
 */
export async function rssHubStatus(): Promise<{
  configured: boolean; baseUrl?: string; ok: boolean; detail: string;
}> {
  const base = process.env.BEACON_RSSHUB_BASE_URL?.trim();
  if (!base) {
    return {
      configured: false,
      ok: false,
      detail: '没有配 BEACON_RSSHUB_BASE_URL —— 这条备用通道不在链上（不是故障）',
    };
  }
  try {
    // 3 秒够了：它是同一个 compose 网络里的邻居。探测挂在设置页渲染上，不能让一个
    // 死掉的容器把整页拖住。
    const res = await fetch(`${base.replace(/\/$/, '')}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return { configured: true, baseUrl: base, ok: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    return {
      configured: true,
      baseUrl: base,
      ok: false,
      detail: `连不上：${(e as Error).message.slice(0, 80)}`,
    };
  }
}

// env 门控：配了自建实例地址且该平台有路由才返回（否则 null → registry 走下一通道）
export function rssHubAdapter(platform: string): RssHubAdapter | null {
  const base = process.env.BEACON_RSSHUB_BASE_URL?.trim();
  if (!base || !ROUTES[platform]) return null;
  return new RssHubAdapter(platform, base);
}
