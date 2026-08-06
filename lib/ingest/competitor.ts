import { z } from 'zod';
import { prisma } from '../db';
import { automationAllows } from '../jobs/automation';
import { toJson, parseJson } from '../json';
import { PLATFORMS } from '../constants';
import { competitorHomeUrl } from '../competitor-url';
import { isRemovalRequested } from '../legal/removal';
import { recordCollectionRun, type CollectionChannel } from './collection-run';
import { resolveIngestToken } from './token';

export const INGEST_TOKEN_HEADER = 'x-beacon-ingest-token';

// 令牌的签发/吊销/解析都在 lib/ingest/token.ts。这里只保留 7 条 ingest 路由用的这个入口名，
// 免得为了「按设备签发」这一件事去改七个路由文件——它们要的一直只是「这串令牌属于哪个工作区」。
export { generateIngestToken } from './token';

export async function workspaceByIngestToken(token: string | null | undefined) {
  const r = await resolveIngestToken(token);
  return r ? r.workspace : null;
}

// 插件能采的平台。wechat 与其它五个不同：公众号没有公开主页，插件不是「打开竞对主页顺手采」，
// 而是开**用户自己**的公众号后台、用当前登录态调接口拿公开图文列表
//（extension/content/wechat-competitor.js）。所以它的 competitorHomeUrl 是 null 却仍然可采——
// 消费方按 url 判断可采性会把它漏掉，一律以本集合为准。
export const PLUGIN_COLLECTABLE = new Set(['bilibili', 'douyin', 'xiaohongshu', 'x', 'youtube', 'wechat', 'tiktok']);

export { competitorHomeUrl };

export async function listSubscribedCompetitors(workspaceId: string) {
  const items = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    orderBy: { addedAt: 'asc' },
    select: { competitor: { select: { platform: true, handle: true, name: true, lastCrawledAt: true } } },
  });
  return items.map(({ competitor: c }) => ({
    platform: c.platform,
    handle: c.handle,
    name: c.name,
    lastCrawledAt: c.lastCrawledAt ? c.lastCrawledAt.toISOString() : null,
    collectable: PLUGIN_COLLECTABLE.has(c.platform),
    url: competitorHomeUrl(c.platform, c.handle),
  }));
}

// 见 lib/ingest/own-post.ts readCount：Number(null)/Number('') 皆为 0 且能过 isFinite 闸，
// 会把「这次没采到」写成「这次是 0」，进而覆盖已有真实值。只认数字/非空数字串。
function readCount(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  }
  return undefined;
}

const metricsSchema = z
  .record(z.string(), z.unknown())
  .transform((raw) => {
    const out: Record<string, number> = {};
    for (const k of ['views', 'likes', 'comments', 'shares', 'collects', 'danmaku', 'coins'] as const) {
      const n = readCount(raw[k]);
      if (n !== undefined) out[k] = n;
    }
    return out;
  });

const postSchema = z.object({
  platformItemId: z.string().min(1).max(128),
  title: z.string().max(300).default(''),
  summary: z.string().max(500).optional(),
  url: z.string().url().max(500).optional(),
  publishedAt: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v == null) return undefined;
      const d = typeof v === 'number' ? new Date(v * (v < 1e12 ? 1000 : 1)) : new Date(v);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }),
  metrics: metricsSchema.optional(),
});

