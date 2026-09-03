import type { CompetitorAdapter, CompetitorPostEntry } from './types';

// 真实竞对采集适配器（env 门控）。按 research-3 的合规通道：
//   抖音/小红书 → TikHub    公众号 → 新榜(NewRank)    YouTube → 官方 Data API    X → twitterapi.io    B站 → 公开接口
// 未配 key 时由 registry 回退 Mock。注意：第三方响应字段可能随版本变化，接入真实 key 后需按其文档校对 normalize 映射。

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  // 错误消息要带主机名与状态码：它会一路走到健康看板和采集台账的 note 上给人看。
  // 原来只抛一个裸的 `412`，在看板上就是一个孤零零的数字，谁也不知道是哪个源、什么毛病。
  // （412 是 B 站风控的常用码，2026-08-24 实测撞到过——见 BilibiliAdapter 上方的注释。）
  if (!res.ok) throw new Error(`${new URL(url).hostname} 返回 HTTP ${res.status}`);
  return res.json();
}

// 认不出作品 ID 就**跳过这一条**，绝不用序号/位置凑一个。
//
// 为什么这是硬规矩：lib/pipeline.ts 的 crawlOneCompetitor 按 (platform, platformItemId) upsert。
// 位置型 ID（如 `handle-0`）在下一次抓取时会命中「那一次恰好排在第 0 位的另一条作品」——
// 于是 B 的指标被写进 A 的记录，还给 A 追加一条其实属于 B 的快照，趋势图混着两条视频。
// 少采一条 ≪ 张冠李戴。同口径见 lib/publish/parse-url.ts 文件头第 2 条铁律。
function idOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  // String(undefined) === 'undefined'：不挡的话会造出一条 id 为 "undefined" 的记录
  return s && s !== 'undefined' && s !== 'null' ? s : null;
}

// ── TikHub：抖音 / 小红书 ──
export class TikHubAdapter implements CompetitorAdapter {
  readonly name = 'tikhub';
  readonly kind = 'commercial' as const;
  constructor(readonly platform: string, private key: string) {}
  async fetchPosts(handle: string): Promise<CompetitorPostEntry[]> {
    const base = 'https://api.tikhub.io/api/v1';
    const path =
      this.platform === 'douyin'
        ? `/douyin/web/fetch_user_post_videos?sec_user_id=${encodeURIComponent(handle)}&count=15`
        : `/xiaohongshu/web/fetch_user_notes?user_id=${encodeURIComponent(handle)}&count=15`;
    const data = await getJson(base + path, { authorization: `Bearer ${this.key}` });
    const list: any[] = data?.data?.aweme_list ?? data?.data?.notes ?? data?.data?.data ?? [];
    return list.flatMap((it) => {
      const id = idOrNull(it.aweme_id ?? it.note_id ?? it.id);
      if (!id) return []; // 认不出就跳过，不用 `${handle}-${i}` 凑
      return [{
        platform: this.platform,
        platformItemId: id,
        title: it.desc ?? it.title ?? it.display_title ?? '',
        summary: it.desc ?? undefined,
        url: it.share_url ?? it.url,
        publishedAt: it.create_time ? new Date(Number(it.create_time) * 1000) : undefined,
        metrics: {
          views: num(it.statistics?.play_count ?? it.interact_info?.view_count),
          likes: num(it.statistics?.digg_count ?? it.interact_info?.liked_count),
          comments: num(it.statistics?.comment_count ?? it.interact_info?.comment_count),
          shares: num(it.statistics?.share_count ?? it.interact_info?.share_count),
          collects: num(it.statistics?.collect_count ?? it.interact_info?.collected_count),
        },
      }];
    });
  }
  async health() {
    return { ok: true, detail: 'TikHub 已配置密钥（只验配置，未探连通——该接口按次计费）' };
  }
}

// ── YouTube 官方 Data API v3 ──
export class YouTubeAdapter implements CompetitorAdapter {
  readonly name = 'youtube-official';
  readonly kind = 'official' as const;
  readonly platform = 'youtube';
  constructor(private key: string) {}
  async fetchPosts(handle: string): Promise<CompetitorPostEntry[]> {
    const base = 'https://www.googleapis.com/youtube/v3';
    // 1) handle → uploads 播放列表（省 quota，避开 search.list 的 100 单位）
    const ch = await getJson(`${base}/channels?part=contentDetails&forHandle=${encodeURIComponent(handle.replace(/^@/, ''))}&key=${this.key}`);
    const uploads = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];
    // 2) 最近视频
    const pl = await getJson(`${base}/playlistItems?part=snippet,contentDetails&playlistId=${uploads}&maxResults=15&key=${this.key}`);
    const items: any[] = pl?.items ?? [];
    const ids = items.map((i) => i.contentDetails?.videoId).filter(Boolean).join(',');
    // 3) 指标
    const stats = ids ? await getJson(`${base}/videos?part=statistics&id=${ids}&key=${this.key}`) : { items: [] };
    const statMap = new Map<string, any>((stats.items ?? []).map((v: any) => [v.id, v.statistics]));
    return items.flatMap((it) => {
      // 只认 contentDetails.videoId。playlistItem 的 it.id 是「播放列表项」的 id，
      // 不是视频身份——拿它当 platformItemId 会造出一条永远对不上任何视频的记录。
      const vid = idOrNull(it.contentDetails?.videoId);
      if (!vid) return [];
      const st = statMap.get(vid) ?? {};
      return [{
        platform: 'youtube',
        platformItemId: vid,
        title: it.snippet?.title ?? '',
        summary: it.snippet?.description?.slice(0, 200),
        url: `https://youtu.be/${vid}`,
        publishedAt: it.snippet?.publishedAt ? new Date(it.snippet.publishedAt) : undefined,
        metrics: { views: num(st.viewCount), likes: num(st.likeCount), comments: num(st.commentCount) },
      }];
    });
  }
  async health() {
    return { ok: true, detail: 'YouTube Data API 已配置密钥（只验配置，未探连通——该接口按次计配额）' };
  }
}

