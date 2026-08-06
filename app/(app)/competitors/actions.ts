'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { crawlCompetitors, crawlOneCompetitor } from '@/lib/pipeline';
import { PLATFORMS, platformName } from '@/lib/constants';
import { parseCompetitorUrl } from '@/lib/competitor-url';
import { requireRole } from '@/lib/rbac';
import { ingestPayloadSchema, ingestCompetitorData, PLUGIN_COLLECTABLE } from '@/lib/ingest/competitor';
import type { ParsedWechatPost } from '@/lib/ingest/wechat-export';

// 竞对监控页专用：按当前工作区订阅的对标账号，拉取最新作品并回写指标。
export async function actCrawlCompetitors() {
  const s = await getSession();
  requireRole(s, 'competitor.manage'); // 触发采集要写库、耗采集配额
  const r = await crawlCompetitors(s.workspaceId, 'manual');
  revalidatePath('/competitors');
  return r;
}

// 自定义添加对标账号：全局竞对表 upsert（同一竞对多租户只采一次）+ 本工作区订阅 + 立即试采一次
export async function actAddCompetitor(
  platform: string,
  handle: string,
  name: string,
  label?: string,
): Promise<{
  ok: boolean;
  posts?: number;
  degraded?: boolean;
  /** 订阅之前该竞对名下已有的作品数（别人采过的——竞对档案全局共享） */
  inheritedPosts?: number;
  lastCrawledAt?: string | null;
  pluginOnly?: boolean;
  platform?: string;
  error?: string;
}> {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  let cleanHandle = handle.trim();
  let cleanPlatform = platform;

  // 容错：用户把整条主页链接粘进了「账号ID」框（而非上方的粘链接框）→ 自动解析出真实 handle+平台。
  // 否则会把整条 URL（含 xsec_token）当成 handle 存进去，主页地址拼成双重嵌套的坏链接、打不开。
  if (/https?:\/\//i.test(cleanHandle) || /\.(com|cn|tv)\//.test(cleanHandle)) {
    const parsed = parseCompetitorUrl(cleanHandle);
    if (parsed) {
      cleanHandle = parsed.handle;
      cleanPlatform = parsed.platform;
    }
  }
  // 兜底校验：解析后仍像 URL / 含协议或域名，说明是不支持的链接，别把脏值写库
  if (/https?:\/\//i.test(cleanHandle) || cleanHandle.includes('/') || cleanHandle.length > 128) {
    return { ok: false, error: '账号 ID 不合法——请粘贴主页链接自动识别，或只填纯账号 ID' };
  }

  const cleanName = name.trim() || cleanHandle;
  if (!cleanHandle) return { ok: false, error: '请填写账号 ID/handle' };
  if (!(cleanPlatform in PLATFORMS)) return { ok: false, error: '平台不合法' };

  const competitor = await prisma.competitorAccount.upsert({
    where: { platform_handle: { platform: cleanPlatform, handle: cleanHandle } },
    create: { platform: cleanPlatform, handle: cleanHandle, name: cleanName },
    update: {}, // 已存在则复用全局记录（不覆盖他人命名）
  });
  await prisma.watchlistItem.upsert({
    where: { workspaceId_competitorId: { workspaceId: s.workspaceId, competitorId: competitor.id } },
    create: { workspaceId: s.workspaceId, competitorId: competitor.id, label: label?.trim() || null },
    update: { label: label?.trim() || null },
  });

  // 这个竞对**在你订阅之前**就已经有的作品数。
  //
  // 竞对档案是全局共享表（CompetitorAccount/CrawledPost 都不带工作区，RLS 也特意没盖，
  // 见 prisma/postgres/02-rls.sql），别人采过的文章你一订阅就看得到。不数这一下，
  // 页面就会对着一个已经有 40 篇的号说「请去采集」——用户照做只是白白消耗自己公众号后台的
  // 频率预算，换回零条新数据。必须在试采**之前**数，否则分不清「本来就有」和「刚采到」。
  const inheritedPosts = await prisma.crawledPost.count({ where: { competitorId: competitor.id } });

  // 立即试采一次。没有服务端通道时 crawlOneCompetitor 会返回 0 条（Mock 不再落库，
  // 见 lib/pipeline.ts 里的 isMock 闸），所以这里要如实告诉用户「去哪儿采」，
  // 而不是沿用旧话术说「展示示例数据」——现在一条示例都不会写进去了。
  let posts = 0;
  let degraded = false;
  try {
    const r = await crawlOneCompetitor(competitor.id, { workspaceId: s.workspaceId, channel: 'manual' });
    posts = r.posts;
    degraded = r.degraded;
  } catch {
    degraded = true;
  }

  revalidatePath('/competitors');
  return {
    ok: true,
    posts,
    degraded,
    inheritedPosts,
    lastCrawledAt: competitor.lastCrawledAt ? competitor.lastCrawledAt.toISOString() : null,
    pluginOnly: PLUGIN_COLLECTABLE.has(cleanPlatform),
    platform: cleanPlatform,
  };
}

