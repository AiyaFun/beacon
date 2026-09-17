import { prisma } from '../db';
import { parseCompetitorUrl } from '../competitor-url';
import { ingestCompetitorData, ingestPayloadSchema } from '../ingest/competitor';
import { ingestOwnPostData, ownPostIngestSchema } from '../ingest/own-post';
import { ingestOwnAccountData, ownAccountIngestSchema } from '../ingest/own-account';
import { beijingDayKey } from '../beijing';
import type { CollectionChannel } from '../ingest/collection-run';
import { FIELD_KEY_OF, isRecipePlatform, type RecipePlatform } from './platform-recipes';

// ── 配方行 → 竞对作品（2026-09-15）───────────────────────────────────────
//
// 内置平台配方抓到的是「f1..f8 的字符串」，竞对库要的是 platformItemId / 指标数字 / 时间。
// 这一层做三件事，且每件都**宁可丢也不猜**：
//   ① 作品 ID 只从作品链接里按平台正则抠，抠不出的行跳过并计数（没有 ID 就没法去重，
//      硬塞一个标题哈希进去，下次改个标题就成了两条）；
//   ② 数字按「1.2万 / 3亿 / 1.5w / 12k / 1,234」解析，解析不出就不写这个指标
//     （Number(null)=0 那个老坑：缺席不许当成 0）；
//   ③ 时间认 ISO / 2026-09-15 / 09-15 / 3小时前 / 昨天 这些形态，认不出就不写。
// 归属优先信插件报上来的 competitorId（它打开的就是那一条竞对的主页），没有才从 URL 反推——
// 微博 /n/昵称 会 302 到 /u/数字 id，反推出来的 handle 和库里存的对不上，那种情况就一条都写不进去。

