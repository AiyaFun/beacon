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

// ── B站：公开接口（低风险，法务书面评估后启用；频率 ≤ 每日 1-2 次）──
//
// ⚠️ 2026-08-24 合规审查后改动：**不再伪装成浏览器**。
// 原来发的是 `user-agent: Mozilla/5.0` + `referer: https://www.bilibili.com`——
// 这两个头是「伪装成用户浏览器以绕过服务端识别」的教科书特征，在反不正当竞争诉讼里
// 会被直接当作「规避技术措施」的证据（淘宝诉美景、微博诉脉脉两案都点过这一条）。
// 我们抓的是公开数据、量也极小，没有任何理由去背这个证据点。
//
// 现在发的是标识自己身份的 UA，B 站因此**可能拒绝**这个请求。这是可以接受的结果：
// 对方明示不欢迎自动化访问时就不该硬抓——registry 会回退到 Mock，用户侧表现为
// 「B 站真实数据源不可用」，而不是拿到一份靠伪装换来的数据。
//
// ── 2026-08-24 真机实测：这条通道**现在取不到数据，三种 UA 都取不到** ──
//   BeaconBot        → HTTP 200, code=-352「风控校验失败」
//   Mozilla/5.0+ref  → HTTP 200, code=-403「访问权限不足」（也就是改动前同样拿不到）
//   不带 UA          → HTTP 200, code=-403
// 真因是路径里那个 `wbi`：这是 B 站的**接口签名机制**，URL 必须带 `w_rid`/`wts`
// 两个由前端算法生成的签名参数，我们从来没算过。所以这个适配器不是被本次改动弄坏的，
// 它此前就已经是死代码——只是失败得**很安静**（见下面 assertBiliOk 的注释）。
//
// 【为什么不去实现 wbi 签名】wbi 签名**就是** B 站的技术措施本身。
// 本轮刚把伪装 UA 去掉，理由是「不规避目标站点的技术措施」；转头去破解它的签名算法，
// 是同一件事更重的版本。要恢复 B 站数据源，正路是走商业数据服务商或官方开放平台，
// 不是把签名算出来。**谁都别把这段注释删掉去实现它。**
export const BILIBILI_UA = 'BeaconBot/1.0 (+https://beacon.iyunci.cn)';

/**
 * B 站接口的失败是 **HTTP 200 + body 里 code≠0**，getJson 的 `!res.ok` 一个都拦不住。
 *
 * 不判这一下的后果不是「报错」，是**静默返回 0 条**：`data?.data?.list?.vlist ?? []`
 * 把一次失败的请求变成一个空数组，registry 那边看到的是「真实通道确认这个号没作品」
 * （emptyVia 分支），于是既不熔断、也不回退备源、也不打降级标记——
 * 用户看到的是「B 站竞对一条作品都没有」，而不是「这个数据源坏了」。
 * 同一形状在项目里出现过多次（见 lib/ingest 那几处「缺席不许当成 0」）。
 */
function assertBiliOk(data: any): void {
  const code = Number(data?.code);
  if (code === 0) return;
  const msg = String(data?.message || '未知错误');
  // -403 / -352 是缺 wbi 签名与风控拦截，也就是本文件上方说的那件事。
  // 原样带出去：让健康看板与台账上留下的是真实原因，不是我们编的一句话。
  throw new Error(`B 站接口拒绝（code=${code}：${msg}）`);
}

export class BilibiliAdapter implements CompetitorAdapter {
  readonly name = 'bilibili-public';
  readonly kind = 'opensource' as const;
  readonly platform = 'bilibili';
  async fetchPosts(handle: string): Promise<CompetitorPostEntry[]> {
    // handle = UP 主 mid
    const url = `https://api.bilibili.com/x/space/wbi/arc/search?mid=${encodeURIComponent(handle)}&ps=15&pn=1`;
    const data = await getJson(url, { 'user-agent': BILIBILI_UA });
    assertBiliOk(data);
    const list: any[] = data?.data?.list?.vlist ?? [];
    return list.flatMap((v) => {
      // 只认 bvid：parse-url.ts 与插件两侧的 B 站身份都是 BV 号，
      // 用 aid 兜底会造出一条永远匹配不上 BV 记录的重复行（同一视频两条）。
      const bvid = idOrNull(v.bvid);
      if (!bvid) return [];
      return [{
        platform: 'bilibili',
        platformItemId: bvid,
        title: v.title ?? '',
        summary: v.description,
        url: `https://www.bilibili.com/video/${bvid}`,
        publishedAt: v.created ? new Date(v.created * 1000) : undefined,
        metrics: { views: num(v.play), comments: num(v.comment) },
      }];
    });
  }
  /**
   * 真探一次，**不报平安**。
   *
   * 原来这里硬编码 `{ ok: true, detail: 'bilibili public' }`——而实测证明这条通道
   * 一条数据都取不到。健康看板（lib/adapters/registry.ts 的 sourceHealthBoard，
   * 显示在设置页）于是长期对用户说「正常」，这比没有健康看板更坏。
   *
   * 与其它适配器不同，这一个探真实接口：它没有 key、不计费、不占任何人的配额，
   * 探一次的代价只有一个 HTTP 请求。TikHub / 新榜那几家按次计费，所以那边只验配置——
   * 但它们的 detail 会明说「只验了配置」，不冒充连通性。
   */
  async health() {
    try {
      const data = await getJson(
        'https://api.bilibili.com/x/space/wbi/arc/search?mid=946974&ps=1&pn=1',
        { 'user-agent': BILIBILI_UA },
      );
      assertBiliOk(data);
      return { ok: true, detail: 'B 站公开接口可用' };
    } catch (e) {
      return { ok: false, detail: `B 站公开接口不可用：${(e as Error).message}` };
    }
  }
}

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
  if (platform === 'bilibili' && process.env.BEACON_BILIBILI_ENABLED === '1') return new BilibiliAdapter();
  return null;
}