// ── X：twitterapi.io ──
export class TwitterApiAdapter implements CompetitorAdapter {
  readonly name = 'twitterapi-io';
  readonly kind = 'commercial' as const;
  readonly platform = 'x';
  constructor(private key: string) {}
  async fetchPosts(handle: string): Promise<CompetitorPostEntry[]> {
    const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(handle.replace(/^@/, ''))}`;
    const data = await getJson(url, { 'x-api-key': this.key });
    const list: any[] = data?.tweets ?? data?.data ?? [];
    return list.slice(0, 15).flatMap((t) => {
      const id = idOrNull(t.id);
      if (!id) return [];
      return [{
        platform: 'x',
        platformItemId: id,
        title: t.text ?? '',
        url: t.url,
        publishedAt: t.createdAt ? new Date(t.createdAt) : undefined,
        metrics: {
          views: num(t.viewCount),
          likes: num(t.likeCount),
          comments: num(t.replyCount),
          shares: num(t.retweetCount),
        },
      }];
    });
  }
  async health() {
    return { ok: true, detail: 'twitterapi.io 已配置密钥（只验配置，未探连通——该接口按次计费）' };
  }
}

// ── 公众号：新榜 NewRank ──
export class NewRankAdapter implements CompetitorAdapter {
  readonly name = 'newrank';
  readonly kind = 'commercial' as const;
  readonly platform = 'wechat';
  constructor(private key: string) {}
  async fetchPosts(handle: string): Promise<CompetitorPostEntry[]> {
    // 新榜开放平台按账号取近期文章（端点/签名以新榜商务文档为准；此处为结构骨架）
    const url = `https://api.newrank.cn/api/v2/weixin/account/articles?account=${encodeURIComponent(handle)}`;
    const data = await getJson(url, { 'key': this.key });
    const list: any[] = data?.data?.articles ?? data?.data ?? [];
    return list.slice(0, 15).flatMap((a) => {
      // 公众号口径：URL 即身份（见 parse-url.ts parseWechat）。认不出就跳过，不用序号凑。
      const id = idOrNull(a.url ?? a.id);
      if (!id) return [];
      return [{
        platform: 'wechat',
        platformItemId: id,
        title: a.title ?? '',
        summary: a.summary,
        url: a.url,
        publishedAt: a.publicTime ? new Date(a.publicTime) : undefined,
        metrics: { views: num(a.readNum), likes: num(a.likeNum ?? a.zanNum) },
      }];
    });
  }
  async health() {
    return { ok: true, detail: '新榜已配置密钥（只验配置，未探连通——该接口按次计费）' };
  }
}

// ── B 站：**没有服务端适配器，这是刻意的** ──
//
// 2026-08-24 实测这里曾经的 BilibiliAdapter 一条数据都取不到（路径里的 wbi 是 B 站的接口签名，
// 我们从来没算过），2026-09-02 整个删掉，理由有两层：
//   ① `api.bilibili.com/robots.txt` 是 `Disallow: /`——就算签名问题不存在，服务端直连它
//      也违反本项目自己的 robots 规矩（lib/web/robots.ts），没有给 B 站开例外的理由；
//   ② wbi 签名**就是** B 站的技术措施本身。去伪装 UA 的理由是「不规避目标站点的技术措施」，
//      转头去算签名是同一件事更重的版本。**谁都别把这段注释删掉去实现它。**
// B 站的数据回流走两条正路：插件（extension/content/bilibili.js，用户自己浏览器里读公开主页）
// 与自建 RSSHub 备源（lib/adapters/rsshub.ts）。tests/adapters/no-bilibili-server-fetch.test.ts 钉住。

// 按平台选择真实适配器（有对应 key 才返回，否则 null → registry 回退 Mock）
//
// ⚠️ **tiktok 刻意没有商业适配器**，不是漏了：TikHub 的 TikTok 作品列表接口按 secUid 取数，
// 而我们库里存的 handle 是 unique_id（主页 /@ 后面那串），两者不是一回事，凭空拼一个
// 参数名只会得到一串 4xx，还让「已配置真实通道」这句话变成假的。
// TikTok 的数据回流目前只走插件（extension/content/tiktok.js，见 PLUGIN_COLLECTABLE）——
// 那条路是用户自己在浏览器里打开公开主页读公开数字，不需要任何第三方 key。
// 将来要接商业源，先把 unique_id → secUid 的换算通道确认下来再加，别在这里猜。
export function realCompetitorAdapter(platform: string): CompetitorAdapter | null {
  const tikhub = process.env.BEACON_TIKHUB_KEY;
  if ((platform === 'douyin' || platform === 'xiaohongshu') && tikhub) return new TikHubAdapter(platform, tikhub);
  if (platform === 'youtube' && process.env.BEACON_YOUTUBE_API_KEY) return new YouTubeAdapter(process.env.BEACON_YOUTUBE_API_KEY);
  if (platform === 'x' && process.env.BEACON_TWITTERAPI_KEY) return new TwitterApiAdapter(process.env.BEACON_TWITTERAPI_KEY);
  if (platform === 'wechat' && process.env.BEACON_NEWRANK_KEY) return new NewRankAdapter(process.env.BEACON_NEWRANK_KEY);
  return null;
}