const ITEM_ID_PATTERNS: Record<RecipePlatform, RegExp[]> = {
  weibo: [/weibo\.com\/detail\/(\d{10,})/, /weibo\.com\/\d+\/([A-Za-z0-9]{9})(?:[?#/]|$)/, /weibo\.com\/[^/]+\/([A-Za-z0-9]{9})(?:[?#/]|$)/, /\/(\d{16,})(?:[?#/]|$)/],
  kuaishou: [/short-video\/([\w-]{6,})/],
  zhihu: [/\/(?:answer|p|pin|zvideo)\/(\d{3,})/],
  toutiao: [/\/(?:article|video|w|group)\/(\d{10,})/, /\/i(\d{10,})/],
  baijiahao: [/[?&]id=(\d{10,})/],
};

export function platformItemIdFrom(platform: RecipePlatform, url: string): string | null {
  const u = String(url ?? '').trim();
  if (!u) return null;
  for (const re of ITEM_ID_PATTERNS[platform]) {
    const m = re.exec(u);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** 「1.2万」「3亿」「1.5w」「12k」「1,234」「播放 1.2万」→ 整数；认不出 → undefined。 */
export function parseHumanCount(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
  const s = String(raw ?? '').replace(/,/g, '').trim();
  if (!s) return undefined;
  const m = /(\d+(?:\.\d+)?)\s*(亿|万|w|W|k|K|m|M)?/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2] ?? '';
  const mul = unit === '亿' ? 1e8 : (unit === '万' || unit === 'w' || unit === 'W') ? 1e4
    : (unit === 'k' || unit === 'K') ? 1e3 : (unit === 'm' || unit === 'M') ? 1e6 : 1;
  return Math.round(n * mul);
}

/** 宽松时间：ISO / 2026-09-15 / 2026/9/15 / 09-15（当年）/ 3小时前 / 2天前 / 昨天 / 前天 / 刚刚。 */
export function parseLooseDate(raw: unknown, now: Date = new Date()): Date | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (/刚刚|分钟前/.test(s)) return new Date(now);
  let m = /(\d+)\s*小时前/.exec(s);
  if (m) return new Date(now.getTime() - Number(m[1]) * 3600_000);
  m = /(\d+)\s*天前/.exec(s);
  if (m) return new Date(now.getTime() - Number(m[1]) * 86_400_000);
  if (/^昨天/.test(s)) return new Date(now.getTime() - 86_400_000);
  if (/^前天/.test(s)) return new Date(now.getTime() - 2 * 86_400_000);
  m = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  m = /^(\d{1,2})[-/月](\d{1,2})/.exec(s);
  if (m) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (Number.isNaN(d.getTime())) return undefined;
    // 「12-30」在一月看到时是去年的
    if (d.getTime() > now.getTime() + 86_400_000) d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? undefined : iso;
}

export type MappedPost = {
  platformItemId: string;
  title: string;
  url?: string;
  publishedAt?: string;
  metrics: Record<string, number>;
};

/** 把配方行映射成竞对作品。抠不出 ID 的行跳过并计数。 */
export function rowsToPosts(platform: RecipePlatform, rows: Record<string, string>[], now = new Date()): { posts: MappedPost[]; skipped: number } {
  const posts: MappedPost[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of rows ?? []) {
    const url = String(row[FIELD_KEY_OF['post.url']] ?? '').trim();
    const id = platformItemIdFrom(platform, url);
    if (!id || seen.has(id)) { skipped += 1; continue; }
    seen.add(id);
    const metrics: Record<string, number> = {};
    const views = parseHumanCount(row[FIELD_KEY_OF['post.views']]);
    const likes = parseHumanCount(row[FIELD_KEY_OF['post.likes']]);
    const comments = parseHumanCount(row[FIELD_KEY_OF['post.comments']]);
    if (views !== undefined) metrics.views = views;
    if (likes !== undefined) metrics.likes = likes;
    if (comments !== undefined) metrics.comments = comments;
    const at = parseLooseDate(row[FIELD_KEY_OF['post.publishedAt']], now);
    posts.push({
      platformItemId: id,
      title: String(row[FIELD_KEY_OF['post.title']] ?? '').trim().slice(0, 300),
      ...(/^https?:\/\//.test(url) ? { url: url.slice(0, 500) } : {}),
      ...(at ? { publishedAt: at.toISOString() } : {}),
      metrics,
    });
    if (posts.length >= 50) break; // 与 ingestPayloadSchema 的 posts.max(50) 对齐
  }
  return { posts, skipped };
}

export type PlatformRecipeIngestResult =
  | { ok: true; posts: number; skipped: number; competitor: string }
  | { ok: false; posts: 0; skipped: number; reason: string };

/**
 * 一次配方抓取的落库出口。**只补已订阅竞对**（autoSubscribe:false）：配方采集不建档、不订阅，
 * 这条路的输入是模型学出来的规则，不该有权在全局共享表里造新账号。
 */
export async function ingestPlatformRecipeRows(input: {
  workspaceId: string;
  platformKey: string;
  url: string;
  values: Record<string, string>;
  rows: Record<string, string>[];
  /** 插件打开的是哪条竞对的主页（BrowserTask / 批量采集里都知道）。有它就不必从 URL 反推 handle */
  competitorId?: string | null;
  /** 谁采的：插件 / 桌面客户端 / 本机浏览器。只进采集台账 */
  channel?: Extract<CollectionChannel, 'plugin_recipe' | 'desktop' | 'local_browser'>;
  now?: Date;
}): Promise<PlatformRecipeIngestResult> {
  const { workspaceId, platformKey, url, values, rows } = input;
  if (!isRecipePlatform(platformKey)) return { ok: false, posts: 0, skipped: 0, reason: '不是内置平台配方' };

  let handle: string | null = null;
  if (input.competitorId) {
    const watch = await prisma.watchlistItem.findFirst({
      where: { workspaceId, competitorId: input.competitorId },
      select: { competitor: { select: { platform: true, handle: true } } },
    });
    if (!watch?.competitor) return { ok: false, posts: 0, skipped: 0, reason: '这条竞对不在本工作区的订阅清单里' };
    if (watch.competitor.platform !== platformKey) return { ok: false, posts: 0, skipped: 0, reason: '竞对的平台与配方的平台对不上' };
    handle = watch.competitor.handle;
  } else {
    const parsed = parseCompetitorUrl(url);
    if (!parsed || parsed.platform !== platformKey) return { ok: false, posts: 0, skipped: 0, reason: '从网址认不出这是哪条竞对的主页' };
    handle = parsed.handle;
  }

  const { posts, skipped } = rowsToPosts(platformKey, rows, input.now);
  const followers = parseHumanCount(values[FIELD_KEY_OF.followers]);
  const name = String(values[FIELD_KEY_OF.name] ?? '').trim().slice(0, 100);
  if (posts.length === 0 && followers === undefined && !name) {
    return { ok: false, posts: 0, skipped, reason: '这一页一条能入库的作品都没有（作品链接里抠不出作品 ID）' };
  }
  const payload = ingestPayloadSchema.safeParse({
    platform: platformKey, handle, autoSubscribe: false,
    profile: { ...(name ? { name } : {}), ...(followers !== undefined ? { followers } : {}) },
    posts,
  });
  if (!payload.success) return { ok: false, posts: 0, skipped, reason: `映射出的数据不合法：${payload.error.issues[0]?.message ?? ''}` };
  const r = await ingestCompetitorData(workspaceId, payload.data, { channel: input.channel ?? 'plugin_recipe' });
  if (!r.ok) return { ok: false, posts: 0, skipped, reason: r.error };
  return { ok: true, posts: r.posts, skipped, competitor: r.competitor };
}

export type PlatformRecipeOwnIngestResult =
  | { ok: true; posts: number; skipped: number; followers?: number; account: { id: string; name: string } }
  | { ok: false; posts: 0; skipped: number; reason: string };

/**
 * 配方行 → **自己的**作品（2026-09-16，collect_self_recipe）。微博/快手/知乎/头条/百家号的用户自有账号
 * 与竞对是同一张公开主页、同一份配方；区别只在落库出口：进自有作品（ownPostIngestData，按 platformItemId
 * 对齐已登记的发布记录）而不是竞对库，粉丝数进账号日报。
 *
 * 【归属只认 accountId，不从网址反推】这一页是服务端/插件按这个账号的 handle 拼出地址打开的
 * （微博 /n/昵称 会 302 到 /u/数字 id，反推出来的 handle 与库里存的对不上）；账号必须属于本工作区且平台相符。
 */
export async function ingestPlatformRecipeRowsAsOwn(input: {
  workspaceId: string;
  platformKey: string;
  values: Record<string, string>;
  rows: Record<string, string>[];
  accountId: string;
  channel: Extract<CollectionChannel, 'plugin_home' | 'desktop' | 'local_browser'>;
  now?: Date;
}): Promise<PlatformRecipeOwnIngestResult> {
  const { workspaceId, platformKey, values, rows, accountId } = input;
  if (!isRecipePlatform(platformKey)) return { ok: false, posts: 0, skipped: 0, reason: '不是内置平台配方' };
  const account = await prisma.creatorAccount.findFirst({
    where: { id: accountId, workspaceId, status: 'active' },
    select: { id: true, name: true, platform: true },
  });
  if (!account) return { ok: false, posts: 0, skipped: 0, reason: '这个账号不在本工作区里' };
  if (account.platform !== platformKey) return { ok: false, posts: 0, skipped: 0, reason: '账号的平台与配方的平台对不上' };

  const { posts, skipped } = rowsToPosts(platformKey, rows, input.now);
  const followers = parseHumanCount(values[FIELD_KEY_OF.followers]);
  if (posts.length === 0 && followers === undefined) {
    return { ok: false, posts: 0, skipped, reason: '这一页一条能入库的作品都没有（作品链接里抠不出作品 ID），粉丝数也没读到' };
  }
  let saved = 0;
  if (posts.length > 0) {
    const parsed = ownPostIngestSchema.safeParse({
      platform: platformKey, handle: 'self', accountId: account.id, channel: input.channel,
      posts: posts.map((p) => ({
        platformItemId: p.platformItemId, title: p.title, url: p.url,
        ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}),
        metrics: p.metrics,
      })),
    });
    if (!parsed.success) return { ok: false, posts: 0, skipped, reason: `映射出的数据不合法：${parsed.error.issues[0]?.message ?? ''}` };
    const r = await ingestOwnPostData(workspaceId, parsed.data);
    if (!r.ok) return { ok: false, posts: 0, skipped, reason: r.error };
    saved = r.created + r.updated;
  }
  if (followers !== undefined) {
    const acc = ownAccountIngestSchema.safeParse({ platform: platformKey, accountId: account.id, dailyStats: [{ date: beijingDayKey(), followers }] });
    if (acc.success) await ingestOwnAccountData(account.id, acc.data).catch(() => { /* 粉丝数写不进不影响作品已入库 */ });
  }
  return { ok: true, posts: saved, skipped, ...(followers !== undefined ? { followers } : {}), account: { id: account.id, name: account.name } };
}