// 公众号文章导入（wechat-article-exporter 导出文件 → 竞对作品库）。
//
// 为什么单独开一条：公众号是插件采不到的平台（无公开网页主页），这条通道把它补上。
// 只导内容不导指标——解析层已丢弃阅读/在看（见 lib/ingest/wechat-export.ts 的合规边界）。
//
// 分批由客户端驱动（每批 ≤50，与 HTTP 入口的 ingestPayloadSchema 上限一致），
// 一批一个 action：几百篇的文件不会撑爆 server action 的 body 上限，中途失败也只丢一批。
export async function actImportWechatArticles(
  competitorId: string,
  posts: ParsedWechatPost[],
): Promise<{ ok: boolean; imported?: number; competitor?: string; error?: string }> {
  const s = await getSession();
  requireRole(s, 'competitor.manage');

  if (!Array.isArray(posts) || posts.length === 0) return { ok: false, error: '没有可导入的文章' };
  if (posts.length > 50) return { ok: false, error: '单批最多 50 篇' };

  // 归属闸：只认本工作区已订阅的竞对，且平台必须是公众号。
  // 选错账号的代价不是报错而是「静默入错库」——数据页全按账号过滤，导到别的号名下＝页面里
  // 彻底看不见，还污染那个号的基线（2026-07-25 真机事故：公众号数据挂到抖音账号）。
  const watch = await prisma.watchlistItem.findFirst({
    where: { workspaceId: s.workspaceId, competitorId },
    include: { competitor: { select: { platform: true, handle: true, name: true } } },
  });
  if (!watch) return { ok: false, error: '本工作区未订阅该竞对——请先在上方添加' };
  if (watch.competitor.platform !== 'wechat') {
    return { ok: false, error: `导入目标必须是公众号账号（当前选中的是${platformName(watch.competitor.platform)}）` };
  }

  // 走与插件回传同一套 zod 校验 + 同一个入库函数：数据移除申请闸、订阅关系闸、
  // 「无 metrics 不覆盖已有指标」的约定全都自动继承，不另起一套。
  const parsed = ingestPayloadSchema.safeParse({
    platform: 'wechat',
    handle: watch.competitor.handle,
    autoSubscribe: false, // 已确认订阅关系，这里不需要也不应该建档
    posts,
  });
  if (!parsed.success) return { ok: false, error: `数据格式不合法：${parsed.error.issues[0]?.message ?? ''}` };

  const r = await ingestCompetitorData(s.workspaceId, parsed.data, { channel: 'import' });
  if (!r.ok) return { ok: false, error: r.error };

  revalidatePath('/competitors');
  return { ok: true, imported: r.posts, competitor: r.competitor };
}

// 取消订阅（只删本工作区的订阅关系，不删全局竞对与作品数据）
export async function actRemoveWatch(watchItemId: string) {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  await prisma.watchlistItem.deleteMany({ where: { id: watchItemId, workspaceId: s.workspaceId } });
  revalidatePath('/competitors');
  return { ok: true };
}