export const ingestPayloadSchema = z.object({
  platform: z.string().refine((p) => p in PLATFORMS, { message: '未知平台' }),
  handle: z.string().min(1).max(128),
  autoSubscribe: z.boolean().optional().default(true),
  profile: z
    .object({
      name: z.string().max(100).optional(),
      followers: z.number().int().min(0).max(2_000_000_000).optional(),
      avatar: z.string().url().max(500).optional(),
      bio: z.string().max(300).optional(),
    })
    .optional(),
  posts: z.array(postSchema).max(50).default([]),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

export type IngestResult =
  | { ok: true; competitor: string; posts: number; withMetrics: number; profileUpdated: boolean; newlySubscribed?: boolean }
  | { ok: false; error: string; code: 'not_found' | 'not_subscribed' };

/**
 * 公众号没有公开主页，插件是在**用户自己的后台**里采的；其余平台是在公开主页上采的。
 * 通道决定台账里那句「这批是怎么来的」，也决定它受哪套频率约束——调用方没表态时按平台推断，
 * 别让台账里出现「不知道哪来的」这一类。
 */
export function defaultChannelFor(platform: string): CollectionChannel {
  return platform === 'wechat' ? 'plugin_backend' : 'plugin_home';
}

export async function ingestCompetitorData(
  workspaceId: string,
  payload: IngestPayload,
  opts: { channel?: CollectionChannel } = {},
): Promise<IngestResult> {
  // 数据移除申请执行闸（PIPL 拒绝权）：被申请移除的账号一律不再入库。
  // 定时抓取通道（lib/pipeline.ts crawlOneCompetitor）有同一道闸——
  // 两条通道都要挡，否则插件这条路就是绕过退出权的后门。
  if (await isRemovalRequested(payload.platform, payload.handle)) {
    return {
      ok: false,
      error: '该账号已提交数据移除申请，按《个人信息保护法》的拒绝权已停止采集',
      code: 'not_found',
    };
  }

  let competitor = await prisma.competitorAccount.findUnique({
    where: { platform_handle: { platform: payload.platform, handle: payload.handle } },
  });

  // autoSubscribe 是插件众包采集的开关：开＝允许「边逛边建档」，把用户正在浏览的号直接收进本工作区；
  // 关＝退回两道守卫（不在库 not_found、本工作区未订阅 not_subscribed），只准补充已订阅对象的公开数据。
  //
  // 判据刻意用 `=== true`（缺省即关）而不是 `!== false`：竞对档案是全局共享表，写它要显式授权。
  // HTTP 入口不受影响——zod 的 `.default(true)` 会把缺省填成 true，插件三个入口也都显式传 true；
  // 收紧的只是「代码里直接调这个函数却没表态」的路径，那种情况按 fail-closed 处理。
  //
  // 2026-07-30 追加**工作区级开关**（settings → 自动化 → 插件边逛边建档，默认开）：
  // 请求说要建档 ≠ 这个工作区允许建档。谁都能拿采集令牌调这个接口，
  // 而「浏览即写入全局共享表」是管理员该能一键关掉的产品语义，不该只活在 zod 的默认值里。
  // 两者取**与**：请求要开 且 工作区允许，才真的建档/订阅。
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { automationConfig: true } });
  const autoSubscribe = payload.autoSubscribe === true && automationAllows(ws?.automationConfig, 'pluginAutoSubscribe');

  let newlyCreated = false;
  if (!competitor) {
    if (!autoSubscribe) {
      return { ok: false, error: '该竞对不在库中——请先在竞对监控页添加，或开启插件的自动建档', code: 'not_found' };
    }
    competitor = await prisma.competitorAccount.create({
      data: {
        platform: payload.platform,
        handle: payload.handle,
        name: payload.profile?.name || payload.handle,
        followers: payload.profile?.followers ?? 0,
        avatar: payload.profile?.avatar,
        bio: payload.profile?.bio,
        lastCrawledAt: new Date(),
      },
    });
    newlyCreated = true;
  }

  let watch = await prisma.watchlistItem.findUnique({
    where: { workspaceId_competitorId: { workspaceId, competitorId: competitor.id } },
  });

  let newlySubscribed = false;
  if (!watch) {
    if (!autoSubscribe) {
      // 竞对档案是全局共享表：未订阅方不得改写别人的档案（跨租户数据污染闸）
      return { ok: false, error: '本工作区未订阅该竞对——请先在竞对监控页订阅，或开启插件的自动订阅', code: 'not_subscribed' };
    }
    watch = await prisma.watchlistItem.create({
      data: { workspaceId, competitorId: competitor.id },
    });
    newlySubscribed = true;
  }

  const p = payload.profile;
  const profileData: Record<string, unknown> = {};
  if (p?.name) profileData.name = p.name;
  if (p?.followers != null) profileData.followers = p.followers;
  if (p?.avatar) profileData.avatar = p.avatar;
  if (p?.bio) profileData.bio = p.bio;
  const profileUpdated = Object.keys(profileData).length > 0;
  await prisma.competitorAccount.update({
    where: { id: competitor.id },
    data: { ...profileData, lastCrawledAt: new Date() },
  });

  let posts = 0;
  let withMetrics = 0;
  let created = 0;
  let updated = 0;
  for (const post of payload.posts) {
    const metrics = post.metrics && Object.keys(post.metrics).length > 0 ? post.metrics : undefined;
    const views = metrics?.views ?? 0;
    const hotScore = Math.round((views / 20000) * 10) / 10;
    const existing = await prisma.crawledPost.findUnique({
      where: { platform_platformItemId: { platform: payload.platform, platformItemId: post.platformItemId } },
      select: { id: true, metrics: true },
    });
    if (existing) {
      if (metrics) {
        const prev = parseJson<Record<string, number>>(existing.metrics, {});
        if (toJson(prev) !== toJson(metrics)) {
          await prisma.postMetricSnapshot.create({ data: { postId: existing.id, metrics: toJson(metrics) } });
        }
        await prisma.crawledPost.update({ where: { id: existing.id }, data: { metrics: toJson(metrics), hotScore } });
      }
      updated++;
    } else {
      await prisma.crawledPost.create({
        data: {
          competitorId: competitor.id,
          platform: payload.platform,
          platformItemId: post.platformItemId,
          title: post.title || '(无标题)',
          summary: post.summary,
          url: post.url,
          publishedAt: post.publishedAt,
          metrics: toJson(metrics ?? {}),
          hotScore,
        },
      });
      created++;
    }
    posts++;
    if (metrics) withMetrics++;
  }

  // 台账：这一批覆盖的发布时间区间。取不到 publishedAt 的通道（部分主页只给标题+指标）
  // 会留空区间——那本身就是要如实呈现的事实，不能拿采集时间冒充发布时间。
  await recordCollectionRun({
    workspaceId,
    scope: 'rival',
    platform: payload.platform,
    targetId: competitor.id,
    targetName: competitor.name,
    channel: opts.channel ?? defaultChannelFor(payload.platform),
    dates: payload.posts.map((p) => p.publishedAt ?? null),
    items: posts,
    created,
    updated,
    note: posts === 0 ? '本次没有回传任何作品' : null,
  });

  return {
    ok: true,
    competitor: competitor.name,
    posts,
    withMetrics,
    profileUpdated,
    newlySubscribed: newlyCreated || newlySubscribed,
  };
}
